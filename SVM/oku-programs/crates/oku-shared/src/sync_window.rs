//! Pure cross-chain multiplier-sync-window primitives.
//!
//! # What this is for
//!
//! A multiplier tick is not atomic across chains. Between the EVM write
//! and the SVM write, the two sides disagree on the price of a raw token,
//! and any instruction that converts value *through* the multiplier during
//! that interval transacts at a stale price on one side. The sync window
//! is a bounded, auto-expiring, epoch-attested block on exactly those
//! instructions.
//!
//! # What this is NOT for
//!
//! This does not prevent *local* step arbitrage — minting at `M0`, holding
//! across a discrete step, and redeeming at `M1`. That attack does not
//! require transacting during the window, so widening the window does not
//! deter it; it only lengthens the attacker's holding period. The fee
//! (`tout`) is the mechanism for that. Keeping the two concerns separate
//! is deliberate: one is spatial (cross-chain divergence), the other is
//! temporal (discontinuity in time).
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

/// Return `true` when enough wall-clock time has elapsed since the end of
/// the previous window for a new one to be armed.
///
/// `last_lock_until_ts` is the end of the most recent window — which is
/// the same storage field the engagement check reads, so no separate
/// "last window end" field is needed. An early release truncates that
/// field to `now` rather than zeroing it, precisely so it remains a valid
/// gap anchor.
///
/// # Why callers must not turn a `false` here into an error
///
/// On the multiplier-write path a `false` means "write, but do not re-arm
/// the window". It must never mean "reject the write". Rejecting would
/// make the multiplier setter censorable by anyone who can open a window,
/// inverting the trust model — the EVM side documents `setYieldRate` as
/// deliberately un-gated so an operator can zero the rate during an
/// incident. Only the explicit `begin_sync_window` entrypoint treats a
/// `false` as a hard error.
#[inline]
pub const fn sync_window_gap_elapsed(
    last_lock_until_ts: i64,
    now_ts: i64,
    min_gap_secs: i64,
) -> bool {
    // Never-armed sentinel: the first window must be openable immediately.
    //
    // Checked explicitly rather than left to the arithmetic. Without it the
    // first window could not open until `min_gap_secs` past the Unix epoch —
    // unreachable on a real cluster, which is precisely what would make it a
    // latent trap, surfacing only on a fresh local validator whose clock
    // starts near zero.
    if last_lock_until_ts == 0 {
        return true;
    }
    // Saturating: `last_lock_until_ts` is bounded by a real timestamp plus
    // `MAX_SYNC_WINDOW_SECS` in practice, but a corrupt or adversarial
    // value near `i64::MAX` must not wrap into a spuriously-elapsed gap.
    now_ts >= last_lock_until_ts.saturating_add(min_gap_secs)
}

/// Compute the (exclusive) end timestamp for a window of `window_secs`
/// opened at `now_ts`, saturating rather than wrapping.
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
    use crate::constants::{MAX_SYNC_WINDOW_SECS, MIN_SYNC_WINDOW_GAP_SECS};

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
        // The "ships inert" property, stated as an assertion rather than a
        // comment. A zero-length window must block NOTHING — not even the
        // second it was armed in. An inclusive upper bound would fail this
        // and silently gate the remainder of the current second, which
        // spans many slots.
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

    // ---- gap ----

    #[test]
    fn gap_elapsed_from_zero_sentinel() {
        // First window after init must be openable immediately — including on
        // a chain whose clock starts near zero, which is why the sentinel is
        // explicit rather than incidental to the arithmetic.
        assert!(sync_window_gap_elapsed(0, NOW, MIN_SYNC_WINDOW_GAP_SECS));
        assert!(sync_window_gap_elapsed(0, 1, MIN_SYNC_WINDOW_GAP_SECS));
        assert!(sync_window_gap_elapsed(0, 0, MIN_SYNC_WINDOW_GAP_SECS));
    }

    #[test]
    fn gap_not_elapsed_immediately_after_a_window() {
        let end = sync_window_end(NOW, MAX_SYNC_WINDOW_SECS);
        assert!(!sync_window_gap_elapsed(
            end,
            end + 1,
            MIN_SYNC_WINDOW_GAP_SECS
        ));
    }

    #[test]
    fn gap_boundary_is_inclusive() {
        let end = sync_window_end(NOW, 0);
        let exactly = end + MIN_SYNC_WINDOW_GAP_SECS;
        assert!(!sync_window_gap_elapsed(
            end,
            exactly - 1,
            MIN_SYNC_WINDOW_GAP_SECS
        ));
        assert!(sync_window_gap_elapsed(
            end,
            exactly,
            MIN_SYNC_WINDOW_GAP_SECS
        ));
    }

    #[test]
    fn gap_does_not_wrap_near_i64_max() {
        // The property that matters: a corrupt or adversarial
        // `last_lock_until` near `i64::MAX` must not wrap into a small
        // sum and thereby report the gap as elapsed at a realistic
        // `now`. Were `saturating_add` swapped for `+` in a release
        // build, this would wrap negative and pass the `>=`.
        assert!(!sync_window_gap_elapsed(
            i64::MAX,
            NOW,
            MIN_SYNC_WINDOW_GAP_SECS
        ));
        assert!(!sync_window_gap_elapsed(
            i64::MAX - 1,
            NOW,
            MIN_SYNC_WINDOW_GAP_SECS
        ));
        // Terminal behaviour, asserted so it is a decision rather than an
        // accident: once `last + gap` saturates at `i64::MAX`, only
        // `now == i64::MAX` clears the gap. That is year ~292277026596,
        // so it is unreachable rather than exploitable — and it fails
        // *closed* for every timestamp below it, which is the safe
        // direction.
        assert!(sync_window_gap_elapsed(
            i64::MAX - 1,
            i64::MAX,
            MIN_SYNC_WINDOW_GAP_SECS
        ));
        assert!(!sync_window_gap_elapsed(
            i64::MAX - 1,
            i64::MAX - 1,
            MIN_SYNC_WINDOW_GAP_SECS
        ));
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

    /// The availability floor claimed in the constants documentation is
    /// arithmetic, so assert it rather than trusting the comment: a
    /// worst-case duty cycle of one maximal window per minimal gap must
    /// leave redemption open at least 96% of the time.
    #[test]
    fn availability_floor_holds() {
        let cycle = MIN_SYNC_WINDOW_GAP_SECS + MAX_SYNC_WINDOW_SECS;
        let open = MIN_SYNC_WINDOW_GAP_SECS;
        assert!(open * 100 / cycle >= 96);
    }
}
