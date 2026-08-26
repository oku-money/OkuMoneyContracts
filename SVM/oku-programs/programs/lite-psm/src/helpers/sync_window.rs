//! Post-step multiplier sync window — Anchor bindings.
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
//! # Auto-arm only
//!
//! Every multiplier write arms the lock; nothing but the clock releases
//! it. There is no open/close protocol, no epoch, and no inter-window gap.
//!
//! The epoch protocol this replaced existed to make "a tick completed on
//! every chain" externally verifiable, and it never actually did: equal
//! epochs proved both chains *wrote*, never that they wrote the same
//! VALUE. Parity is now checked off-chain against the multiplier values
//! directly (`scripts/admin/check-sync-parity.ts`), which is strictly
//! stronger and needs no on-chain bookkeeping. Everything the epoch
//! required in turn — a `last_write_epoch` attestation so a window could
//! not be opened and closed empty, an anti-grief gap so windows could not
//! be chained — went with it. Arming on the write makes the fence and the
//! tick the same transaction, so there is no unfenced-tick case to guard
//! against in the first place.
//!
//! # What it does not defend
//!
//! Local step arbitrage — see the scope note in
//! [`crate::helpers::yield_lock`]. That is the `tin + tout` fee's job, via
//! [`oku_shared::step_coverage`].

use crate::errors::LitePsmError;
use crate::state::PsmConfig;
use anchor_lang::prelude::*;
use oku_shared::{sync_window_end, sync_window_engaged, MAX_SYNC_WINDOW_SECS};

/// Reject price-sensitive operations while a multiplier step is
/// propagating across chains.
///
/// Call this alongside — not instead of — [`crate::helpers::check_yield_lock`].
/// The two guard different properties in different units and neither
/// subsumes the other: the yield lock is a same-slot atomic-re-entry fence
/// measured in slots, this is a multi-second propagation window measured
/// in wall-clock seconds.
pub fn check_sync_window(config: &PsmConfig) -> Result<()> {
    let clock = Clock::get()?;
    require!(
        !sync_window_engaged(config.sync_lock_until_ts, clock.unix_timestamp),
        LitePsmError::SyncWindowActive
    );
    Ok(())
}

/// Arm the window from the multiplier-write path.
///
/// Returns `true` if the window was armed.
///
/// # Assign, never extend
///
/// The lock end is overwritten with `now + sync_window_secs` rather than
/// pushed out from its previous value. That is what makes the
/// `MAX_SYNC_WINDOW_SECS` bound hold by construction rather than by
/// argument: no sequence of writes, however adversarial, can stack a
/// window past the ceiling. A compromised rebaser looping writes still
/// re-arms only for one window length at a time — and cannot write at all
/// without taking a real, fee-covered, `MAX_STEP_BPS`-bounded step, which
/// is a far louder and more self-limiting action than holding a lock open.
pub fn arm_sync_window(config: &mut PsmConfig, now_ts: i64) -> bool {
    // Inert configuration: write nothing at all, so a disabled window
    // never emits an event for a lock that blocks nothing — noise an
    // alert rule would otherwise have to special-case.
    if config.sync_window_secs == 0 {
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
