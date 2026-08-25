//! Cross-chain multiplier sync window — Anchor bindings.
//!
//! The pure timestamp comparisons live in `oku_shared::sync_window`; this
//! module is the Anchor-error mapping plus the `Clock::get()` sysvar read,
//! mirroring the `yield_lock` split.
//!
//! # What it defends
//!
//! A multiplier tick is not atomic across chains. Between the EVM write
//! and the SVM write the two sides price a raw token differently, so any
//! instruction converting value *through* the multiplier in that interval
//! settles at a stale price on one side. This blocks exactly those
//! instructions — `mint_oku_m` and `redeem_oku_m` — for the duration.
//!
//! Instructions that move raw tokens or USDC *without* consulting the
//! multiplier are deliberately left open: the direct mint/burn bridge legs
//! conserve raw 1:1 and never price, buffer deposit/withdraw move USDC at
//! par, and blocking any of them would only obstruct the orchestrator's
//! own recovery paths mid-tick. The rule is one line: **gated iff the
//! instruction converts value through the multiplier.**
//!
//! # What it does not defend
//!
//! Local step arbitrage — see the scope note in
//! [`crate::helpers::yield_lock`]. That is the `tout` fee's job.

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::{
    sync_window_end, sync_window_engaged, sync_window_gap_elapsed, MAX_SYNC_WINDOW_SECS,
    MIN_SYNC_WINDOW_GAP_SECS,
};

/// Reject price-sensitive operations while a cross-chain multiplier tick
/// is in flight.
///
/// Call this alongside — not instead of — [`crate::helpers::check_yield_lock`].
/// The two guard different properties in different units and neither
/// subsumes the other.
pub fn check_sync_window(config: &PsmConfig) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        !sync_window_engaged(config.sync_lock_until_ts, clock.unix_timestamp),
        LitePsmError::SyncWindowActive
    );
    Ok(())
}

/// Arm the window from the multiplier-write path, honouring the
/// inter-window gap.
///
/// Returns `true` if the window was armed.
///
/// # Clamp, never revert
///
/// If the gap has not elapsed this declines to re-arm and returns `false`
/// — it does **not** error. A multiplier write must never be blockable by
/// window state, because that would let anyone able to open a window
/// censor the rebaser, and the EVM twin (`OkuDollar.setYieldRate`) is
/// explicitly documented as un-gated so an operator can zero the rate
/// during an incident. The gap bound still holds: an attacker looping
/// `set_multiplier(current + 1)` gets at most one window per gap period,
/// preserving the availability floor.
pub fn arm_sync_window(config: &mut PsmConfig, now_ts: i64) -> bool {
    // Inert configuration: write nothing at all.
    //
    // Returning early rather than falling through to a zero-length window
    // matters for more than the (already inert) engagement check —
    // `sync_lock_until_ts` doubles as the inter-window gap anchor, so
    // arming here would move that anchor on every multiplier write and
    // could then reject a later explicit `begin_sync_window` for up to
    // `MIN_SYNC_WINDOW_GAP_SECS` after the operator enables the feature.
    // It would also emit a `SyncWindowOpened` event for a window that
    // blocks nothing, which is noise an alert rule would have to special-case.
    if config.sync_window_secs == 0 {
        return false;
    }
    if !sync_window_gap_elapsed(config.sync_lock_until_ts, now_ts, MIN_SYNC_WINDOW_GAP_SECS) {
        return false;
    }
    config.sync_lock_until_ts = sync_window_end(now_ts, config.sync_window_secs);
    true
}

/// Validate a proposed `sync_window_secs` against the compile-time
/// ceiling. Rejects negatives, which would otherwise produce a window end
/// in the past and silently disable arming.
pub fn validate_sync_window_secs(secs: i64) -> Result<()> {
    require!(
        (0..=MAX_SYNC_WINDOW_SECS).contains(&secs),
        LitePsmError::SyncWindowTooLong
    );
    Ok(())
}
