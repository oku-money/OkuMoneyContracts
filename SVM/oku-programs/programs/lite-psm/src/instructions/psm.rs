//! LitePSM user-facing instructions (mint/redeem/buffer).
//!
//! The buffer-backed mint + instant redemption lifecycle here mirrors MakerDAO's
//! `DssLitePsm`: deposit USDC → mint at peg, redeem from buffer when liquid.
//! Taken from https://github.com/makerdao/dss-lite-psm/blob/master/src/DssLitePsm.sol

use crate::contexts::{DepositBuffer, MintOkuM, RedeemOkuM, WithdrawBuffer};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::{check_yield_lock, dollars_to_raw, raw_to_dollars};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_interface;

/// Mint OkuM with USDC (multiplier-aware)
///
/// raw_oku_m_amount = usdc_amount * PRECISION / multiplier
/// When multiplier > PRECISION, you get fewer raw OkuM tokens per USDC
///
/// Blocked during the same slot as a yield distribution (sandwich
/// prevention).
pub fn mint_oku_m(ctx: Context<MintOkuM>, usdc_amount: u64) -> Result<()> {
    // Check yield distribution lock FIRST
    check_yield_lock(&ctx.accounts.config)?;

    // Read state
    let is_paused = ctx.accounts.config.is_paused;
    let max_supply = ctx.accounts.config.max_supply;
    let minter_allowance = ctx.accounts.config.minter_allowance;
    let current_supply = ctx.accounts.oku_m_mint.supply;

    require!(!is_paused, LitePsmError::Paused);
    require!(usdc_amount > 0, LitePsmError::ZeroAmount);

    // Read current multiplier from the OkuM mint's ScaledUiAmountConfig extension
    let multiplier =
        crate::helpers::scaled_ui::read_multiplier(&ctx.accounts.oku_m_mint.to_account_info())?;

    // Calculate OkuM raw amount (multiplier-aware): treat usdc_amount as a dollar value.
    let raw_oku_m_amount = dollars_to_raw(usdc_amount, multiplier)?;

    // Reject zero-output mints — at high `multiplier`, the division can
    // truncate to zero, which would silently donate USDC to the buffer with
    // no OkuM minted in return. Matches EVM `LitePSM` `AmountTooSmall`.
    require!(raw_oku_m_amount > 0, LitePsmError::AmountTooSmall);

    // Check max supply
    require!(
        current_supply
            .checked_add(raw_oku_m_amount)
            .ok_or(LitePsmError::Overflow)?
            <= max_supply,
        LitePsmError::MaxSupplyExceeded
    );

    // Check minter allowance
    require!(
        raw_oku_m_amount <= minter_allowance,
        LitePsmError::AllowanceExceeded
    );

    // Effects-checks-interactions: decrement minter allowance BEFORE the mint
    // CPI so a future Token-2022 transfer-hook on OkuM cannot re-enter and
    // double-spend the same allowance window.
    let bump = ctx.accounts.config.bump;
    ctx.accounts.config.minter_allowance = minter_allowance
        .checked_sub(raw_oku_m_amount)
        .ok_or(LitePsmError::Overflow)?;

    // Transfer USDC from user to vault (standard SPL)
    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.user_usdc_ata.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        usdc_amount,
    )?;

    // Mint OkuM to user (Token-2022)
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    // Capture user key before borrows
    let user_key = ctx.accounts.user.key();

    token_interface::mint_to(
        CpiContext::new_with_signer(
            ctx.accounts.token_2022_program.key(),
            token_interface::MintTo {
                mint: ctx.accounts.oku_m_mint.to_account_info(),
                to: ctx.accounts.user_oku_m_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        raw_oku_m_amount,
    )?;

    // Calculate dollar value for event
    let dollar_value = raw_to_dollars(raw_oku_m_amount, multiplier)?;

    // Cycle 4 (PSM-23): emit post-mint supply for indexer reconciliation.
    // `reload()` refreshes the mint account's `supply` field after the
    // mint_to CPI; without it we'd read the pre-mint cached value.
    ctx.accounts.oku_m_mint.reload()?;
    let new_total_supply = ctx.accounts.oku_m_mint.supply;

    emit!(MintEvent {
        user: user_key,
        usdc_amount,
        raw_oku_m_amount,
        dollar_value,
        multiplier,
        new_total_supply,
    });

    Ok(())
}

/// Redeem OkuM for USDC (multiplier-aware, with slippage protection)
///
/// usdc_amount = raw_oku_m_amount * multiplier / PRECISION
/// When multiplier > PRECISION, you get more USDC per raw OkuM token
///
/// # Arguments
/// * `raw_oku_m_amount` - Raw OkuM tokens to redeem
/// * `min_usdc_out` - Minimum USDC output the user will accept (slippage
///   protection). Pass `0` to skip the check. EVM parity:
///   `LitePSM.redeemOkuM(amount)` — while EVM's monotonic multiplier makes
///   slippage structurally impossible, we include the parameter for
///   defense-in-depth and client-side safety.
///
/// Reverts if buffer is insufficient.
/// Blocked during same slot as yield distribution (sandwich prevention).
pub fn redeem_oku_m(
    ctx: Context<RedeemOkuM>,
    raw_oku_m_amount: u64,
    min_usdc_out: u64,
) -> Result<()> {
    // Check yield distribution lock FIRST
    check_yield_lock(&ctx.accounts.config)?;

    // Read state
    let is_paused = ctx.accounts.config.is_paused;
    let bump = ctx.accounts.config.bump;
    let vault_usdc_balance = ctx.accounts.vault_usdc.amount;

    require!(!is_paused, LitePsmError::Paused);
    require!(raw_oku_m_amount > 0, LitePsmError::ZeroAmount);

    // Read current multiplier from the OkuM mint's ScaledUiAmountConfig extension
    let multiplier =
        crate::helpers::scaled_ui::read_multiplier(&ctx.accounts.oku_m_mint.to_account_info())?;

    // Calculate USDC amount (multiplier-aware): treat dollar value as USDC.
    let usdc_amount = raw_to_dollars(raw_oku_m_amount, multiplier)?;

    // Reject zero-output redeems
    require!(usdc_amount > 0, LitePsmError::OutputBelowMinimum);

    // Slippage protection: reject if output is below user's minimum
    require!(
        usdc_amount >= min_usdc_out,
        LitePsmError::OutputBelowMinimum
    );

    // Pre-check user balance to surface a custom error instead of the
    // opaque SPL insufficient-balance error.
    {
        let user_balance = ctx.accounts.user_oku_m_ata.amount;
        require!(
            user_balance >= raw_oku_m_amount,
            LitePsmError::InsufficientUserBalance
        );
    }

    // Check buffer is sufficient for redemption
    require!(
        vault_usdc_balance >= usdc_amount,
        LitePsmError::InsufficientBuffer
    );

    // Burn OkuM from user
    token_interface::burn(
        CpiContext::new(
            ctx.accounts.token_2022_program.key(),
            token_interface::Burn {
                mint: ctx.accounts.oku_m_mint.to_account_info(),
                from: ctx.accounts.user_oku_m_ata.to_account_info(),
                authority: ctx.accounts.user.to_account_info(),
            },
        ),
        raw_oku_m_amount,
    )?;

    // Transfer USDC to user
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.vault_usdc.to_account_info(),
                to: ctx.accounts.user_usdc_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        usdc_amount,
    )?;

    // Emit post-burn supply for indexer reconciliation.
    ctx.accounts.oku_m_mint.reload()?;
    let new_total_supply = ctx.accounts.oku_m_mint.supply;

    emit!(RedeemEvent {
        user: ctx.accounts.user.key(),
        raw_oku_m_amount,
        usdc_amount,
        dollar_value: usdc_amount, // USDC is dollar-denominated
        multiplier,
        new_total_supply,
    });

    Ok(())
}

