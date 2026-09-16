//! Rate-schedule instructions — the streaming accrual writer set.
//!
//! ## What changed, and why
//!
//! This used to be a two-instruction discrete model: `set_multiplier` wrote a
//! new scalar, and `distribute_yield` bumped the scalar by
//! `yield_amount * PRECISION / total_supply`. Both wrote directly into the
//! mint's `ScaledUiAmountConfig`.
//!
//! That model is gone. It had the flaw EVM's refactor set out to remove: a
//! discrete jump in the multiplier is a riskless, perfectly-predictable profit
//! for anyone who mints immediately before it and redeems immediately after.
//! Widening the sandwich lock cannot fix this — the searcher only has to
//! straddle the tick by one slot on each side.
//!
//! Under streaming accrual there is no tick to straddle. The multiplier is a
//! continuous function of time, so the operator's transactions carry no
//! economic event at all: they merely change the *slope* of a curve, always at
//! a bounded, pre-announced instant.
//!
//! `distribute_yield` has no successor here. Under rear-facing epochs the
//! operator measures realised yield off-chain and derives a *rate*; there is
//! no on-chain "distribute N dollars" primitive to port.
//!
//! ## The writer set
//!
//! | Instruction | EVM counterpart |
//! |---|---|
//! | `set_okum_yield_rate` | `OkuMoney.setOkuMYieldRate` (`:389`) |
//! | `set_next_okum_yield_rate` | `OkuMoney.setNextOkuMYieldRate` (`:499`) |
//! | `set_okum_yield_rate_with_successor` | `OkuMoney.setOkuMYieldRateWithSuccessor` (`:558`) |
//! | `set_okum_multiplier` (emergency) | `OkuMoney.setOkuMMultiplier` (`:587`) |
//! | `sync_display_multiplier` | *(none — SVM-specific display mirror)* |
//!
//! Every write re-snapshots `okum_base_multiplier` at the current computed
//! value first, so accrual is continuous across the write and no yield is
//! ever created or destroyed by re-scheduling.

use crate::contexts::{SetOkuMMultiplier, SetYieldRate, SyncDisplayMultiplier};
use crate::errors::LitePsmError;
use crate::events::*;
use crate::helpers::display_sync::{
    write_display_multiplier, DISPLAY_SYNC_INTERVAL,
};
use crate::helpers::{check_yield_lock, multiplier};
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::{MAX_MULTIPLIER, MAX_RATE, PRECISION};

// ---------------------------------------------------------------------------
// Shared validation
// ---------------------------------------------------------------------------

/// Validate a `(rate, end_timestamp)` pair against the rails EVM enforces at
/// `OkuMoney.sol:401-406`.
///
/// The two asymmetric rules are the important ones:
///
/// - **A yielding rate MUST carry a window.** Without it the rate would end
///   whenever an operator happened to land a transaction — a per-chain,
///   transaction-dependent moment, which is precisely the cross-chain
///   divergence streaming accrual exists to eliminate.
/// - **A halted rate MUST NOT carry one.** A window against a halted rate is
///   meaningless and would put branch 1 of `compute_multiplier` into its
///   defensive fallback.
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
    }

    Ok(())
}

/// Re-snapshot the base multiplier at `now_ts` so accrual is continuous across
/// a schedule write.
///
/// EVM does the same at `OkuMoney.sol:421`. Skipping this would either strand
/// or double-count everything accrued since the last anchor.
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
/// increase up as a decrease. EVM closes the same hole at `OkuMoney.sol:420`.
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
// These two mirror `OkuMoney.sol`'s `_setOkuMYieldRate` (`:399`) and
// `_setNextOkuMYieldRate` (`:509`). Keeping them as separate writers that each
// perform their OWN validation, pause gate, and write is not stylistic: it is
// what makes `set_okum_yield_rate_with_successor` behave identically to EVM,
// where the atomic setter is literally the two private helpers called in
// sequence (`OkuMoney.sol:570-571`).
//
// An earlier version of this file validated everything up front and then wrote
// once. That looked cleaner and was wrong in two ways, both of which came from
// the successor's checks not seeing the active rate's write:
//
//   1. `withSuccessor(PRECISION, 0, rate, end)` was accepted. On EVM the second
//      helper reads `rateEnd == 0` and reverts `NoRateEndSet`, because a
//      successor to a halted rate is meaningless.
//   2. While paused, the successor's gate compared against the OLD effective
//      rate instead of the rate just written, so `withSuccessor(3%, .., 4%, ..)`
//      from a 5% baseline let a rate INCREASE through while paused — the exact
//      thing the gate exists to stop.
//
// Do not re-merge these.

