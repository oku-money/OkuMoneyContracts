//! Yield distribution / multiplier-update instructions.
//!
//! Discrete (per-call) multiplier accrual modelled on MakerDAO's `chi` / `_rpow`
//! pattern from sDAI. SVM uses a discrete bump per orchestrator call rather than
//! continuous on-read accrual to avoid recomputing on every PSM mint/redeem.
//! Taken from https://github.com/makerdao/sdai/blob/master/src/SavingsDai.sol

use crate::constants::{MAX_OKU_M_PRICE, PRECISION};
use crate::contexts::{DistributeYield, SetOkuMPrice};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::check_yield_lock;
use anchor_lang::prelude::*;

/// Set OkuMoney price directly
///
/// REBASER only. Sets last_yield_distribution_slot for sandwich prevention.
/// `new_multiplier` must be strictly greater than the current price.
///
/// This is the SVM equivalent of EVM's `setOkuMMultiplier(uint256)`.
///
/// Rejects `new_multiplier == oku_m_price` so a no-op call cannot stamp
/// the sandwich-lock slot without actually moving the multiplier (which
/// would waste the lock window for the entire slot). Mirrors the
/// `YieldTooSmall` guard on `distribute_yield` and the EVM fix landed
/// alongside the oracle-relay cycle.
pub fn set_oku_m_price(ctx: Context<SetOkuMPrice>, new_multiplier: u64) -> Result<()> {
    // Cycle 4 (OKUD-06 mirror): self-fence on the lite-psm yield slot.
    // Two yield-affecting writes in the same slot would otherwise be
    // legal (strict-increase admits the second), defeating the
    // "one yield event per slot per program" invariant. Strict-increase
    // alone catches no-op writes; this catches near-no-op writes that
    // would still consume the same-slot lock budget.
    check_yield_lock(&ctx.accounts.config)?;

    let config = &mut ctx.accounts.config;

    // Read current multiplier from config
    let current_multiplier = config.oku_m_price;

    // Strict increase — see fn-level doc for rationale.
    require!(
        new_multiplier > current_multiplier,
        LitePsmError::PriceCannotDecrease
    );

    // Math-sanity ceiling — keeps the downstream `u64 * u64 -> u128`
    // multiplications inside the overflow-safe region. Not a guard against
    // a malicious operator (which is out of scope per the centralized
    // trust model) but a math bound. See `MAX_OKU_M_PRICE` in
    // `oku-shared/constants.rs`.
    require!(
        new_multiplier <= MAX_OKU_M_PRICE,
        LitePsmError::PriceAboveMax
    );

    // Stamp the yield-distribution slot and update the price. Both writes
    // commit atomically at the end of the instruction (Anchor's storage
    // deltas are flushed together), so ordering here is purely stylistic.
    let clock = Clock::get()?;
    config.last_yield_distribution_slot = clock.slot;
    config.oku_m_price = new_multiplier;

    emit!(YieldDistributionSlotSet { slot: clock.slot });

    // Get total supply for event
    let total_supply = ctx.accounts.oku_money_mint.supply;

    emit!(OkuMPriceUpdated {
        old_multiplier: current_multiplier,
        new_multiplier,
        total_supply,
        timestamp: clock.unix_timestamp,
    });

    Ok(())
}

/// Distribute dollar-denominated yield across all OkuMoney holders
///
/// new_multiplier = old_multiplier + (yield_amount * PRECISION / total_supply)
///
/// REBASER only. Sets last_yield_distribution_slot for sandwich prevention.
///
/// This is the SVM equivalent of EVM's `distributeYield(uint256 yieldAmount)`.
pub fn distribute_yield(ctx: Context<DistributeYield>, yield_amount: u64) -> Result<()> {
    // Cycle 4 (OKUD-06 mirror): self-fence on the lite-psm yield slot.
    // See `set_oku_m_price` for rationale.
    check_yield_lock(&ctx.accounts.config)?;

    require!(yield_amount > 0, LitePsmError::ZeroAmount);

    let total_supply = ctx.accounts.oku_money_mint.supply;
    require!(total_supply > 0, LitePsmError::ZeroAmount);

    let config = &mut ctx.accounts.config;

    // Read current multiplier from config
    let current_multiplier = config.oku_m_price;

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

    // Sanity ceiling — see `set_oku_m_price` for rationale.
    require!(
        new_multiplier <= MAX_OKU_M_PRICE,
        LitePsmError::PriceAboveMax
    );

    // Stamp the yield-distribution slot and update the price; ordering is
    // stylistic — both commit atomically at the end of the instruction.
    let clock = Clock::get()?;
    config.last_yield_distribution_slot = clock.slot;
    config.oku_m_price = new_multiplier;

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
