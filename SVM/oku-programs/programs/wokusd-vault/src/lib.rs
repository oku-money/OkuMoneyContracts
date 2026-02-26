use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
    token_2022::Token2022,
    token_interface::{self, Mint as MintInterface, TokenAccount as TokenAccountInterface},
};
use anchor_spl::token_2022::spl_token_2022::{
    extension::{interest_bearing_mint::InterestBearingConfig, BaseStateWithExtensions, StateWithExtensions},
    state::Mint as SplMint,
};

pub mod errors;
pub mod state;

use errors::VaultError;
use state::VaultConfig;

declare_id!("BjjK75Vxj6zsC49qYfcVYFPLqyXXkcaFzacTXwohmfVC");

/// Dead shares permanently locked in an ATA owned by the System Program.
/// Nobody holds the System Program's private key, so the tokens are unrecoverable.
const MINIMUM_LIQUIDITY: u64 = 1_000_000; // 10^6 = 1 OkuUSD (6 decimals)

/// Seconds per year used by Token-2022's InterestBearing extension (365.24 days).
const SECONDS_PER_YEAR: f64 = 31_556_736.0;

/// Basis points denominator used by Token-2022's InterestBearing extension.
const BPS_DENOMINATOR: f64 = 10_000.0;

/// Compute the interest-adjusted balance for a Token-2022 account with an
/// InterestBearing extension.  Uses the same continuous-compounding formula as
/// Token-2022 so that vault share math matches the balance wallets display:
///
///   adjusted = raw_amount × e^(r1 × t1 / (10000 × 31556736))
///                         × e^(r2 × t2 / (10000 × 31556736))
///
/// where r1 = pre_update_average_rate, t1 = time from init to last rate change,
///       r2 = current_rate, t2 = time from last rate change to now.
///
/// Falls back to `raw_amount` if the mint has no InterestBearing extension.
fn compute_interest_adjusted_balance(
    raw_amount: u64,
    mint_account_info: &AccountInfo,
    unix_timestamp: i64,
) -> Result<u64> {
    if raw_amount == 0 {
        return Ok(0);
    }

    let mint_data = mint_account_info.data.borrow();
    let mint_state = StateWithExtensions::<SplMint>::unpack(&mint_data)
        .map_err(|_| VaultError::InvalidMintExtension)?;

    let interest_config = match mint_state.get_extension::<InterestBearingConfig>() {
        Ok(cfg) => cfg,
        Err(_) => return Ok(raw_amount), // No extension — return raw
    };

    let init_ts = i64::from(interest_config.initialization_timestamp) as f64;
    let last_update_ts = i64::from(interest_config.last_update_timestamp) as f64;
    let pre_rate = i16::from(interest_config.pre_update_average_rate) as f64;
    let cur_rate = i16::from(interest_config.current_rate) as f64;
    let now = unix_timestamp as f64;

    // Time intervals
    let t1 = (last_update_ts - init_ts).max(0.0);
    let t2 = (now - last_update_ts).max(0.0);

    let exp1 = (pre_rate * t1 / (BPS_DENOMINATOR * SECONDS_PER_YEAR)).exp();
    let exp2 = (cur_rate * t2 / (BPS_DENOMINATOR * SECONDS_PER_YEAR)).exp();

    // Guard: f64 can only represent integers exactly up to 2^53
    if raw_amount > (1u64 << 53) {
        return Err(VaultError::Overflow.into());
    }

    let adjusted = (raw_amount as f64) * exp1 * exp2;

    // Guard against NaN / Infinity from corrupted clock or rate data
    if !adjusted.is_finite() {
        return Err(VaultError::InvalidMintExtension.into());
    }

    // Guard: result must fit in u64
    if adjusted > u64::MAX as f64 {
        return Err(VaultError::Overflow.into());
    }

    let result = adjusted.floor() as u64;

    // Sanity: if rates are non-negative the adjusted value should be >= raw
    if cur_rate >= 0.0 && pre_rate >= 0.0 && result < raw_amount {
        return Ok(raw_amount);
    }

    Ok(result)
}

#[program]
pub mod wokusd_vault {
    use super::*;