/// Write the active rate and its window, clearing any armed successor.
///
/// Mirrors `EVM/src/token/OkuMoney.sol:399-427` (`_setOkuMYieldRate`).
fn apply_active_rate(config: &mut PsmConfig, new_rate: u64, end_timestamp: i64, now_ts: i64) -> Result<()> {
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
/// Mirrors `EVM/src/token/OkuMoney.sol:509-528` (`_setNextOkuMYieldRate`).
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
/// Cross-chain monitoring reconstructs each chain's schedule history from
/// events; silently dropping an armed successor would make a chain look like it
/// still has one staged. Mirrors `OkuMoney._emitPendingRateCancelledIfArmed`.
fn emit_pending_cancelled_if_armed(config: &PsmConfig, now_ts: i64) {
    if (config.okum_pending_rate_per_second as u128) > PRECISION {
        emit!(PendingRateCancelled {
            cancelled_rate: config.okum_pending_rate_per_second,
            cancelled_pending_rate_end: config.okum_pending_rate_end,
            timestamp: now_ts,
        });
    }
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
/// Mirrors `EVM/src/token/OkuMoney.sol:389-397`.
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
/// This is the instruction that makes cross-chain epoch handovers free: the
/// successor activates off the ABSOLUTE `okum_rate_end` inside the multiplier
/// computation, not off a transaction. Staging may therefore land on different
/// chains at different times — even days apart — and the activation is still
/// simultaneous to the second.
///
/// Deliberately does NOT re-anchor: the active rate and its window are
/// untouched, so there is nothing to snapshot.
///
/// Mirrors `EVM/src/token/OkuMoney.sol:499-507`.
pub fn set_next_okum_yield_rate(
    ctx: Context<SetYieldRate>,
    new_rate: u64,
    pending_end_timestamp: i64,
) -> Result<()> {
    let now_ts = Clock::get()?.unix_timestamp;
    apply_successor(&mut ctx.accounts.config, new_rate, pending_end_timestamp, now_ts)
}

// ---------------------------------------------------------------------------
// set_okum_yield_rate_with_successor
// ---------------------------------------------------------------------------

/// Set the active rate and its successor atomically.
///
/// This is the instruction the epoch orchestrator uses. Doing both writes in
/// one transaction matters because the settlement-window handover re-anchors at
/// the SAME rate — which is exactly skew-free — while simultaneously arming the
/// next epoch's base rate. Splitting it would leave a window in which one chain
/// has the successor and another does not.
///
/// Composition order is load-bearing, not incidental: `apply_successor` reads
/// the `okum_rate_end` that `apply_active_rate` just wrote. See the module note
/// above the private writers.
///
/// Mirrors `EVM/src/token/OkuMoney.sol:558-572`.
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
/// This is the ONLY instruction that produces a discrete multiplier jump, and
/// therefore the only one that engages the sandwich lock. It exists for
/// incident response — correcting a mis-derived schedule that has already
/// accrued, or re-anchoring a chain that fell out of step — not for routine
/// operation.
///
/// Halts accrual as a side effect: an explicit override is an admission that
/// the schedule was wrong, so continuing to run it would be incoherent. The
/// operator must publish a fresh schedule afterwards.
///
/// Mirrors `EVM/src/token/OkuMoney.sol:587-610`.
pub fn set_okum_multiplier(ctx: Context<SetOkuMMultiplier>, new_multiplier: u128) -> Result<()> {
    // Self-fence: two overrides in one slot would defeat the lock.
    check_yield_lock(&ctx.accounts.config)?;

    let clock = Clock::get()?;
    let now_ts = clock.unix_timestamp;
    let config = &mut ctx.accounts.config;

    // Pausing must not become a way to freeze the emergency lever.
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

    // Force-sync the display mirror, effective immediately and with NO
    // pre-arm. This is a correctness step, not a nicety: a previous sync may
    // have pre-armed a step computed under the schedule we just halted, and
    // that stale step could read ABOVE the new canonical value — the one
    // direction the mirror must never take. Writing an immediate value
    // overwrites it. Unlike the piggyback sync this is NOT best-effort: if the
    // display cannot be corrected, the override must not proceed.
    write_display_multiplier(
        new_multiplier,
        now_ts,
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
/// Permissionless is safe and deliberate: the value written is fully
/// determined by on-chain state, so a caller has no degrees of freedom to
/// abuse. The `PsmConfig` PDA signs the CPI, not the caller. Making this
/// rebaser-gated would turn display freshness into an operator liveness
/// dependency for no security gain.
///
/// Writes two points: the value NOW (effective immediately) and the value one
/// [`DISPLAY_SYNC_INTERVAL`] ahead (pre-armed at its own effective timestamp).
/// The pre-arm means the display keeps advancing for a full interval even if
/// the next crank never arrives.
///
/// ## Why two CPIs rather than one
///
/// A single write of the future value would be enough IF Token-2022's
/// processor resolves the standing `multiplier` field to
/// `current_multiplier(now)` before overwriting `new_multiplier`. That
/// behaviour lives in the processor, not in `spl-token-2022-interface`, and is
/// not yet verified here (`SVM/DECISIONS.md` D-02). If it does NOT resolve,
/// a single write would leave the display pinned to the *previous* pre-armed
/// value for a full interval — a lag of two intervals instead of one.
///
/// Two writes are correct under either semantics, so the ambiguity is not on
/// the correctness path. The cost is one extra CPI per minute.
///
/// Does NOT stamp the sandwich lock — see `PsmConfig::last_yield_distribution_slot`.
pub fn sync_display_multiplier(ctx: Context<SyncDisplayMultiplier>) -> Result<()> {
    let now_ts = Clock::get()?.unix_timestamp;

    let next_ts = now_ts
        .checked_add(DISPLAY_SYNC_INTERVAL)
        .ok_or(LitePsmError::Overflow)?;

    let current = multiplier::at(&ctx.accounts.config, now_ts)?;
    let next_multiplier = multiplier::at(&ctx.accounts.config, next_ts)?;

    let mint = ctx.accounts.oku_m_mint.to_account_info();
    let token_program = ctx.accounts.token_2022_program.to_account_info();

    // 1. Land the display exactly on the curve right now.
    write_display_multiplier(current, now_ts, &ctx.accounts.config, &mint, &token_program)?;

    // 2. Pre-arm the next step so the staircase advances unattended.
    write_display_multiplier(
        next_multiplier,
        next_ts,
        &ctx.accounts.config,
        &mint,
        &token_program,
    )?;

    ctx.accounts.config.last_display_sync_ts = now_ts;

    emit!(DisplayMultiplierSynced {
        multiplier: current,
        pre_armed_multiplier: next_multiplier,
        pre_armed_effective_ts: next_ts,
        timestamp: now_ts,
    });

    Ok(())
}
