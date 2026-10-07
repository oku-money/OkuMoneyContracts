//! Rate-schedule instructions. They change the slope of the continuous
//! multiplier curve (no discrete economic event) except the emergency
//! override. Every write re-snapshots `okum_base_multiplier` first, so accrual
//! is continuous across it. See SVM/README.md, "Yield (streaming rate schedule)".

use crate::contexts::{SetOkuMMultiplier, SetYieldRate, SyncDisplayMultiplier};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::display_sync::write_display_multiplier;
use crate::helpers::{check_yield_lock_with_clock, multiplier};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::{MAX_MULTIPLIER, MAX_RATE, MAX_RATE_WINDOW_SECONDS, PRECISION};

/// Stored rate meaning "not accruing" (`PRECISION`, i.e. 1.0 per second).
const NO_YIELD_RATE: u64 = PRECISION as u64;

fn validate_rate_bounds(rate: u64) -> Result<()> {
    let rate = rate as u128;
    require!(rate >= PRECISION, LitePsmError::InvalidRate);
    require!(rate <= MAX_RATE, LitePsmError::RateTooHigh);
    Ok(())
}

/// Validate a `(rate, end_timestamp)` pair. A yielding rate must carry a window
/// (otherwise it would end whenever a transaction happened to land, which breaks
/// cross-chain determinism); a halted rate must not.
fn validate_rate_window(rate: u64, end_timestamp: i64, now_ts: i64) -> Result<()> {
    validate_rate_bounds(rate)?;

    if rate as u128 == PRECISION {
        require!(end_timestamp == 0, LitePsmError::EndTimestampNotAllowed);
    } else {
        require!(end_timestamp > now_ts, LitePsmError::EndTimestampInPast);
        // Bounds the `rpow` exponent; see `MAX_RATE_WINDOW_SECONDS`.
        require!(
            end_timestamp.saturating_sub(now_ts) <= MAX_RATE_WINDOW_SECONDS,
            LitePsmError::RateWindowTooLong
        );
    }

    Ok(())
}

/// Re-snapshot the base multiplier at `now_ts`; skipping this would strand or
/// double-count yield accrued since the last anchor.
fn reanchor(config: &mut PsmConfig, now_ts: i64) -> Result<u128> {
    let snapshot = multiplier::at(config, now_ts)?;
    config.okum_base_multiplier = snapshot;
    config.okum_last_accrual_time = now_ts;
    Ok(snapshot)
}

fn clear_successor(config: &mut PsmConfig) {
    config.okum_pending_rate_per_second = NO_YIELD_RATE;
    config.okum_pending_rate_end = 0;
}

fn halt_schedule(config: &mut PsmConfig) {
    config.okum_rate_per_second = NO_YIELD_RATE;
    config.okum_rate_end = 0;
    clear_successor(config);
}

/// Reject a rate increase while paused. Decreases (including halting) stay
/// available: the incident lever must not be blocked by the incident.
///
/// Compares against the EFFECTIVE rate: once the active window has closed the
/// stored rate is stale and higher than what accrues, so comparing against
/// storage would let an increase pass as a decrease.
fn check_pause_gate(config: &PsmConfig, new_rate: u64, now_ts: i64) -> Result<()> {
    if config.is_paused && (new_rate as u128) > multiplier::effective_rate(config, now_ts) {
        return err!(LitePsmError::Paused);
    }
    Ok(())
}

// `apply_active_rate` and `apply_successor` each validate, gate and write on
// their own, and the atomic setter calls them in sequence. Do not merge them
// into one validate-then-write pass: the successor's checks must see the active
// rate's write, or a halted rate could take a successor and, while paused, the
// gate would compare against the old effective rate and let an increase through.

/// Write the active rate and its window, clearing any armed successor.
fn apply_active_rate(
    config: &mut PsmConfig,
    new_rate: u64,
    end_timestamp: i64,
    now_ts: i64,
) -> Result<()> {
    validate_rate_window(new_rate, end_timestamp, now_ts)?;
    check_pause_gate(config, new_rate, now_ts)?;

    let old_rate = config.okum_rate_per_second;
    emit_pending_cancelled_if_armed(config, now_ts);
    let snapshot = reanchor(config, now_ts)?;

    config.okum_rate_per_second = new_rate;
    config.okum_rate_end = end_timestamp;
    clear_successor(config);

    emit!(YieldRateUpdated {
        old_rate,
        new_rate,
        rate_end: end_timestamp,
        base_multiplier: snapshot,
        timestamp: now_ts,
    });

    Ok(())
}

/// Stage the successor that takes over at the current `okum_rate_end`. Reads
/// `okum_rate_end` from config so the atomic path sees the active rate's write.
fn apply_successor(
    config: &mut PsmConfig,
    new_rate: u64,
    pending_end_timestamp: i64,
    now_ts: i64,
) -> Result<()> {
    validate_rate_bounds(new_rate)?;

    let rate_end = config.okum_rate_end;
    // A successor needs a live window; this also rejects "halt and arm".
    require!(rate_end != 0, LitePsmError::NoRateEndSet);
    require!(now_ts < rate_end, LitePsmError::RateAlreadyExpired);
    require!(
        pending_end_timestamp > rate_end,
        LitePsmError::PendingEndNotAfterRateEnd
    );
    // The successor's own span `[rate_end, pending_end]` is a separate `rpow`
    // (branch 2 of `compute_multiplier`), so it is bounded independently.
    require!(
        pending_end_timestamp.saturating_sub(rate_end) <= MAX_RATE_WINDOW_SECONDS,
        LitePsmError::RateWindowTooLong
    );

    check_pause_gate(config, new_rate, now_ts)?;

    let old_rate = config.okum_pending_rate_per_second;
    emit_pending_cancelled_if_armed(config, now_ts);

    config.okum_pending_rate_per_second = new_rate;
    config.okum_pending_rate_end = pending_end_timestamp;

    emit!(PendingYieldRateUpdated {
        old_rate,
        new_rate,
        rate_end,
        pending_rate_end: pending_end_timestamp,
        timestamp: now_ts,
    });

    Ok(())
}

