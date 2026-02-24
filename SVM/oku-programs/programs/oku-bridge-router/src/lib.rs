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
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.bump = ctx.bumps.config;
        config.admin = ctx.accounts.admin.key();
        config.psm_program = ctx.accounts.psm_program.key();
        config.vault_program = ctx.accounts.vault_program.key();
        config.is_paused = false;

        emit!(InitializeEvent {
            admin: config.admin,
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

        // Step 2: Bridge burn OkuUSD via PSM CPI
        // Reload the user's OkuUSD ATA to get updated balance after unwrap
        ctx.accounts.user_okusd_ata.reload()?;
        let okusd_balance = ctx.accounts.user_okusd_ata.amount;

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
        lite_psm::cpi::bridge_burn(bridge_burn_cpi_ctx, okusd_balance, recipient, destination_chain)?;

        emit!(BridgeWrappedEvent {
            user: ctx.accounts.user.key(),
            wokusd_shares,
            okusd_amount: okusd_balance,
            destination_chain,
        });

        Ok(())
    }

    /// Pause or unpause the router
    pub fn set_paused(ctx: Context<SetPaused>, paused: bool) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.is_paused = paused;

        emit!(PausedEvent {
            admin: ctx.accounts.admin.key(),
            paused,
        });

        Ok(())
    }
}

// ============================================================================
// State
// ============================================================================

/// Router configuration PDA
#[account]
pub struct RouterConfig {
    /// PDA bump seed
    pub bump: u8,
    /// Admin authority
    pub admin: Pubkey,
    /// LitePSM program ID
    pub psm_program: Pubkey,
    /// wOkuUSD vault program ID
    pub vault_program: Pubkey,
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
}

// ============================================================================
// Accounts
// ============================================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = RouterConfig::LEN,
        seeds = [RouterConfig::SEED],
        bump
    )]
    pub config: Account<'info, RouterConfig>,

    /// CHECK: PSM program ID - validated by admin
    pub psm_program: UncheckedAccount<'info>,

    /// CHECK: Vault program ID - validated by admin
    pub vault_program: UncheckedAccount<'info>,

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

    /// CHECK: Vault program
    #[account(address = config.vault_program)]
    pub vault_program: UncheckedAccount<'info>,

    /// CHECK: PSM program
    #[account(address = config.psm_program)]
    pub psm_program: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPaused<'info> {
    #[account(
        constraint = admin.key() == config.admin @ RouterError::Unauthorized
    )]
    pub admin: Signer<'info>,

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
    pub admin: Pubkey,
}

#[event]
pub struct BridgeWrappedEvent {
    pub user: Pubkey,
    pub wokusd_shares: u64,
    pub okusd_amount: u64,
    pub destination_chain: u16,
}

#[event]
pub struct PausedEvent {
    pub admin: Pubkey,
    pub paused: bool,
}
