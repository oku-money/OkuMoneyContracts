use anchor_lang::prelude::*;
use crate::contexts::{UpdateInterestRate, SetNextYieldRate};
use crate::errors::OkuError;
use crate::events::*;
use crate::helpers::cpi_update_token2022_rate;

/// Update the interest rate on the OkuUSD mint (Token-2022 Interest Bearing extension)
/// Emergency override: sets rate immediately and clears all scheduling state.
/// Rate is in basis points (e.g., 450 = 4.5% APY)
/// Also stores the rate in config for queue processing interest calculations
pub fn update_interest_rate(ctx: Context<UpdateInterestRate>, new_rate: i16) -> Result<()> {
    cpi_update_token2022_rate(
        &ctx.accounts.token_2022_program.to_account_info(),
        &ctx.accounts.okusd_mint.to_account_info(),
        &ctx.accounts.rebaser.to_account_info(),
        new_rate,
    )?;

    let config = &mut ctx.accounts.config;
    config.current_rate_bps = new_rate;
    config.rate_end = 0;
    config.pending_rate_bps = 0;

    emit!(InterestRateUpdatedEvent {
        rate_authority: ctx.accounts.rebaser.key(),
        new_rate,
    });

    Ok(())
}

/// Set yield rate with optional end timestamp for rate scheduling.
/// CPIs to Token-2022 UpdateRate immediately.
/// If end_timestamp > 0, the rate is considered temporary and a pending rate can be scheduled.
/// If end_timestamp == 0, the rate has no expiry.
pub fn set_yield_rate(ctx: Context<UpdateInterestRate>, new_rate: i16, end_timestamp: i64) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        end_timestamp == 0 || end_timestamp > clock.unix_timestamp,
        OkuError::RateEndNotFuture
    );

    cpi_update_token2022_rate(
        &ctx.accounts.token_2022_program.to_account_info(),
        &ctx.accounts.okusd_mint.to_account_info(),
        &ctx.accounts.rebaser.to_account_info(),
        new_rate,
    )?;

    let config = &mut ctx.accounts.config;
    config.current_rate_bps = new_rate;
    config.rate_end = end_timestamp;
    config.pending_rate_bps = 0;

    emit!(YieldRateSetEvent {
        rate_authority: ctx.accounts.rebaser.key(),
        new_rate,
        end_timestamp,
    });

    Ok(())
}

/// Schedule the next yield rate to take effect when the current rate expires.
/// Does NOT CPI to Token-2022 — the pending rate is only stored in config.
/// The orchestrator calls apply_pending_rate when rate_end arrives.
pub fn set_next_yield_rate(ctx: Context<SetNextYieldRate>, new_rate: i16) -> Result<()> {
    let config = &mut ctx.accounts.config;
    require!(config.rate_end != 0, OkuError::NoRateEnd);

    config.pending_rate_bps = new_rate;

    emit!(NextYieldRateSetEvent {
        rate_authority: ctx.accounts.rebaser.key(),
        new_rate,
        activates_at: config.rate_end,
    });

    Ok(())
}

/// Apply the pending rate after rate_end has passed.
/// CPIs to Token-2022 UpdateRate with the pending rate.
/// Clears scheduling state after application.
pub fn apply_pending_rate(ctx: Context<UpdateInterestRate>) -> Result<()> {
    let clock = Clock::get()?;
    let config = &ctx.accounts.config;
    require!(config.rate_end != 0, OkuError::NoRateEnd);
    require!(clock.unix_timestamp >= config.rate_end, OkuError::RateEndNotPassed);

    let pending_rate = config.pending_rate_bps;

    cpi_update_token2022_rate(
        &ctx.accounts.token_2022_program.to_account_info(),
        &ctx.accounts.okusd_mint.to_account_info(),
        &ctx.accounts.rebaser.to_account_info(),
        pending_rate,
    )?;

    let config = &mut ctx.accounts.config;
    config.current_rate_bps = pending_rate;
    config.rate_end = 0;
    config.pending_rate_bps = 0;

    emit!(PendingRateAppliedEvent {
        rate_authority: ctx.accounts.rebaser.key(),
        applied_rate: pending_rate,
    });

    Ok(())
}
