//! Rate-schedule instructions — the streaming accrual writer set.
//!
//! The multiplier is a continuous function of time, so these instructions
//! carry no economic event: they merely change the *slope* of a curve, always
//! at a bounded, pre-announced instant. There is no discrete tick for a
//! searcher to straddle, and correspondingly no "distribute N dollars"
//! primitive — under rear-facing epochs the operator measures realised yield
//! off-chain and derives a *rate*.
//!
//! ## The writer set
//!
//! | Instruction | EVM counterpart |
//! |---|---|
//! | `set_okum_yield_rate` | `OkuMoney.setOkuMYieldRate` |
//! | `set_next_okum_yield_rate` | `OkuMoney.setNextOkuMYieldRate` |
//! | `set_okum_yield_rate_with_successor` | `OkuMoney.setOkuMYieldRateWithSuccessor` |
//! | `set_okum_multiplier` (emergency) | `OkuMoney.setOkuMMultiplier` |
//! | `sync_display_multiplier` | *(none — SVM-specific display mirror)* |
//!
//! Every write re-snapshots `okum_base_multiplier` at the current computed
//! value first, so accrual is continuous across the write and no yield is
//! ever created or destroyed by re-scheduling.

use crate::contexts::{SetOkuMMultiplier, SetYieldRate, SyncDisplayMultiplier};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::display_sync::write_display_multiplier;
use crate::helpers::{check_yield_lock, multiplier};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::{MAX_MULTIPLIER, MAX_RATE, MAX_RATE_WINDOW_SECONDS, PRECISION};

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

/// Validate a `(rate, end_timestamp)` pair against the rails EVM enforces in
/// `OkuMoney._setOkuMYieldRate`.
///
/// The two asymmetric rules are the important ones:
///
/// - **A yielding rate MUST carry a window**, or the rate would end whenever
///   an operator happened to land a transaction — a per-chain,
///   transaction-dependent moment, i.e. the cross-chain divergence streaming
///   accrual exists to eliminate.
/// - **A halted rate MUST NOT carry one**; it would be meaningless and would
///   put branch 1 of `compute_multiplier` into its defensive fallback.
fn validate_rate_window(rate: u64, end_timestamp: i64, now_ts: i64) -> Result<()> {
    let rate = rate as u128;

    // Monotonicity: the multiplier can never decrease, so a sub-unity rate is
    // not representable. There is no on-chain representation of a loss.
    require!(rate >= PRECISION, LitePsmError::InvalidRate);
    require!(rate <= MAX_RATE, LitePsmError::RateTooHigh);

    if rate == PRECISION {
        // Halting.
        require!(end_timestamp == 0, LitePsmError::EndTimestampNotAllowed);
    } else {
        // Yielding.
        require!(end_timestamp > now_ts, LitePsmError::EndTimestampInPast);
        // Enforces the bound `MAX_RATE`'s own doc claims the window provides.
        // Without it, a single long window can drive `rpow` past 256 bits and
        // brick every recovery path — see `MAX_RATE_WINDOW_SECONDS`.
        require!(
            end_timestamp.saturating_sub(now_ts) <= MAX_RATE_WINDOW_SECONDS,
            LitePsmError::RateWindowTooLong
        );
    }

    Ok(())
}

/// Re-snapshot the base multiplier at `now_ts` so accrual is continuous across
/// a schedule write.
///
/// EVM does the same in `OkuMoney._setOkuMYieldRate`. Skipping this would
/// either strand or double-count everything accrued since the last anchor.
fn reanchor(config: &mut PsmConfig, now_ts: i64) -> Result<u128> {
    let snapshot = multiplier::at(config, now_ts)?;
    config.okum_base_multiplier = snapshot;
    config.okum_last_accrual_time = now_ts;
    Ok(snapshot)
}