/// A successor is staged and its activation (`rate_end`) is still in the future.
/// Past `rate_end` it is already the accruing rate, so replacing it is not a
/// cancellation.
fn successor_armed_and_not_yet_active(config: &PsmConfig, now_ts: i64) -> bool {
    (config.okum_pending_rate_per_second as u128) > PRECISION
        && config.okum_rate_end != 0
        && now_ts < config.okum_rate_end
}

/// Emit `PendingRateCancelled` when an armed successor is discarded or replaced,
/// so event-driven monitoring never shows a stale staged successor.
fn emit_pending_cancelled_if_armed(config: &PsmConfig, now_ts: i64) {
    if successor_armed_and_not_yet_active(config, now_ts) {
        emit!(PendingRateCancelled {
            cancelled_rate: config.okum_pending_rate_per_second,
            cancelled_pending_rate_end: config.okum_pending_rate_end,
            timestamp: now_ts,
        });
    }
}

/// Re-anchors first, so the switch is continuous.
pub fn set_okum_yield_rate(
    ctx: Context<SetYieldRate>,
    new_rate: u64,
    end_timestamp: i64,
) -> Result<()> {
    let now_ts = Clock::get()?.unix_timestamp;
    apply_active_rate(&mut ctx.accounts.config, new_rate, end_timestamp, now_ts)
}

/// Does not re-anchor: the active rate and window are untouched. The successor
/// activates off the absolute `okum_rate_end`, not a transaction, so staging may
/// land on different chains days apart and still activate simultaneously.
pub fn set_next_okum_yield_rate(
    ctx: Context<SetYieldRate>,
    new_rate: u64,
    pending_end_timestamp: i64,
) -> Result<()> {
    let now_ts = Clock::get()?.unix_timestamp;
    apply_successor(
        &mut ctx.accounts.config,
        new_rate,
        pending_end_timestamp,
        now_ts,
    )
}

/// One transaction, so no window exists in which one chain has the successor and
/// another does not. Order is load-bearing: the successor reads the `rate_end`
/// just written.
pub fn set_okum_yield_rate_with_successor(
    ctx: Context<SetYieldRate>,
    new_rate: u64,
    end_timestamp: i64,
    next_rate: u64,
    next_end_timestamp: i64,
) -> Result<()> {
    let now_ts = Clock::get()?.unix_timestamp;
    let config = &mut ctx.accounts.config;
    apply_active_rate(config, new_rate, end_timestamp, now_ts)?;
    apply_successor(config, next_rate, next_end_timestamp, now_ts)
}

/// The only discrete multiplier jump, hence the only one that stamps the yield
/// lock. Halts accrual: an override admits the schedule was wrong, so the
/// operator must publish a fresh one afterwards.
pub fn set_okum_multiplier(ctx: Context<SetOkuMMultiplier>, new_multiplier: u128) -> Result<()> {
    let clock = Clock::get()?;
    let now_ts = clock.unix_timestamp;

    // Self-fence: two overrides in one slot would defeat the lock.
    check_yield_lock_with_clock(&ctx.accounts.config, &clock)?;

    let config = &mut ctx.accounts.config;
    require!(!config.is_paused, LitePsmError::Paused);

    let current = multiplier::at(config, now_ts)?;

    // Strict: a no-op override would stamp the lock without moving anything.
    require!(
        new_multiplier > current,
        LitePsmError::MultiplierCannotDecrease
    );
    require!(
        new_multiplier <= MAX_MULTIPLIER,
        LitePsmError::MultiplierTooHigh
    );

    emit_pending_cancelled_if_armed(config, now_ts);

    config.okum_base_multiplier = new_multiplier;
    config.okum_last_accrual_time = now_ts;
    halt_schedule(config);

    config.last_yield_distribution_slot = clock.slot;

    // Not best-effort: if the display cannot follow the new value the override
    // must fail, or the mirror would read against a halted schedule.
    write_display_multiplier(
        new_multiplier,
        &ctx.accounts.config,
        &ctx.accounts.oku_m_mint.to_account_info(),
        &ctx.accounts.token_2022_program.to_account_info(),
    )?;
    ctx.accounts.config.last_display_sync_ts = now_ts;

    emit!(MultiplierUpdated {
        old_multiplier: current,
        new_multiplier,
        total_supply: ctx.accounts.oku_m_mint.supply,
        timestamp: now_ts,
    });

    Ok(())
}

/// Permissionless: the written value is a pure function of on-chain state and the
/// `PsmConfig` PDA signs the CPI. Writes only `m(now)` effective immediately (no
/// pre-armed future step, which could land above canonical after a rate cut).
/// See the `display_sync` module docs. Does not stamp the yield lock.
pub fn sync_display_multiplier(ctx: Context<SyncDisplayMultiplier>) -> Result<()> {
    let now_ts = Clock::get()?.unix_timestamp;
    let current = multiplier::at(&ctx.accounts.config, now_ts)?;

    write_display_multiplier(
        current,
        &ctx.accounts.config,
        &ctx.accounts.oku_m_mint.to_account_info(),
        &ctx.accounts.token_2022_program.to_account_info(),
    )?;

    ctx.accounts.config.last_display_sync_ts = now_ts;

    emit!(DisplayMultiplierSynced {
        multiplier: current,
        timestamp: now_ts,
    });

    Ok(())
}
