//! Pure cross-chain multiplier-sync-window primitives.
//!
//! # What this is for
//!
//! A multiplier tick is not atomic across chains. Between the EVM write
//! and the SVM write, the two sides disagree on the price of a raw token,
//! and any instruction that converts value *through* the multiplier during
//! that interval transacts at a stale price on one side. The sync window
//! is a bounded, auto-expiring lock on exactly those instructions, armed
//! by every multiplier write and released by nothing but the clock.
//!
//! There is no open/close protocol and no on-chain attestation of the
//! peer chain's state: whether both chains actually landed a tick is
//! verified off-chain by comparing the multiplier VALUES directly
//! (`scripts/admin/check-sync-parity.ts`).
//!
//! # What this is NOT for
//!
//! This does not prevent *local* step arbitrage — minting at `M0`, holding
//! across a discrete step, and redeeming at `M1`. That attack does not
//! require transacting during the window, so widening the window does not
//! deter it; it only lengthens the attacker's holding period. The fees
//! (`tin + tout`, see [`crate::step_coverage`]) are the mechanism for
//! that. Keeping the two concerns separate is deliberate: one is spatial
//! (cross-chain divergence), the other is temporal (discontinuity in
//! time).
//!
//! # Relationship to the yield lock
//!
//! [`crate::yield_lock`] is a *same-slot* atomic-re-entry fence and is
//! untouched by this module. The two mechanisms coexist because they
//! operate in different units for good reason: the yield lock compares
//! slots (atomicity is a slot-level property), the sync window compares
//! wall-clock seconds (propagation is a wall-clock property, and slot
//! times stretch under exactly the congestion that slows propagation).
//!
//! No `anchor-lang`, no `solana-program`, no I/O — by design. Callers
//! resolve `Clock::get()?.unix_timestamp` themselves and pass it in.

/// Return `true` while the sync window is engaged, i.e. a multiplier tick
/// is in flight and price-sensitive instructions must be rejected.
///
/// # Exclusive upper bound
///
/// `lock_until_ts` is the first timestamp at which the window is *no
/// longer* engaged, so a window of `N` seconds blocks exactly `N` distinct
/// second-values. This is deliberate and load-bearing, not a rounding
/// preference:
///
/// An inclusive bound would make a *zero-length* window block for the
/// remainder of the current second. Since a second spans many slots, that
/// silently turns "window disabled" into "window blocks the rest of this
/// second", which is a behaviour change rather than a no-op. With an
/// exclusive bound `sync_window_end(now, 0) == now` and
/// `sync_window_engaged(now, now) == false`, so a zero-length window is
/// genuinely inert.
///
/// The one-second boundary this gives up is immaterial: real windows are
/// tens of seconds, sized from cross-chain propagation, and the
/// same-second atomicity case is already covered by the independent
/// same-slot yield fence.
///
/// The `lock_until_ts == 0` initialization sentinel is never engaged for
/// any real Unix timestamp, so a freshly initialized config — and any
/// deployment that never configures a window — behaves exactly as if this
/// mechanism did not exist.
#[inline]
pub const fn sync_window_engaged(lock_until_ts: i64, now_ts: i64) -> bool {
    now_ts < lock_until_ts
}

/// Compute the (exclusive) end timestamp for a window of `window_secs`
/// armed at `now_ts`, saturating rather than wrapping.
///
/// Returns `now_ts` itself when `window_secs == 0`, which combined with
/// the exclusive bound in [`sync_window_engaged`] means a zero-length
/// window blocks nothing at all.
#[inline]
pub const fn sync_window_end(now_ts: i64, window_secs: i64) -> i64 {
    now_ts.saturating_add(window_secs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::MAX_SYNC_WINDOW_SECS;

    // A representative "now" well clear of the zero sentinel.
    const NOW: i64 = 1_800_000_000;

    // ---- engagement ----

    #[test]
    fn engaged_strictly_inside_window() {
        let end = sync_window_end(NOW, 60);
        assert!(sync_window_engaged(end, NOW));
        assert!(sync_window_engaged(end, NOW + 30));
        // Last engaged second.
        assert!(sync_window_engaged(end, end - 1));
    }

    #[test]
    fn disengaged_on_the_exclusive_boundary() {
        // `lock_until` is the first NON-blocked timestamp, so a 60s window
        // blocks exactly 60 second-values: NOW ..= NOW+59.
        let end = sync_window_end(NOW, 60);
        assert!(!sync_window_engaged(end, end));
        assert!(!sync_window_engaged(end, end + 1));
    }

    #[test]
    fn window_blocks_exactly_n_seconds() {
        for n in [1i64, 2, 60, 900] {
            let end = sync_window_end(NOW, n);
            let blocked = (NOW..=NOW + n + 1)
                .filter(|t| sync_window_engaged(end, *t))
                .count() as i64;
            assert_eq!(blocked, n, "window of {n}s blocked {blocked} seconds");
        }
    }

    #[test]
    fn disengaged_at_zero_sentinel() {
        // Freshly initialized config: never engaged for a real timestamp.
        assert!(!sync_window_engaged(0, NOW));
        assert!(!sync_window_engaged(0, 1));
        assert!(!sync_window_engaged(0, 0));
    }

    #[test]
    fn zero_window_is_completely_inert() {
        // The "window disabled" property, stated as an assertion rather
        // than a comment. A zero-length window must block NOTHING — not
        // even the second it was armed in. An inclusive upper bound would
        // fail this and silently gate the remainder of the current second,
        // which spans many slots.
        let end = sync_window_end(NOW, 0);
        assert_eq!(end, NOW);
        // Not engaged at the arming instant, nor at any later instant.
        // (A `now` *earlier* than the arming instant is not asserted
        // because it is unreachable — the clock does not run backwards
        // between arming and checking.)
        assert!(!sync_window_engaged(end, NOW));
        assert!(!sync_window_engaged(end, NOW + 1));
        assert!(!sync_window_engaged(end, NOW + 10_000));
    }

    #[test]
    fn rearming_extends_but_never_exceeds_window_from_now() {
        // Back-to-back writes each re-arm from their own `now`, so the
        // lock horizon is always `now + window_secs` and never accumulates
        // beyond it. A compromised rebaser looping writes therefore holds
        // the lock only for as long as it keeps paying for writes, and the
        // horizon is bounded by `MAX_SYNC_WINDOW_SECS` past the last one.
        let first = sync_window_end(NOW, MAX_SYNC_WINDOW_SECS);
        let second = sync_window_end(NOW + 10, MAX_SYNC_WINDOW_SECS);
        assert!(second > first);
        assert_eq!(second - (NOW + 10), MAX_SYNC_WINDOW_SECS);
    }

    // ---- end computation ----

    #[test]
    fn window_end_does_not_wrap_near_i64_max() {
        assert_eq!(sync_window_end(i64::MAX, 1), i64::MAX);
        assert_eq!(
            sync_window_end(i64::MAX - 1, MAX_SYNC_WINDOW_SECS),
            i64::MAX
        );
    }
}