/// Reject a rate INCREASE while the protocol is paused.
///
/// Decreases — including halting outright — stay available while paused,
/// because that is the incident-response lever and must never be blocked by
/// the incident itself. Inflating the multiplier while users cannot exit is
/// the thing being prevented.
///
/// Compares against the EFFECTIVE rate, not the stored one. Once the active
/// window has closed the stored rate is stale and higher than what is actually
/// accruing, so comparing against storage would let an operator dress an
/// increase up as a decrease. EVM closes the same hole in
/// `OkuMoney._setOkuMYieldRate`.
fn check_pause_gate(config: &PsmConfig, new_rate: u64, now_ts: i64) -> Result<()> {
    if config.is_paused && (new_rate as u128) > multiplier::effective_rate(config, now_ts) {
        return err!(LitePsmError::Paused);
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Private writers
// ---------------------------------------------------------------------------
//
// These two mirror `OkuMoney._setOkuMYieldRate` and `_setNextOkuMYieldRate`.
// Keeping them as separate writers that each perform their OWN validation,
// pause gate, and write is not stylistic: it is what makes
// `set_okum_yield_rate_with_successor` behave identically to EVM, where the
// atomic setter is literally the two private helpers called in sequence.
//
// Do NOT merge them into a single validate-everything-then-write pass. The
// successor's checks MUST see the active rate's write, otherwise:
//
//   1. `withSuccessor(PRECISION, 0, rate, end)` is accepted, where EVM's
//      second helper reads `rateEnd == 0` and reverts `NoRateEndSet` — a
//      successor to a halted rate is meaningless.
//   2. While paused, the successor's gate compares against the OLD effective
//      rate instead of the rate just written, so `withSuccessor(3%, .., 4%,
//      ..)` from a 5% baseline slips a rate INCREASE past the gate.

/// Write the active rate and its window, clearing any armed successor.
///
/// Mirrors EVM `OkuMoney._setOkuMYieldRate`.
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
    // A new active window invalidates any successor staged against the old one.
    config.okum_pending_rate_per_second = PRECISION as u64;
    config.okum_pending_rate_end = 0;

    emit!(YieldRateUpdated {
        old_rate,
        new_rate,
        rate_end: end_timestamp,
        base_multiplier: snapshot,
        timestamp: now_ts,
    });

    Ok(())
}

/// Stage the successor that takes over at the CURRENT `okum_rate_end`.
///
/// Reads `config.okum_rate_end` rather than taking it as a parameter — that is
/// precisely what makes the atomic path see the active rate's write.
///
/// Mirrors EVM `OkuMoney._setNextOkuMYieldRate`.
fn apply_successor(
    config: &mut PsmConfig,
    new_rate: u64,
    pending_end_timestamp: i64,
    now_ts: i64,
) -> Result<()> {
    let rate = new_rate as u128;
    require!(rate >= PRECISION, LitePsmError::InvalidRate);
    require!(rate <= MAX_RATE, LitePsmError::RateTooHigh);

    let rate_end = config.okum_rate_end;
    // A successor only means anything relative to a live active window. This is
    // also what rejects "halt AND arm a successor" in the atomic path.
    require!(rate_end != 0, LitePsmError::NoRateEndSet);
    // Staging against an already-expired window would snapshot unearned yield.
    require!(now_ts < rate_end, LitePsmError::RateAlreadyExpired);
    require!(
        pending_end_timestamp > rate_end,
        LitePsmError::PendingEndNotAfterRateEnd
    );
    // The successor's OWN window is [rate_end, pending_end_timestamp] — the
    // span branch 3 of `compute_multiplier` hands to a single `rpow` — so it is
    // bounded independently of the active window. Two chained 90-day windows
    // are two bounded `rpow` calls, not one 180-day call.
    require!(
        pending_end_timestamp.saturating_sub(rate_end) <= MAX_RATE_WINDOW_SECONDS,
        LitePsmError::RateWindowTooLong
    );

    // Compares against the effective rate AFTER any active-rate write in this
    // same instruction — see the module note above.
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

/// Emit `PendingRateCancelled` if a successor was armed and is about to be
/// discarded or replaced.
///
/// Cross-chain monitoring reconstructs schedule history from events, so
/// silently dropping an armed successor would make a chain look like it still
/// has one staged.
///
/// Past `rate_end` the successor has already ACTIVATED — it is the rate now
/// accruing — so replacing it is not a cancellation. Without that guard every
/// re-anchor after a window elapsed (routine, not an edge case) would emit a
/// spurious cancellation. Matches
/// `OkuMoney._emitPendingRateCancelledIfArmed`.
fn emit_pending_cancelled_if_armed(config: &PsmConfig, now_ts: i64) {
    if (config.okum_pending_rate_per_second as u128) <= PRECISION || config.okum_rate_end == 0 {
        return;
    }
    if now_ts >= config.okum_rate_end {
        return;
    }
    emit!(PendingRateCancelled {
        cancelled_rate: config.okum_pending_rate_per_second,
        cancelled_pending_rate_end: config.okum_pending_rate_end,
        timestamp: now_ts,
    });
}

// ---------------------------------------------------------------------------
// set_okum_yield_rate
// ---------------------------------------------------------------------------

/// Set the active per-second rate and its window.
///
/// Re-anchors the base multiplier first, so the switch is continuous. Clears
/// any armed successor: a fresh active rate invalidates a successor that was
/// staged against the old window.
///
/// Mirrors EVM `OkuMoney.setOkuMYieldRate`.
pub fn set_okum_yield_rate(
    ctx: Context<SetYieldRate>,
    new_rate: u64,
    end_timestamp: i64,
) -> Result<()> {
    let now_ts = Clock::get()?.unix_timestamp;
    apply_active_rate(&mut ctx.accounts.config, new_rate, end_timestamp, now_ts)
}

// ---------------------------------------------------------------------------
// set_next_okum_yield_rate
// ---------------------------------------------------------------------------

/// Pre-stage the successor rate that takes over at `okum_rate_end`.
///
/// Makes cross-chain epoch handovers free: the successor activates off the
/// ABSOLUTE `okum_rate_end` inside the multiplier computation, not off a
/// transaction, so staging may land on different chains days apart and still
/// activate simultaneously to the second.
///
/// Deliberately does NOT re-anchor: the active rate and its window are
/// untouched, so there is nothing to snapshot.
///
/// Mirrors EVM `OkuMoney.setNextOkuMYieldRate`.
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

// ---------------------------------------------------------------------------
// set_okum_yield_rate_with_successor
// ---------------------------------------------------------------------------

/// Set the active rate and its successor atomically.
///
/// The instruction the epoch orchestrator uses. Both writes must be in one
/// transaction: the settlement-window handover re-anchors at the SAME rate
/// (exactly skew-free) while arming the next epoch's base rate, and splitting
/// it would leave a window in which one chain has the successor and another
/// does not.
///
/// Composition order is load-bearing: `apply_successor` reads the
/// `okum_rate_end` that `apply_active_rate` just wrote. See the module note
/// above the private writers.
///
/// Mirrors EVM `OkuMoney.setOkuMYieldRateWithSuccessor`.
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

// ---------------------------------------------------------------------------
// set_okum_multiplier (emergency override)
// ---------------------------------------------------------------------------

/// Emergency: force the multiplier to an explicit value.
///
/// The ONLY instruction that produces a discrete multiplier jump, and
/// therefore the only one that engages the sandwich lock. For incident
/// response — correcting a mis-derived schedule that has already accrued, or
/// re-anchoring a chain that fell out of step — not routine operation.
///
/// Halts accrual as a side effect: an explicit override is an admission that
/// the schedule was wrong, so continuing to run it would be incoherent. The
/// operator must publish a fresh schedule afterwards.
///
/// Mirrors EVM `OkuMoney.setOkuMMultiplier`.
pub fn set_okum_multiplier(ctx: Context<SetOkuMMultiplier>, new_multiplier: u128) -> Result<()> {
    // Self-fence: two overrides in one slot would defeat the lock.
    check_yield_lock(&ctx.accounts.config)?;

    let clock = Clock::get()?;
    let now_ts = clock.unix_timestamp;
    let config = &mut ctx.accounts.config;

    // Pause DOES gate this lever — a discrete value move is a state-effect
    // and must freeze alongside transfers during an incident, rather than
    // remaining live while everything else is halted. Exact parity with EVM's
    // `setOkuMMultiplier`, which carries `whenNotPaused`.
    require!(!config.is_paused, LitePsmError::Paused);

    let current = multiplier::at(config, now_ts)?;

    // Strict increase. A no-op override would stamp the sandwich lock without
    // moving anything, burning a slot of PSM availability for free.
    require!(
        new_multiplier > current,
        LitePsmError::MultiplierCannotDecrease
    );
    require!(
        new_multiplier <= MAX_MULTIPLIER,
        LitePsmError::MultiplierAboveMax
    );

    emit_pending_cancelled_if_armed(config, now_ts);

    config.okum_base_multiplier = new_multiplier;
    config.okum_last_accrual_time = now_ts;
    // Halt: see fn-level doc.
    config.okum_rate_per_second = PRECISION as u64;
    config.okum_rate_end = 0;
    config.okum_pending_rate_per_second = PRECISION as u64;
    config.okum_pending_rate_end = 0;

    config.last_yield_distribution_slot = clock.slot;

    // Force-sync the display mirror, effective immediately. This is a
    // correctness step, not a nicety, and is NOT best-effort: if the display
    // cannot be brought to the new canonical value, the override must not
    // proceed, or the mirror would be left reading against a halted schedule.
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

// ---------------------------------------------------------------------------
// sync_display_multiplier
// ---------------------------------------------------------------------------

/// Refresh the wallet-facing display mirror. **Permissionless.**
///
/// Safe and deliberate: the written value is fully determined by on-chain
/// state, so a caller has no degrees of freedom to abuse, and the `PsmConfig`
/// PDA signs the CPI rather than the caller. Rebaser-gating this would make
/// display freshness an operator-liveness dependency for no security gain.
///
/// Writes ONE point: the canonical multiplier as of now, effective
/// immediately. The display is therefore a pure lag — a staircase that steps
/// up at each crank and is flat in between, always at or below canonical.
///
/// ## Why there is no pre-armed next step
///
/// A step armed for a future timestamp fires under whatever schedule is live
/// when that timestamp arrives. After a rate DECREASE — routine at an epoch
/// roll, where the settlement rate is usually lower than the base rate — a
/// value computed from the old, faster curve lands ABOVE the new canonical
/// value, the one direction the mirror must never take. (Measured worst
/// cases: ~$0.25 per $1M for a 20%→5% roll, ~$6 per $1M for `MAX_RATE`→halt.)
///
/// The alternative fix — having every rate write re-sync the display — would
/// put the mint back into `SetYieldRate`, re-coupling the one instruction that
/// must land reliably at epoch boundaries to the token program. Writing only
/// an immediate point instead makes the invariant unconditional and drops any
/// dependency on Token-2022's future-timestamp resolve semantics.
///
/// The cost: if the crank stops the display freezes rather than advancing one
/// more step. That is stale-LOW, which is safe, and nothing prices against it.
///
/// Does NOT stamp the sandwich lock — see `PsmConfig::last_yield_distribution_slot`.
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