/// Deposit USDC buffer (buffer_depositor role)
///
/// Yield-locked and pause-gated for symmetry with every other value-moving
/// instruction (`mint_oku_m`, `redeem_oku_m`, `withdraw_buffer`,
/// `mint_oku_m_direct`, `burn_oku_m_direct`). A deposit only grows the
/// buffer so it was previously unguarded on the theory that it is
/// monotonic-favorable to the protocol — but leaving it un-gated was an
/// undocumented asymmetry an auditor would flag, so both guards were added
/// for uniformity rather than because a concrete exploit was found.
pub fn deposit_buffer(ctx: Context<DepositBuffer>, amount: u64) -> Result<()> {
    check_yield_lock(&ctx.accounts.config)?;
    require!(!ctx.accounts.config.is_paused, LitePsmError::Paused);
    require!(amount > 0, LitePsmError::ZeroAmount);

    anchor_spl::token::transfer(
        CpiContext::new(
            ctx.accounts.token_program.key(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.buffer_depositor_usdc_ata.to_account_info(),
                to: ctx.accounts.vault_usdc.to_account_info(),
                authority: ctx.accounts.buffer_depositor.to_account_info(),
            },
        ),
        amount,
    )?;

    // Reload vault balance after transfer
    ctx.accounts.vault_usdc.reload()?;
    let new_buffer_balance = ctx.accounts.vault_usdc.amount;

    emit!(BufferDepositEvent {
        orchestrator: ctx.accounts.buffer_depositor.key(),
        amount,
        new_buffer_balance,
    });

    Ok(())
}

/// Withdraw USDC from buffer (buffer_withdrawer only)
///
/// Used to reclaim excess buffer after redemptions processed.
///
/// **Intentionally NOT pause-gated.** Mirrors EVM `LitePSM.withdrawUsdc`, which
/// has no `whenNotPaused` modifier (verified `EVM/src/psm/LitePSM.sol:540`).
/// Pause is a user-side incident lever: it blocks mints/redeems but must NOT
/// block the cold multisig from rebalancing buffer USDC during an incident
/// response.
pub fn withdraw_buffer(ctx: Context<WithdrawBuffer>, amount: u64) -> Result<()> {
    check_yield_lock(&ctx.accounts.config)?;
    require!(amount > 0, LitePsmError::ZeroAmount);

    let vault_balance = ctx.accounts.vault_usdc.amount;
    require!(vault_balance >= amount, LitePsmError::InsufficientBuffer);

    let bump = ctx.accounts.config.bump;
    let seeds = &[PsmConfig::SEED, &[bump]];
    let signer = &[&seeds[..]];

    anchor_spl::token::transfer(
        CpiContext::new_with_signer(
            ctx.accounts.token_program.key(),
            anchor_spl::token::Transfer {
                from: ctx.accounts.vault_usdc.to_account_info(),
                to: ctx.accounts.withdrawer_usdc_ata.to_account_info(),
                authority: ctx.accounts.config.to_account_info(),
            },
            signer,
        ),
        amount,
    )?;

    // Reload vault balance after transfer
    ctx.accounts.vault_usdc.reload()?;
    let new_buffer_balance = ctx.accounts.vault_usdc.amount;

    emit!(BufferWithdrawEvent {
        actor: ctx.accounts.buffer_withdrawer.key(),
        amount,
        new_buffer_balance,
    });

    Ok(())
}
