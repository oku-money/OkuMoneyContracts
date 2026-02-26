use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Token, TokenAccount, Mint},
    token_2022::Token2022,
    token_interface::{TokenAccount as TokenAccountInterface, Mint as MintInterface},
};

declare_id!("7DtqfP4fyShjAoM35QC9m3a9Ukh4tqcVgzTNLuyTkgE");

#[program]
pub mod oku_bridge_router {
    use super::*;

    /// Initialize the bridge router config
    /// Takes pauser and unpauser as args; signer becomes role_admin
    pub fn initialize(ctx: Context<Initialize>, pauser: Pubkey, unpauser: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.bump = ctx.bumps.config;
        config.role_admin = ctx.accounts.role_admin.key();
        config.pauser = pauser;
        config.unpauser = unpauser;
        config.is_paused = false;

        emit!(InitializeEvent {
            role_admin: config.role_admin,
        });

        Ok(())
    }

    /// Bridge wOkuUSD cross-chain in one transaction
    /// 1. Unwraps wOkuUSD -> OkuUSD via vault program
    /// 2. Burns OkuUSD via PSM bridge_burn
    pub fn bridge_wrapped(
        ctx: Context<BridgeWrapped>,
        wokusd_shares: u64,
        recipient: [u8; 20],      // EVM address on destination
        destination_chain: u16,
        min_okusd_out: u64,        // Slippage protection
    ) -> Result<()> {
        let is_paused = ctx.accounts.config.is_paused;
        require!(!is_paused, RouterError::Paused);
        require!(wokusd_shares > 0, RouterError::ZeroAmount);

        // Extract AccountInfo from boxed accounts BEFORE any CPI.
        // After a CPI, the BPF runtime may invalidate heap pointers inside
        // Box<InterfaceAccount>, causing access violations in subsequent CPIs.
        let okusd_mint_info = ctx.accounts.okusd_mint.to_account_info();
        let user_okusd_ata_info = ctx.accounts.user_okusd_ata.to_account_info();
        let vault_okusd_info = ctx.accounts.vault_okusd.to_account_info();

        // Snapshot user's OkuUSD balance BEFORE unwrap to compute delta
        let balance_before = ctx.accounts.user_okusd_ata.amount;

        // Step 1: Unwrap wOkuUSD -> OkuUSD via vault program CPI
        let unwrap_cpi_ctx = CpiContext::new(
            ctx.accounts.vault_program.to_account_info(),
            wokusd_vault::cpi::accounts::Unwrap {
                user: ctx.accounts.user.to_account_info(),
                config: ctx.accounts.vault_config.to_account_info(),
                okusd_mint: okusd_mint_info.clone(),
                wokusd_mint: ctx.accounts.wokusd_mint.to_account_info(),
                user_okusd_ata: user_okusd_ata_info.clone(),
                user_wokusd_ata: ctx.accounts.user_wokusd_ata.to_account_info(),
                vault_okusd: vault_okusd_info,
                token_program: ctx.accounts.token_program.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
                associated_token_program: ctx.accounts.associated_token_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        wokusd_vault::cpi::unwrap(unwrap_cpi_ctx, wokusd_shares)?;

        // Step 2: Bridge burn only the OkuUSD received from unwrap (not total balance)
        ctx.accounts.user_okusd_ata.reload()?;
        let okusd_received = ctx.accounts.user_okusd_ata.amount
            .checked_sub(balance_before)
            .ok_or(RouterError::MathError)?;

        // Slippage protection
        require!(okusd_received >= min_okusd_out, RouterError::SlippageExceeded);

        let bridge_burn_cpi_ctx = CpiContext::new(
            ctx.accounts.psm_program.to_account_info(),
            lite_psm::cpi::accounts::BridgeBurn {
                user: ctx.accounts.user.to_account_info(),
                bridge_config: ctx.accounts.bridge_config.to_account_info(),
                config: ctx.accounts.psm_config.to_account_info(),
                bridge_nonce: ctx.accounts.bridge_nonce.to_account_info(),
                okusd_mint: okusd_mint_info,
                user_okusd_ata: user_okusd_ata_info,
                fee_recipient_ata: ctx.accounts.fee_recipient_ata.to_account_info(),
                token_2022_program: ctx.accounts.token_2022_program.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            },
        );
        lite_psm::cpi::bridge_burn(bridge_burn_cpi_ctx, okusd_received, recipient, destination_chain)?;

        emit!(BridgeWrappedEvent {
            user: ctx.accounts.user.key(),
            wokusd_shares,
            okusd_amount: okusd_received,
            destination_chain,
            recipient,
        });

        Ok(())
    }

    /// Pause the router (emergency response)
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.is_paused = true;

        emit!(PauseEvent {
            pauser: ctx.accounts.pauser.key(),
            paused: true,
        });

        Ok(())
    }

    /// Unpause the router (deliberate review required)
    pub fn unpause(ctx: Context<Unpause>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.is_paused = false;

        emit!(UnpauseEvent {
            unpauser: ctx.accounts.unpauser.key(),
        });

        Ok(())
    }

    /// Update a specific authority role
    /// Only role_admin can call this function
    pub fn set_authority(
        ctx: Context<SetAuthority>,
        role: RouterAuthorityRole,
        new_authority: Pubkey,
    ) -> Result<()> {
        require!(new_authority != Pubkey::default(), RouterError::Unauthorized);

        let config = &mut ctx.accounts.config;
        let old_authority = match role {
            RouterAuthorityRole::RoleAdmin => {
                let old = config.role_admin;
                config.role_admin = new_authority;
                old
            }
            RouterAuthorityRole::Pauser => {
                let old = config.pauser;
                config.pauser = new_authority;
                old
            }
            RouterAuthorityRole::Unpauser => {
                let old = config.unpauser;
                config.unpauser = new_authority;
                old
            }
        };

        emit!(AuthorityUpdatedEvent {
            role,
            old_authority,
            new_authority,
        });

        Ok(())
    }
}

/// Authority roles that can be updated via set_authority
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum RouterAuthorityRole {
    RoleAdmin,
    Pauser,
    Unpauser,
}

// ============================================================================
// State
// ============================================================================

/// Router configuration PDA
#[account]
pub struct RouterConfig {
    /// PDA bump seed
    pub bump: u8,
    /// Meta role: grant/revoke roles (cold multisig)
    pub role_admin: Pubkey,
    /// Warm Multisig - pause only
    pub pauser: Pubkey,
    /// Cold Multisig - unpause only
    pub unpauser: Pubkey,
    /// Whether the router is paused
    pub is_paused: bool,
}

impl RouterConfig {
    pub const SEED: &'static [u8] = b"router_config";
    /// Space: 8 (discriminator) + 1 (bump) + 32*3 (pubkeys) + 1 (bool)
    pub const LEN: usize = 8 + 1 + 32 * 3 + 1;
}

// ============================================================================
// Errors
// ============================================================================

#[error_code]
pub enum RouterError {
    #[msg("Caller not authorized")]
    Unauthorized,
    #[msg("Router is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Unexpected balance decrease")]
    MathError,
    #[msg("Slippage tolerance exceeded")]
    SlippageExceeded,
}

// ============================================================================
// Accounts
// ============================================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    #[account(
        init,
        payer = role_admin,
        space = RouterConfig::LEN,
        seeds = [RouterConfig::SEED],
        bump
    )]
    pub config: Account<'info, RouterConfig>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BridgeWrapped<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,

    // Vault program accounts
    /// CHECK: Vault config PDA - validated by vault program CPI
    #[account(mut)]
    pub vault_config: UncheckedAccount<'info>,

    /// OkuUSD mint (Token-2022)
    #[account(mut)]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// wOkuUSD mint (standard SPL)
    #[account(mut)]
    pub wokusd_mint: Account<'info, Mint>,

    /// User's OkuUSD account
    #[account(mut)]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's wOkuUSD account
    #[account(mut)]
    pub user_wokusd_ata: Account<'info, TokenAccount>,

    /// Vault's OkuUSD account
    #[account(mut)]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    // PSM program accounts
    /// CHECK: Bridge config PDA - validated by PSM program CPI
    pub bridge_config: UncheckedAccount<'info>,

    /// CHECK: PSM config PDA - validated by PSM program CPI
    pub psm_config: UncheckedAccount<'info>,

    /// CHECK: Bridge nonce PDA - validated by PSM program CPI
    #[account(mut)]
    pub bridge_nonce: UncheckedAccount<'info>,

    /// CHECK: Fee recipient ATA - validated by PSM program CPI
    #[account(mut)]
    pub fee_recipient_ata: UncheckedAccount<'info>,

    /// CHECK: Vault program — hardcoded to wokusd_vault::ID
    #[account(address = wokusd_vault::ID)]
    pub vault_program: UncheckedAccount<'info>,

    /// CHECK: PSM program — hardcoded to lite_psm::ID
    #[account(address = lite_psm::ID)]
    pub psm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        constraint = pauser.key() == config.pauser @ RouterError::Unauthorized
    )]
    pub pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(
        constraint = unpauser.key() == config.unpauser @ RouterError::Unauthorized
    )]
    pub unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    /// Role admin - only role_admin can update authorities
    #[account(
        constraint = role_admin.key() == config.role_admin @ RouterError::Unauthorized
    )]
    pub role_admin: Signer<'info>,

    /// Router config
    #[account(
        mut,
        seeds = [RouterConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, RouterConfig>,
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct InitializeEvent {
    pub role_admin: Pubkey,
}

#[event]
pub struct BridgeWrappedEvent {
    pub user: Pubkey,
    pub wokusd_shares: u64,
    pub okusd_amount: u64,
    pub destination_chain: u16,
    pub recipient: [u8; 20],
}

#[event]
pub struct PauseEvent {
    pub pauser: Pubkey,
    pub paused: bool,
}

#[event]
pub struct UnpauseEvent {
    pub unpauser: Pubkey,
}

#[event]
pub struct AuthorityUpdatedEvent {
    pub role: RouterAuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
