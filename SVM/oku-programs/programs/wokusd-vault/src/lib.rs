use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{self, Mint as MintInterface, TokenAccount as TokenAccountInterface},
};

pub mod errors;
pub mod state;

use errors::VaultError;
use state::VaultConfig;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod wokusd_vault {
    use super::*;

    /// Initialize the vault
    /// Creates config PDA and wOkuUSD mint (mint authority = config PDA)
    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.bump = ctx.bumps.config;

        // Set all granular authorities
        config.role_admin = ctx.accounts.role_admin.key();
        config.pauser = ctx.accounts.pauser.key();
        config.unpauser = ctx.accounts.unpauser.key();

        // Set token references
        config.okusd_mint = ctx.accounts.okusd_mint.key();
        config.wokusd_mint = ctx.accounts.wokusd_mint.key();
        config.vault_okusd = ctx.accounts.vault_okusd.key();

        config.total_shares = 0;
        config.is_paused = false;

        emit!(InitializeEvent {
            role_admin: config.role_admin,
            okusd_mint: config.okusd_mint,
            wokusd_mint: config.wokusd_mint,
        });

        Ok(())
    }

    /// Wrap OkuUSD -> wOkuUSD
    /// Transfers OkuUSD from user to vault, mints wOkuUSD shares to user
    pub fn wrap(ctx: Context<Wrap>, okusd_amount: u64) -> Result<()> {
        // Read state first (immutable borrows)
        let is_paused = ctx.accounts.config.is_paused;
        let total_shares = ctx.accounts.config.total_shares;
        let bump = ctx.accounts.config.bump;
        let vault_balance = ctx.accounts.vault_okusd.amount;
        let decimals = ctx.accounts.okusd_mint.decimals;

        require!(!is_paused, VaultError::Paused);
        require!(okusd_amount > 0, VaultError::ZeroAmount);

        // Calculate shares to mint
        // First deposit: 1:1 ratio
        // Subsequent: shares = okusd_amount * total_shares / vault_balance
        let shares = if total_shares == 0 {
            okusd_amount
        } else {
            okusd_amount
                .checked_mul(total_shares)
                .ok_or(VaultError::Overflow)?
                .checked_div(vault_balance)
                .ok_or(VaultError::Overflow)?
        };

        require!(shares > 0, VaultError::ZeroAmount);

        // Transfer OkuUSD from user to vault (Token-2022)
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_2022_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.user_okusd_ata.to_account_info(),
                    to: ctx.accounts.vault_okusd.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                    mint: ctx.accounts.okusd_mint.to_account_info(),
                },
            ),
            okusd_amount,
            decimals,
        )?;

        // Mint wOkuUSD shares to user (standard SPL)
        let seeds = &[VaultConfig::SEED, &[bump]];
        let signer = &[&seeds[..]];

        anchor_spl::token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::MintTo {
                    mint: ctx.accounts.wokusd_mint.to_account_info(),
                    to: ctx.accounts.user_wokusd_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                signer,
            ),
            shares,
        )?;

        // Update total shares (mutable borrow now)
        let config = &mut ctx.accounts.config;
        config.total_shares = total_shares
            .checked_add(shares)
            .ok_or(VaultError::Overflow)?;

        emit!(WrapEvent {
            user: ctx.accounts.user.key(),
            okusd_amount,
            shares_minted: shares,
        });

        Ok(())
    }

    /// Unwrap wOkuUSD -> OkuUSD
    /// Burns wOkuUSD shares from user, transfers OkuUSD from vault to user
    /// NOTE: Unwrap always allowed even when paused - users must always be able to exit
    pub fn unwrap(ctx: Context<Unwrap>, shares: u64) -> Result<()> {
        // Read state first (immutable borrows)
        let total_shares = ctx.accounts.config.total_shares;
        let bump = ctx.accounts.config.bump;
        let vault_balance = ctx.accounts.vault_okusd.amount;
        let decimals = ctx.accounts.okusd_mint.decimals;

        require!(shares > 0, VaultError::ZeroAmount);
        require!(shares <= total_shares, VaultError::InsufficientShares);

        // Calculate OkuUSD to return
        // okusd_out = shares * vault_balance / total_shares
        let okusd_out = shares
            .checked_mul(vault_balance)
            .ok_or(VaultError::Overflow)?
            .checked_div(total_shares)
            .ok_or(VaultError::Overflow)?;

        require!(okusd_out > 0, VaultError::ZeroAmount);

        // Burn wOkuUSD shares from user (standard SPL)
        anchor_spl::token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token::Burn {
                    mint: ctx.accounts.wokusd_mint.to_account_info(),
                    from: ctx.accounts.user_wokusd_ata.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            shares,
        )?;

        // Transfer OkuUSD from vault to user (Token-2022)
        let seeds = &[VaultConfig::SEED, &[bump]];
        let signer = &[&seeds[..]];

        token_interface::transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_2022_program.to_account_info(),
                token_interface::TransferChecked {
                    from: ctx.accounts.vault_okusd.to_account_info(),
                    to: ctx.accounts.user_okusd_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                    mint: ctx.accounts.okusd_mint.to_account_info(),
                },
                signer,
            ),
            okusd_out,
            decimals,
        )?;

        // Update total shares (mutable borrow now)
        let config = &mut ctx.accounts.config;
        config.total_shares = total_shares
            .checked_sub(shares)
            .ok_or(VaultError::Overflow)?;

        emit!(UnwrapEvent {
            user: ctx.accounts.user.key(),
            shares_burned: shares,
            okusd_amount: okusd_out,
        });

        Ok(())
    }

    /// Pause the vault (emergency response)
    pub fn pause(ctx: Context<Pause>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.is_paused = true;

        emit!(PauseEvent {
            role_admin: ctx.accounts.pauser.key(),
            paused: true,
        });

        Ok(())
    }

    /// Unpause the vault (deliberate review required)
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
        role: AuthorityRole,
        new_authority: Pubkey,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;
        let old_authority = match role {
            AuthorityRole::RoleAdmin => {
                let old = config.role_admin;
                config.role_admin = new_authority;
                old
            }
            AuthorityRole::Pauser => {
                let old = config.pauser;
                config.pauser = new_authority;
                old
            }
            AuthorityRole::Unpauser => {
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
pub enum AuthorityRole {
    RoleAdmin,
    Pauser,
    Unpauser,
}

// ============================================================================
// Instruction Accounts
// ============================================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub role_admin: Signer<'info>,

    // ===== Granular Authority Accounts =====
    /// CHECK: Authority pubkey for role assignment
    pub pauser: UncheckedAccount<'info>,
    /// CHECK: Authority pubkey for role assignment
    pub unpauser: UncheckedAccount<'info>,

    #[account(
        init,
        payer = role_admin,
        space = VaultConfig::LEN,
        seeds = [VaultConfig::SEED],
        bump
    )]
    pub config: Account<'info, VaultConfig>,

    /// OkuUSD mint (Token-2022 with Interest-Bearing extension)
    #[account(
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// wOkuUSD mint (standard SPL Token)
    /// Mint authority must be the config PDA
    #[account(
        init,
        payer = role_admin,
        mint::decimals = okusd_mint.decimals,
        mint::authority = config,
        mint::token_program = token_program,
    )]
    pub wokusd_mint: Account<'info, Mint>,

    /// Vault's OkuUSD token account
    #[account(
        init,
        payer = role_admin,
        associated_token::mint = okusd_mint,
        associated_token::authority = config,
        associated_token::token_program = token_2022_program,
    )]
    pub vault_okusd: InterfaceAccount<'info, TokenAccountInterface>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct Wrap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VaultConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, VaultConfig>,

    /// OkuUSD mint (Token-2022)
    #[account(
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// wOkuUSD mint (standard SPL)
    #[account(
        mut,
        address = config.wokusd_mint
    )]
    pub wokusd_mint: Account<'info, Mint>,

    /// User's OkuUSD token account
    #[account(
        mut,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>,

    /// User's wOkuUSD token account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = wokusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_wokusd_ata: Account<'info, TokenAccount>,

    /// Vault's OkuUSD token account
    #[account(
        mut,
        address = config.vault_okusd
    )]
    pub vault_okusd: InterfaceAccount<'info, TokenAccountInterface>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Unwrap<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [VaultConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, VaultConfig>,

    /// OkuUSD mint (Token-2022)
    #[account(
        address = config.okusd_mint,
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: InterfaceAccount<'info, MintInterface>,

    /// wOkuUSD mint (standard SPL)
    #[account(
        mut,
        address = config.wokusd_mint
    )]
    pub wokusd_mint: Account<'info, Mint>,

    /// User's OkuUSD token account
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: InterfaceAccount<'info, TokenAccountInterface>,

    /// User's wOkuUSD token account
    #[account(
        mut,
        associated_token::mint = wokusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_wokusd_ata: Account<'info, TokenAccount>,

    /// Vault's OkuUSD token account
    #[account(
        mut,
        address = config.vault_okusd
    )]
    pub vault_okusd: InterfaceAccount<'info, TokenAccountInterface>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Pause<'info> {
    #[account(
        constraint = pauser.key() == config.pauser @ VaultError::Unauthorized
    )]
    pub pauser: Signer<'info>,

    #[account(
        mut,
        seeds = [VaultConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
pub struct Unpause<'info> {
    #[account(
        constraint = unpauser.key() == config.unpauser @ VaultError::Unauthorized
    )]
    pub unpauser: Signer<'info>,

    #[account(
        mut,
        seeds = [VaultConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, VaultConfig>,
}

#[derive(Accounts)]
pub struct SetAuthority<'info> {
    /// Role admin - only role_admin can update authorities
    #[account(
        constraint = role_admin.key() == config.role_admin @ VaultError::Unauthorized
    )]
    pub role_admin: Signer<'info>,

    /// Vault config
    #[account(
        mut,
        seeds = [VaultConfig::SEED],
        bump = config.bump
    )]
    pub config: Account<'info, VaultConfig>,
}

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct InitializeEvent {
    pub role_admin: Pubkey,
    pub okusd_mint: Pubkey,
    pub wokusd_mint: Pubkey,
}

#[event]
pub struct WrapEvent {
    pub user: Pubkey,
    pub okusd_amount: u64,
    pub shares_minted: u64,
}

#[event]
pub struct UnwrapEvent {
    pub user: Pubkey,
    pub shares_burned: u64,
    pub okusd_amount: u64,
}

#[event]
pub struct PauseEvent {
    pub role_admin: Pubkey,
    pub paused: bool,
}

#[event]
pub struct UnpauseEvent {
    pub unpauser: Pubkey,
}

#[event]
pub struct AuthorityUpdatedEvent {
    pub role: AuthorityRole,
    pub old_authority: Pubkey,
    pub new_authority: Pubkey,
}
