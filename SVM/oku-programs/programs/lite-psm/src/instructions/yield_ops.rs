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
    require!(yield_amount > 0, LitePsmError::ZeroAmount);

    let total_supply = ctx.accounts.oku_money_mint.supply;
    require!(total_supply > 0, LitePsmError::ZeroAmount);

    let config = &mut ctx.accounts.config;

    // Read current multiplier from config
    let current_multiplier = config.oku_m_price;

    // Calculate new multiplier
    // new_multiplier = old_multiplier + (yield_amount * PRECISION / total_supply)
    // This distributes the yield proportionally across all holders.
    //
    // Use `u64::try_from` (NOT `as u64`) on the final widening cast so that
    // any value exceeding `u64::MAX` is surfaced as `Overflow` rather than
    // silently truncated. With `PRECISION = 1e9` and a pathologically small
    // `total_supply`, the quotient can exceed `u64::MAX`; the subsequent
    // `MAX_OKU_M_PRICE` ceiling would only catch the final multiplier, not
    // the corrupted per-token value.
    let yield_per_token_u128 = (yield_amount as u128)
        .checked_mul(PRECISION as u128)
        .ok_or(LitePsmError::Overflow)?
        .checked_div(total_supply as u128)
        .ok_or(LitePsmError::Overflow)?;
    let yield_per_token =
        u64::try_from(yield_per_token_u128).map_err(|_| LitePsmError::Overflow)?;

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