    /// Initialize the vault
    /// Creates config PDA and wOkuUSD mint (mint authority = config PDA)
    /// Authority pubkeys passed as args to reduce stack usage (avoids BPF stack overflow)
    pub fn initialize(ctx: Context<Initialize>, pauser: Pubkey, unpauser: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.bump = ctx.bumps.config;

        // Set all granular authorities (passed as args to avoid stack overflow)
        config.role_admin = ctx.accounts.role_admin.key();
        config.pauser = pauser;
        config.unpauser = unpauser;

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
    /// Transfers OkuUSD from user to vault, mints wOkuUSD shares to user.
    ///
    /// First deposit: subtracts MINIMUM_LIQUIDITY dead shares to prevent
    /// inflation attacks. `dead_shares_ata` (optional account) must be provided
    /// on the first deposit — it receives the permanently-locked dead shares.
    pub fn wrap(ctx: Context<Wrap>, okusd_amount: u64) -> Result<()> {
        // Read state first (immutable borrows)
        let is_paused = ctx.accounts.config.is_paused;
        // Use on-chain mint supply as canonical source of truth for share calculations
        let total_shares = ctx.accounts.wokusd_mint.supply;
        let bump = ctx.accounts.config.bump;
        let raw_vault_balance = ctx.accounts.vault_okusd.amount;
        let decimals = ctx.accounts.okusd_mint.decimals;

        require!(!is_paused, VaultError::Paused);
        require!(okusd_amount > 0, VaultError::ZeroAmount);

        // Compute interest-adjusted vault balance
        let clock = Clock::get()?;
        let mint_info = ctx.accounts.okusd_mint.to_account_info();
        let adjusted_vault_balance = compute_interest_adjusted_balance(
            raw_vault_balance,
            &mint_info,
            clock.unix_timestamp,
        )?;

        // Clone account infos for CPI reuse
        let okusd_mint_info = ctx.accounts.okusd_mint.to_account_info();
        let user_okusd_ata_info = ctx.accounts.user_okusd_ata.to_account_info();
        let vault_okusd_info = ctx.accounts.vault_okusd.to_account_info();
        let token_2022_info = ctx.accounts.token_2022_program.to_account_info();

        // Transfer OkuUSD from user to vault (Token-2022)
        token_interface::transfer_checked(
            CpiContext::new(
                token_2022_info.clone(),
                token_interface::TransferChecked {
                    from: user_okusd_ata_info,
                    to: vault_okusd_info,
                    authority: ctx.accounts.user.to_account_info(),
                    mint: okusd_mint_info,
                },
            ),
            okusd_amount,
            decimals,
        )?;

        let seeds = &[VaultConfig::SEED, &[bump]];
        let signer = &[&seeds[..]];

        if total_shares == 0 {
            // First deposit — enforce minimum liquidity and mint dead shares
            require!(okusd_amount > MINIMUM_LIQUIDITY, VaultError::MinimumLiquidity);

            let user_shares = okusd_amount
                .checked_sub(MINIMUM_LIQUIDITY)
                .ok_or(VaultError::Overflow)?;

            let dead_ata = ctx.accounts.dead_shares_ata
                .as_ref()
                .ok_or(VaultError::MinimumLiquidity)?;

            // Verify the dead ATA is for the correct mint (wOkuUSD)
            require!(dead_ata.mint == ctx.accounts.wokusd_mint.key(), VaultError::MinimumLiquidity);

            // Verify the dead ATA is owned by the System Program (truly unrecoverable)
            require!(dead_ata.owner == anchor_lang::system_program::ID, VaultError::MinimumLiquidity);

            // Mint user shares
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
                user_shares,
            )?;

            // Mint dead shares (permanently locked)
            anchor_spl::token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    anchor_spl::token::MintTo {
                        mint: ctx.accounts.wokusd_mint.to_account_info(),
                        to: dead_ata.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    signer,
                ),
                MINIMUM_LIQUIDITY,
            )?;

            // total_shares = user_shares + dead shares = okusd_amount
            let config = &mut ctx.accounts.config;
            config.total_shares = okusd_amount;

            emit!(WrapEvent {
                user: ctx.accounts.user.key(),
                okusd_amount,
                shares_minted: user_shares,
            });
        } else {
            // Subsequent deposits — proportional shares using u128 to prevent overflow
            let shares = (okusd_amount as u128)
                .checked_mul(total_shares as u128)
                .ok_or(VaultError::Overflow)?
                .checked_div(adjusted_vault_balance as u128)
                .ok_or(VaultError::Overflow)? as u64;

            require!(shares > 0, VaultError::ZeroAmount);

            // Mint wOkuUSD shares to user (standard SPL)
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
        }

