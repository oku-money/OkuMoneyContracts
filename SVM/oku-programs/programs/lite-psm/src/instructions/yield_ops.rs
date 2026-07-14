//! Yield distribution / multiplier-update instructions.
//!
//! The usdOku multiplier lives on the mint itself via the Token-2022
//! `ScaledUiAmountConfig` extension. These instructions read the current
//! multiplier from the extension, compute the new value, and CPI to
//! Token-2022's `UpdateMultiplier` to write it back.
//!
//! Discrete (per-call) multiplier accrual modelled on MakerDAO's `chi` / `_rpow`
//! pattern from sDAI. SVM uses a discrete bump per orchestrator call rather than
//! continuous on-read accrual to avoid recomputing on every PSM mint/redeem.
//! Taken from https://github.com/makerdao/sdai/blob/master/src/SavingsDai.sol

use crate::constants::{MAX_MULTIPLIER, PRECISION};
use crate::contexts::{DistributeYield, SetMultiplier};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::check_yield_lock;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::extension::scaled_ui_amount::instruction::update_multiplier;

/// Set usdOku multiplier directly
///
/// REBASER only. Sets last_yield_distribution_slot for sandwich prevention.
/// `new_multiplier` must be strictly greater than the current multiplier
/// (read from the mint's ScaledUiAmountConfig extension).
///
/// This is the SVM equivalent of EVM's `setOkuMMultiplier(uint256)`.
///
/// Rejects `new_multiplier == current` so a no-op call cannot stamp
/// the sandwich-lock slot without actually moving the multiplier (which
/// would waste the lock window for the entire slot). Mirrors the
/// `YieldTooSmall` guard on `distribute_yield`.
pub fn set_multiplier(ctx: Context<SetMultiplier>, new_multiplier: u64) -> Result<()> {
    // Cycle 4 (OKUD-06 mirror): self-fence on the lite-psm yield slot.
    // Two yield-affecting writes in the same slot would otherwise be
    // legal (strict-increase admits the second), defeating the
    // "one yield event per slot per program" invariant. Strict-increase
    // alone catches no-op writes; this catches near-no-op writes that
    // would still consume the same-slot lock budget.
    check_yield_lock(&ctx.accounts.config)?;

    // Read current multiplier from the usdOku mint's ScaledUiAmountConfig extension
    let current_multiplier =
        crate::helpers::scaled_ui::read_multiplier(&ctx.accounts.usd_oku_mint.to_account_info())?;

    // Strict increase — see fn-level doc for rationale.
    require!(
        new_multiplier > current_multiplier,
        LitePsmError::MultiplierCannotDecrease
    );

    // Math-sanity ceiling — keeps the downstream `u64 * u64 -> u128`
    // multiplications inside the overflow-safe region. Not a guard against
    // a malicious operator (which is out of scope per the centralized
    // trust model) but a math bound. See `MAX_MULTIPLIER` in
    // `oku-shared/constants.rs`.
    require!(
        new_multiplier <= MAX_MULTIPLIER,
        LitePsmError::MultiplierAboveMax
    );

    // Convert PRECISION-scaled u64 to f64 for the ScaledUiAmount extension.
    // E.g. new_multiplier = 1_500_000_000 (1.5x) → 1.5f64
    let new_multiplier_f64 = new_multiplier as f64 / PRECISION as f64;

    // CPI to Token-2022 UpdateMultiplier on the usdOku mint.
    // PsmConfig PDA signs as the ScaledUiAmount authority.
    let ix = update_multiplier(
        &ctx.accounts.token_2022_program.key(),
        &ctx.accounts.usd_oku_mint.key(),
        &ctx.accounts.config.key(),
        &[], // no multisig signers
        new_multiplier_f64,
        0, // effective_timestamp = 0 (immediate)
    )
    .map_err(|_| error!(LitePsmError::MultiplierUpdateFailed))?;

    let account_infos = &[
        ctx.accounts.usd_oku_mint.to_account_info(),
        ctx.accounts.config.to_account_info(),
    ];

    let seeds = &[PsmConfig::SEED, &[ctx.accounts.config.bump]];
    let signer = &[&seeds[..]];
    anchor_lang::solana_program::program::invoke_signed(&ix, account_infos, signer)
        .map_err(|_| error!(LitePsmError::MultiplierUpdateFailed))?;

    // Stamp the yield-distribution slot. The multiplier itself is now
    // stored on the mint extension (written by the CPI above), not on
    // PsmConfig.
    let clock = Clock::get()?;
    ctx.accounts.config.last_yield_distribution_slot = clock.slot;

    emit!(YieldDistributionSlotSet { slot: clock.slot });

    // Get total supply for event
    let total_supply = ctx.accounts.usd_oku_mint.supply;

    emit!(MultiplierUpdated {
        old_multiplier: current_multiplier,
        new_multiplier,
        total_supply,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Distribute dollar-denominated yield across all usdOku holders
///
/// new_multiplier = old_multiplier + (yield_amount * PRECISION / total_supply)
///
/// REBASER only. Sets last_yield_distribution_slot for sandwich prevention.
///
/// This is the SVM equivalent of EVM's `distributeYield(uint256 yieldAmount)`.
pub fn distribute_yield(ctx: Context<DistributeYield>, yield_amount: u64) -> Result<()> {
    // Cycle 4 (OKUD-06 mirror): self-fence on the lite-psm yield slot.
    // See `set_multiplier` for rationale.
    check_yield_lock(&ctx.accounts.config)?;

    require!(yield_amount > 0, LitePsmError::ZeroAmount);

    let total_supply = ctx.accounts.usd_oku_mint.supply;
    require!(total_supply > 0, LitePsmError::ZeroAmount);

    // Read current multiplier from the usdOku mint's ScaledUiAmountConfig extension
    let current_multiplier =
        crate::helpers::scaled_ui::read_multiplier(&ctx.accounts.usd_oku_mint.to_account_info())?;

    // Cycle 4 (S-29): use the shared `mul_div_floor` primitive instead
    // of open-coding the same `(yield * PRECISION) / total_supply` math.
    // Identical semantics (floor + u128 widening + try_from narrowing)
    // and the path is now covered by the cargo-fuzz `mul_div_floor`
    // target and the Kani correctness proof at no extra cost.
    let yield_per_token = oku_shared::mul_div_floor(yield_amount, PRECISION, total_supply)
        .ok_or(LitePsmError::Overflow)?;

    // Prevent no-op distributions that waste the yield lock slot
    // This can happen when yield_amount is tiny relative to total_supply
    require!(yield_per_token > 0, LitePsmError::YieldTooSmall);

    let new_multiplier = current_multiplier
        .checked_add(yield_per_token)
        .ok_or(LitePsmError::Overflow)?;

    // Sanity ceiling — see `set_multiplier` for rationale.
    require!(
        new_multiplier <= MAX_MULTIPLIER,
        LitePsmError::MultiplierAboveMax
    );

    // Convert PRECISION-scaled u64 to f64 for the ScaledUiAmount extension.
    let new_multiplier_f64 = new_multiplier as f64 / PRECISION as f64;

    // CPI to Token-2022 UpdateMultiplier on the usdOku mint.
    let ix = update_multiplier(
        &ctx.accounts.token_2022_program.key(),
        &ctx.accounts.usd_oku_mint.key(),
        &ctx.accounts.config.key(),
        &[], // no multisig signers
        new_multiplier_f64,
        0, // effective_timestamp = 0 (immediate)
    )
    .map_err(|_| error!(LitePsmError::MultiplierUpdateFailed))?;

    let account_infos = &[
        ctx.accounts.usd_oku_mint.to_account_info(),
        ctx.accounts.config.to_account_info(),
    ];

    let seeds = &[PsmConfig::SEED, &[ctx.accounts.config.bump]];
    let signer = &[&seeds[..]];
    anchor_lang::solana_program::program::invoke_signed(&ix, account_infos, signer)
        .map_err(|_| error!(LitePsmError::MultiplierUpdateFailed))?;

    // Stamp the yield-distribution slot; the multiplier is stored on the
    // mint extension (written by the CPI above).
    let clock = Clock::get()?;
    ctx.accounts.config.last_yield_distribution_slot = clock.slot;

    emit!(YieldDistributionSlotSet { slot: clock.slot });

    emit!(YieldDistributed {
        yield_amount,
        old_multiplier: current_multiplier,
        new_multiplier,
        total_supply,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}
