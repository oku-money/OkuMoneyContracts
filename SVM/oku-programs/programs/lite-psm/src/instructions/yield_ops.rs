//! Yield distribution / multiplier-update instructions.
//!
//! Discrete (per-call) multiplier accrual modelled on MakerDAO's `chi` / `_rpow`
//! pattern from sDAI. SVM uses a discrete bump per orchestrator call rather than
//! continuous on-read accrual to avoid recomputing on every PSM mint/redeem.
//! Taken from https://github.com/makerdao/sdai/blob/master/src/SavingsDai.sol

use crate::constants::PRECISION;
use crate::contexts::{DistributeYield, SetOkuMPrice};
use crate::errors::LitePsmError;
use crate::events::*;
use anchor_lang::prelude::*;

/// Set OkuMoney price directly
///
/// REBASER only. Sets last_yield_distribution_slot for sandwich prevention.
/// new_multiplier must be >= current (price never decreases).
///
/// This is the SVM equivalent of EVM's `setOkuMPrice(uint256 newPrice)`.
pub fn set_oku_m_price(ctx: Context<SetOkuMPrice>, new_multiplier: u64) -> Result<()> {
    let config = &mut ctx.accounts.config;

    // Read current multiplier from config
    let current_multiplier = config.oku_m_price;

    // Price can only increase (or stay the same)
    require!(
        new_multiplier >= current_multiplier,
        LitePsmError::PriceCannotDecrease
    );

    // Set yield distribution slot FIRST (before price update for atomicity)
    let clock = Clock::get()?;
    config.last_yield_distribution_slot = clock.slot;

    // Update the stored price
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
    // This distributes the yield proportionally across all holders
    let yield_per_token = (yield_amount as u128)
        .checked_mul(PRECISION as u128)
        .ok_or(LitePsmError::Overflow)?
        .checked_div(total_supply as u128)
        .ok_or(LitePsmError::Overflow)? as u64;

    // Prevent no-op distributions that waste the yield lock slot
    // This can happen when yield_amount is tiny relative to total_supply
    require!(yield_per_token > 0, LitePsmError::YieldTooSmall);

    let new_multiplier = current_multiplier
        .checked_add(yield_per_token)
        .ok_or(LitePsmError::Overflow)?;

    // Set yield distribution slot FIRST
    let clock = Clock::get()?;
    config.last_yield_distribution_slot = clock.slot;

    // Update the stored price
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