        Ok(())
    }

    /// Unwrap wOkuUSD -> OkuUSD
    /// Burns wOkuUSD shares from user, transfers OkuUSD from vault to user
    /// NOTE: Unwrap always allowed even when paused - users must always be able to exit
    pub fn unwrap(ctx: Context<Unwrap>, shares: u64) -> Result<()> {
        // Read state first (immutable borrows)
        // Use on-chain mint supply as canonical source of truth for share calculations
        let total_shares = ctx.accounts.wokusd_mint.supply;
        let bump = ctx.accounts.config.bump;
        let raw_vault_balance = ctx.accounts.vault_okusd.amount;
        let decimals = ctx.accounts.okusd_mint.decimals;

        require!(shares > 0, VaultError::ZeroAmount);
        require!(shares <= total_shares, VaultError::InsufficientShares);

        // Compute interest-adjusted vault balance
        let clock = Clock::get()?;
        let mint_info = ctx.accounts.okusd_mint.to_account_info();
        let adjusted_vault_balance = compute_interest_adjusted_balance(
            raw_vault_balance,
            &mint_info,
            clock.unix_timestamp,
        )?;

        // Calculate OkuUSD to return using adjusted balance (u128 intermediaries)
        let okusd_out = (shares as u128)
            .checked_mul(adjusted_vault_balance as u128)
            .ok_or(VaultError::Overflow)?
            .checked_div(total_shares as u128)
            .ok_or(VaultError::Overflow)? as u64;

        require!(okusd_out > 0, VaultError::ZeroAmount);

        // Safety: revert if the adjusted payout exceeds raw balance.
        // Orchestrator must top up the vault with additional OkuUSD to cover interest.
        // Off-chain monitoring should watch for failed unwraps to trigger top-ups.
        require!(okusd_out <= raw_vault_balance, VaultError::InsufficientVaultBalance);

        // Clone account infos for CPI reuse
        let okusd_mint_info = ctx.accounts.okusd_mint.to_account_info();
        let user_okusd_ata_info = ctx.accounts.user_okusd_ata.to_account_info();
        let vault_okusd_info = ctx.accounts.vault_okusd.to_account_info();
        let token_2022_info = ctx.accounts.token_2022_program.to_account_info();

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
                token_2022_info,
                token_interface::TransferChecked {
                    from: vault_okusd_info,
                    to: user_okusd_ata_info,
                    authority: ctx.accounts.config.to_account_info(),
                    mint: okusd_mint_info,
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
            pauser: ctx.accounts.pauser.key(),
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
        require!(new_authority != Pubkey::default(), VaultError::Unauthorized);

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

    #[account(
        init,
        payer = role_admin,
        space = VaultConfig::LEN,
        seeds = [VaultConfig::SEED],
        bump
    )]
    pub config: Box<Account<'info, VaultConfig>>,

    /// OkuUSD mint (Token-2022 with Interest-Bearing extension)
    #[account(
        mint::token_program = token_2022_program
    )]
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// wOkuUSD mint (standard SPL Token)
    /// Mint authority must be the config PDA
    #[account(
        init,
        payer = role_admin,
        mint::decimals = okusd_mint.decimals,
        mint::authority = config,
        mint::token_program = token_program,
    )]
    pub wokusd_mint: Box<Account<'info, Mint>>,

    /// Vault's OkuUSD token account
    #[account(
        init,
        payer = role_admin,
        associated_token::mint = okusd_mint,
        associated_token::authority = config,
        associated_token::token_program = token_2022_program,
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

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
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// wOkuUSD mint (standard SPL)
    #[account(
        mut,
        address = config.wokusd_mint
    )]
    pub wokusd_mint: Box<Account<'info, Mint>>,

    /// User's OkuUSD token account
    #[account(
        mut,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's wOkuUSD token account (must be pre-created by frontend)
    #[account(
        mut,
        associated_token::mint = wokusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_wokusd_ata: Box<Account<'info, TokenAccount>>,

    /// Vault's OkuUSD token account
    #[account(
        mut,
        address = config.vault_okusd
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// Dead shares ATA — only required on the first deposit (total_shares == 0).
    /// This is a wOkuUSD ATA owned by a known dead address (System Program)
    /// where MINIMUM_LIQUIDITY shares are permanently locked.
    #[account(mut)]
    pub dead_shares_ata: Option<Account<'info, TokenAccount>>,

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
    pub okusd_mint: Box<InterfaceAccount<'info, MintInterface>>,

    /// wOkuUSD mint (standard SPL)
    #[account(
        mut,
        address = config.wokusd_mint
    )]
    pub wokusd_mint: Box<Account<'info, Mint>>,

    /// User's OkuUSD token account (must be pre-created by frontend)
    #[account(
        mut,
        associated_token::mint = okusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_2022_program,
    )]
    pub user_okusd_ata: Box<InterfaceAccount<'info, TokenAccountInterface>>,

    /// User's wOkuUSD token account
    #[account(
        mut,
        associated_token::mint = wokusd_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_wokusd_ata: Box<Account<'info, TokenAccount>>,

    /// Vault's OkuUSD token account
    #[account(
        mut,
        address = config.vault_okusd
    )]
    pub vault_okusd: Box<InterfaceAccount<'info, TokenAccountInterface>>,

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
    pub pauser: Pubkey,
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
