use anchor_lang::prelude::*;
use anchor_spl::token_interface;
use crate::contexts::{Initialize, Wrap, Unwrap};
use crate::errors::VaultError;
use crate::events::*;
use crate::helpers::{compute_interest_adjusted_balance, MINIMUM_LIQUIDITY};
use crate::state::VaultConfig;

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
