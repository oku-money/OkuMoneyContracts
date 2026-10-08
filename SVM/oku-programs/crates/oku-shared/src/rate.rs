//! Streaming accrual: port of `EVM/src/lib/MathLib.sol`.
//!
//! The multiplier is not stored. It is a pure function of a six-field
//! [`Schedule`] and the current timestamp, so every chain holding the same
//! schedule returns the same value at the same second, and the handover to a
//! pre-staged `pending_rate` needs no transaction.
//!
//! Keep the branch structure aligned with the Solidity so the two can be
//! diffed side by side. `rpow` rounds half-up (MakerDAO); everything else floors.
//! The bounded `rpow` overflow difference versus EVM is covered in
//! `SVM/README.md` § EVM vs SVM — divergence catalogue.

use crate::constants::{MAX_MULTIPLIER, PRECISION};
use crate::wad::{mul_div_wad_floor, mul_div_wad_half_up};

/// `match`-free early return for `Option` inside `const fn` (`?` is not
/// usable in const context).
macro_rules! try_opt {
    ($e:expr) => {
        match $e {
            Some(v) => v,
            None => return None,
        }
    };
}

/// The six-field rate schedule. Timestamps are `i64` to match Solana's
/// `Clock::unix_timestamp` (EVM packs `uint48`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub struct Schedule {
    /// Multiplier snapshot taken at `last_accrual_time`. Starts at `PRECISION`.
    pub base_multiplier: u128,
    /// Active per-second rate. `PRECISION` means "no yield" (halted).
    pub rate_per_second: u128,
    /// Timestamp `base_multiplier` was snapshotted at.
    pub last_accrual_time: i64,
    /// Timestamp `rate_per_second` expires. `0` **only** when halted.
    pub rate_end: i64,
    /// Successor rate, activates at `rate_end` with no transaction.
    /// `PRECISION` means "none armed".
    pub pending_rate_per_second: u128,
    /// Successor's own expiry; bounds the overhang so an unattended successor
    /// halts rather than compounding forever. `0` = none armed.
    pub pending_rate_end: i64,
}

impl Schedule {
    /// Flat-and-halted initial state written at program init.
    pub const fn halted_at(now_ts: i64) -> Self {
        Self {
            base_multiplier: PRECISION,
            rate_per_second: PRECISION,
            last_accrual_time: now_ts,
            rate_end: 0,
            pending_rate_per_second: PRECISION,
            pending_rate_end: 0,
        }
    }

    /// Convenience wrapper over [`compute_multiplier`].
    #[inline]
    pub fn multiplier_at(&self, now_ts: i64) -> Option<u128> {
        compute_multiplier(
            self.base_multiplier,
            self.rate_per_second,
            self.last_accrual_time,
            self.rate_end,
            self.pending_rate_per_second,
            self.pending_rate_end,
            now_ts,
        )
    }

    /// The rate actually accruing now, which lags the stored `rate_per_second`
    /// once the active window has closed. The pause gate uses it so a stale
    /// stored rate cannot disguise an increase as a decrease.
    /// Mirrors EVM `OkuMoney._effectiveRate`.
    #[inline]
    pub fn effective_rate(&self, now_ts: i64) -> u128 {
        if self.rate_end != 0 && now_ts > self.rate_end {
            if self.pending_rate_end != 0 && now_ts > self.pending_rate_end {
                return PRECISION;
            }
            return self.pending_rate_per_second;
        }
        self.rate_per_second
    }
}

/// `x^n / PRECISION^(n-1)`: exponentiation by squaring with half-up rounding,
/// ported from MakerDAO `pot.sol` (`EVM MathLib.rpow`) with `b = PRECISION`.
///
/// Returns `None` where an intermediate quotient exceeds `u128` (EVM reverts).
// `n % 2` mirrors the Solidity `mod(n, 2)` so the two can be diffed.
#[allow(clippy::manual_is_multiple_of)]
pub const fn rpow(x: u128, n: u64) -> Option<u128> {
    if x == 0 {
        return Some(if n == 0 { PRECISION } else { 0 });
    }

    // Start the result at x^(lowest bit of n): 1.0 or x.
    let mut z = if n % 2 == 0 { PRECISION } else { x };
    let mut x = x;
    let mut n = n / 2;

    // For each remaining bit of n: square x (x^2, x^4, x^8, ...), and multiply
    // it into the result when that bit is set. Every product is rounded half-up
    // at 1e18, exactly as the Solidity version.
    while n != 0 {
        x = try_opt!(mul_div_wad_half_up(x, x));
        if n % 2 != 0 {
            z = try_opt!(mul_div_wad_half_up(z, x));
        }
        n /= 2;
    }

    Some(z)
}

/// Compound `base` by `rate^elapsed`, clamped at [`MAX_MULTIPLIER`].
/// Identity when `elapsed == 0`. Mirrors EVM `MathLib.compoundFor`.
///
/// The clamp bounds only the output, not `rpow`'s internals, so callers must
/// bound `elapsed`; the mandatory rate window written with every yielding
/// schedule does.
pub const fn compound_for(base: u128, rate: u128, elapsed: u64) -> Option<u128> {
    if elapsed == 0 {
        return Some(base);
    }
    let factor = try_opt!(rpow(rate, elapsed));
    let result = try_opt!(mul_div_wad_floor(base, factor));
    Some(if result > MAX_MULTIPLIER {
        MAX_MULTIPLIER
    } else {
        result
    })
}

/// The protocol's single multiplier function (mirrors EVM
/// `MathLib.computeMultiplier`). No supply term, so it is identical across
/// chains for identical schedule and timestamp.
///
/// Branches:
///   1. Active rate is the no-yield placeholder (`<= PRECISION`): return `base`.
///      `rate_end` is always 0 here, so there is no successor and no overhang.
///   2. Active rate is yielding and its window has closed: compound to
///      `rate_end`, then the pending rate over the overhang, itself bounded
///      by `pending_rate_end`.
///   3. Otherwise: compound the active rate from `anchor` to `now_ts`.
///
/// No leg compounds over time before `anchor` (already baked into `base`), so
/// branch 2's overhang starts at `max(anchor, rate_end)`.
///
/// Returns `None` where EVM would revert: `rpow` overflow, `now_ts < anchor`
/// in branch 3, or any negative timestamp.
///
/// Negative timestamps are rejected up front: EVM's `uint48` makes them
/// unrepresentable, while on `i64` the subtractions below could overflow and
/// panic in a view evaluated on every mint and redeem. With all four timestamps
/// in `[0, i64::MAX]`, every subtraction is guarded by a strict `>` and cannot
/// overflow.
#[allow(clippy::too_many_arguments)]
pub const fn compute_multiplier(
    base: u128,
    rate: u128,
    anchor: i64,
    rate_end: i64,
    pending_rate: u128,
    pending_rate_end: i64,
    now_ts: i64,
) -> Option<u128> {
    if anchor < 0 || rate_end < 0 || pending_rate_end < 0 || now_ts < 0 {
        return None;
    }

    // Branch 1. Must not gain an overhang leg: compounding from `rate_end`
    // would re-apply yield across `[rate_end, anchor]`, already in `base`.
    if rate <= PRECISION {
        return Some(base);
    }

    // Branch 2.
    if rate_end != 0 && now_ts > rate_end {
        // Writers keep `anchor <= rate_end`; guard the subtraction anyway so a
        // writer bug cannot make this view fail on every mint and redeem.
        let elapsed_in_window = if anchor < rate_end {
            (rate_end - anchor) as u64
        } else {
            0
        };
        let mut compounded = try_opt!(compound_for(base, rate, elapsed_in_window));
        if pending_rate > PRECISION {
            let overhang_start = if anchor > rate_end { anchor } else { rate_end };
            // An unattended successor accrues only up to its own expiry.
            let overhang_end = if pending_rate_end != 0 && now_ts > pending_rate_end {
                pending_rate_end
            } else {
                now_ts
            };
            if overhang_end > overhang_start {
                compounded = try_opt!(compound_for(
                    compounded,
                    pending_rate,
                    (overhang_end - overhang_start) as u64,
                ));
            }
        }
        return Some(compounded);
    }

    // Branch 3. `None` on `now_ts < anchor` (EVM's checked subtraction
    // reverts); saturating would silently freeze accrual.
    if now_ts < anchor {
        return None;
    }
    compound_for(base, rate, (now_ts - anchor) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;
    const SECONDS_PER_YEAR: u64 = 365 * DAY as u64;

    /// Per-second rate at 1e18 compounding to `apy` over a year.
    fn rate_for_apy(apy: f64) -> u128 {
        let r = (1.0_f64 + apy).powf(1.0 / SECONDS_PER_YEAR as f64);
        (r * 1e18_f64).round() as u128
    }

    #[test]
    fn rpow_identity_cases() {
        assert_eq!(rpow(PRECISION, 0), Some(PRECISION));
        assert_eq!(rpow(PRECISION, 1), Some(PRECISION));
        assert_eq!(rpow(PRECISION, 1_000_000), Some(PRECISION));
        assert_eq!(rpow(0, 0), Some(PRECISION));
        assert_eq!(rpow(0, 5), Some(0));
        assert_eq!(rpow(12345, 1), Some(12345));
    }

    #[test]
    fn rpow_squares_exactly() {
        let two = 2 * PRECISION;
        assert_eq!(rpow(two, 2), Some(4 * PRECISION));
        assert_eq!(rpow(two, 3), Some(8 * PRECISION));
        assert_eq!(rpow(two, 10), Some(1024 * PRECISION));
    }

    #[test]
    fn rpow_monotonic_in_n() {
        let r = rate_for_apy(0.05);
        let mut prev = rpow(r, 0).unwrap();
        for n in [
            1u64,
            10,
            100,
            3600,
            DAY as u64,
            7 * DAY as u64,
            30 * DAY as u64,
        ] {
            let cur = rpow(r, n).unwrap();
            assert!(cur >= prev, "rpow not monotonic at n={n}");
            prev = cur;
        }
    }

    #[test]
    fn rpow_five_percent_apy_over_a_year() {
        let r = rate_for_apy(0.05);
        let got = rpow(r, SECONDS_PER_YEAR).unwrap();
        // Expect ~1.05e18, within a few ppm of the float round-trip.
        let expected = 1_050_000_000_000_000_000u128;
        let diff = got.abs_diff(expected);
        assert!(diff < expected / 100_000, "got {got}, expected ~{expected}");
    }

    #[test]
    fn compound_for_is_identity_at_zero_elapsed() {
        assert_eq!(
            compound_for(PRECISION, rate_for_apy(0.05), 0),
            Some(PRECISION)
        );
        assert_eq!(compound_for(12345, u128::MAX, 0), Some(12345));
    }

    #[test]
    fn compound_for_clamps_at_max_multiplier() {
        let got = compound_for(MAX_MULTIPLIER, rate_for_apy(1.0), SECONDS_PER_YEAR);
        assert_eq!(got, Some(MAX_MULTIPLIER));
    }

    #[test]
    fn compound_for_no_yield_rate_is_identity() {
        assert_eq!(
            compound_for(PRECISION, PRECISION, SECONDS_PER_YEAR),
            Some(PRECISION)
        );
    }

    #[test]
    fn branch1_halted_is_flat() {
        let s = Schedule::halted_at(1_000);
        assert_eq!(s.multiplier_at(1_000), Some(PRECISION));
        assert_eq!(s.multiplier_at(1_000 + 10 * 365 * DAY), Some(PRECISION));
    }

    #[test]
    fn branch1_halted_with_armed_successor_is_still_flat() {
        // Unreachable via the writers; branch 1 must stay flat regardless.
        let r = rate_for_apy(0.05);
        assert_eq!(
            compute_multiplier(PRECISION, PRECISION, 0, 1_000, r, 0, 1_000 + 30 * DAY),
            Some(PRECISION),
            "halted rate must not accrue a successor"
        );
        assert_eq!(
            compute_multiplier(PRECISION, PRECISION, 5_000, 1_000, r, 0, 1_000 + 30 * DAY),
            Some(PRECISION),
            "no retroactive yield across [rate_end, anchor]"
        );
    }

    #[test]
    fn branch3_accrues_with_no_transaction() {
        let r = rate_for_apy(0.05);
        let s = Schedule {
            base_multiplier: PRECISION,
            rate_per_second: r,
            last_accrual_time: 0,
            rate_end: 30 * DAY,
            pending_rate_per_second: PRECISION,
            pending_rate_end: 0,
        };
        let a = s.multiplier_at(0).unwrap();
        let b = s.multiplier_at(DAY).unwrap();
        let c = s.multiplier_at(2 * DAY).unwrap();
        assert_eq!(a, PRECISION);
        assert!(b > a && c > b, "multiplier must stream: {a} {b} {c}");
    }

    /// Must never panic, including on negative or `i64`-overflowing timestamps.
    #[test]
    fn never_panics_on_extreme_or_negative_timestamps() {
        let cases: [(i64, i64, i64, i64); 6] = [
            // (anchor, rate_end, pending_rate_end, now_ts)
            (i64::MIN, i64::MAX, i64::MAX, i64::MAX),
            (i64::MAX, i64::MIN, i64::MIN, i64::MIN),
            (
                -8542639707296468366,
                8246779703540740749,
                8246779703540740722,
                1920103026,
            ),
            (i64::MIN, 0, 0, i64::MAX),
            (-1, 1, 1, 1),
            (0, i64::MAX, i64::MAX, i64::MAX),
        ];
        for (anchor, rate_end, pending_rate_end, now_ts) in cases {
            let _ = compute_multiplier(
                PRECISION,
                MAX_MULTIPLIER,
                anchor,
                rate_end,
                MAX_MULTIPLIER,
                pending_rate_end,
                now_ts,
            );
        }
    }

    #[test]
    fn negative_timestamps_are_rejected() {
        assert_eq!(
            compute_multiplier(PRECISION, PRECISION, -1, 0, PRECISION, 0, 0),
            None
        );
        assert_eq!(
            compute_multiplier(PRECISION, PRECISION, 0, 0, PRECISION, 0, -1),
            None
        );
    }

    #[test]
    fn branch3_rejects_timestamp_before_anchor() {
        let s = Schedule {
            base_multiplier: PRECISION,
            rate_per_second: rate_for_apy(0.05),
            last_accrual_time: 1_000,
            rate_end: 30 * DAY,
            pending_rate_per_second: PRECISION,
            pending_rate_end: 0,
        };
        assert_eq!(s.multiplier_at(999), None);
    }

    #[test]
    fn branch2_freezes_without_successor() {
        let r = rate_for_apy(0.05);
        let s = Schedule {
            base_multiplier: PRECISION,
            rate_per_second: r,
            last_accrual_time: 0,
            rate_end: 30 * DAY,
            pending_rate_per_second: PRECISION, // none armed
            pending_rate_end: 0,
        };
        let at_end = s.multiplier_at(30 * DAY).unwrap();
        let later = s.multiplier_at(90 * DAY).unwrap();
        assert_eq!(
            at_end, later,
            "accrual must HALT when no successor is armed"
        );
    }

    #[test]
    fn branch2_successor_activates_with_no_transaction() {
        let r1 = rate_for_apy(0.05);
        let r2 = rate_for_apy(0.10);
        let s = Schedule {
            base_multiplier: PRECISION,
            rate_per_second: r1,
            last_accrual_time: 0,
            rate_end: 30 * DAY,
            pending_rate_per_second: r2,
            pending_rate_end: 60 * DAY,
        };
        let at_end = s.multiplier_at(30 * DAY).unwrap();
        let after = s.multiplier_at(45 * DAY).unwrap();
        assert!(after > at_end, "successor did not activate");
        let at_pending_end = s.multiplier_at(60 * DAY).unwrap();
        let way_later = s.multiplier_at(365 * DAY).unwrap();
        assert_eq!(
            at_pending_end, way_later,
            "overhang must be bounded by pending_rate_end"
        );
    }

    #[test]
    fn branch2_handover_is_continuous() {
        // One second either side of the boundary differs by one second of yield.
        let r1 = rate_for_apy(0.05);
        let r2 = rate_for_apy(0.10);
        let s = Schedule {
            base_multiplier: PRECISION,
            rate_per_second: r1,
            last_accrual_time: 0,
            rate_end: 30 * DAY,
            pending_rate_per_second: r2,
            pending_rate_end: 60 * DAY,
        };
        let before = s.multiplier_at(30 * DAY - 1).unwrap();
        let at = s.multiplier_at(30 * DAY).unwrap();
        let after = s.multiplier_at(30 * DAY + 1).unwrap();
        assert!(at >= before && after >= at);
        assert!(
            after - at < PRECISION / 1_000_000,
            "discontinuity at handover"
        );
    }

    #[test]
    fn branch2_anchor_past_rate_end_does_not_underflow() {
        let got = compute_multiplier(
            PRECISION,
            rate_for_apy(0.05),
            50 * DAY, // anchor AFTER rate_end
            30 * DAY,
            PRECISION,
            0,
            90 * DAY,
        );
        assert_eq!(
            got,
            Some(PRECISION),
            "anchor > rate_end must contribute zero elapsed"
        );
    }

    #[test]
    fn multiplier_never_decreases_over_time() {
        let s = Schedule {
            base_multiplier: PRECISION,
            rate_per_second: rate_for_apy(0.05),
            last_accrual_time: 0,
            rate_end: 30 * DAY,
            pending_rate_per_second: rate_for_apy(0.08),
            pending_rate_end: 60 * DAY,
        };
        let mut prev = 0u128;
        let mut t = 0i64;
        while t <= 120 * DAY {
            let m = s.multiplier_at(t).unwrap();
            assert!(m >= prev, "multiplier decreased at t={t}: {m} < {prev}");
            prev = m;
            t += 997; // prime step, lands on both sides of both boundaries
        }
    }

    #[test]
    fn effective_rate_tracks_the_window() {
        let r1 = rate_for_apy(0.05);
        let r2 = rate_for_apy(0.10);
        let s = Schedule {
            base_multiplier: PRECISION,
            rate_per_second: r1,
            last_accrual_time: 0,
            rate_end: 30 * DAY,
            pending_rate_per_second: r2,
            pending_rate_end: 60 * DAY,
        };
        assert_eq!(s.effective_rate(DAY), r1, "inside active window");
        assert_eq!(s.effective_rate(45 * DAY), r2, "inside overhang");
        assert_eq!(s.effective_rate(90 * DAY), PRECISION, "past pending expiry");
    }
}

#[cfg(kani)]
mod proofs {
    use super::*;

    /// `compound_for` is the identity at zero elapsed, for ANY base and rate.
    #[kani::proof]
    fn proof_compound_for_identity_at_zero_elapsed() {
        let base: u128 = kani::any();
        let rate: u128 = kani::any();
        assert!(compound_for(base, rate, 0) == Some(base));
    }

    /// `compound_for` never returns above `MAX_MULTIPLIER` (the clamp holds).
    #[kani::proof]
    fn proof_compound_for_output_clamped() {
        let base: u128 = kani::any();
        let rate: u128 = kani::any();
        let elapsed: u64 = kani::any();
        kani::assume(base <= MAX_MULTIPLIER);
        kani::assume(rate <= crate::constants::MAX_RATE);
        kani::assume(elapsed <= crate::constants::MAX_RATE_WINDOW_SECONDS as u64);

        // Assumptions are the reachable domain (rate and window rails). The
        // `reachability` tests sample the same claim; this harness does not
        // currently terminate under `cargo kani` (symbolic 256-bit math in `rpow`).
        let out = compound_for(base, rate, elapsed);
        assert!(
            out.is_some(),
            "compound_for returned None inside the reachable domain"
        );
        assert!(out.unwrap() <= MAX_MULTIPLIER);
    }

    /// A halted schedule is flat for every timestamp, over ANY `rate_end` /
    /// `pending_rate` / `pending_rate_end` (not just the reachable shape).
    /// The `>= 0` assumptions match the up-front negative-timestamp rejection.
    #[kani::proof]
    fn proof_halted_schedule_is_flat() {
        let base: u128 = kani::any();
        let rate: u128 = kani::any();
        let anchor: i64 = kani::any();
        let rate_end: i64 = kani::any();
        let pending: u128 = kani::any();
        let pending_rate_end: i64 = kani::any();
        let now: i64 = kani::any();
        kani::assume(rate <= PRECISION);
        kani::assume(anchor >= 0 && rate_end >= 0 && pending_rate_end >= 0 && now >= 0);
        assert!(
            compute_multiplier(base, rate, anchor, rate_end, pending, pending_rate_end, now)
                == Some(base)
        );
    }

    /// A yielding rate can never shrink the base — monotonicity in value.
    #[kani::proof]
    fn proof_multiplier_never_below_base() {
        let base: u128 = kani::any();
        let rate: u128 = kani::any();
        let anchor: i64 = kani::any();
        let rate_end: i64 = kani::any();
        let now: i64 = kani::any();
        kani::assume(base <= MAX_MULTIPLIER);
        kani::assume(rate >= PRECISION && rate <= crate::constants::MAX_RATE);
        kani::assume(anchor >= 0 && rate_end >= 0 && now >= 0);
        kani::assume(now >= anchor);
        if let Some(v) = compute_multiplier(base, rate, anchor, rate_end, PRECISION, 0, now) {
            assert!(v >= base || base > MAX_MULTIPLIER);
        }
    }
}

#[cfg(test)]
mod reachability {
    //! `rpow` returns `None` once a quotient exceeds `u128` (EVM reverts on a
    //! `uint256` product; the SVM bound binds first). These tests show the
    //! band is unreachable: failure needs multipliers around 1e23x while
    //! `MAX_MULTIPLIER` clamps at 1e6x.

    use super::*;
    use crate::constants::MAX_RATE;

    const DAY: u64 = 86_400;
    const YEAR: u64 = 365 * DAY;

    fn rate_for_apy(apy: f64) -> u128 {
        ((1.0_f64 + apy).powf(1.0 / YEAR as f64) * 1e18_f64).round() as u128
    }

    /// Wherever the result is inside `MAX_MULTIPLIER`, the arithmetic works.
    #[test]
    fn computes_everywhere_the_result_is_within_max_multiplier() {
        for apy in [0.0001, 0.01, 0.05, 0.20, 0.50, 1.00, 5.00, 20.00] {
            let rate = rate_for_apy(apy).min(MAX_RATE);
            for days in [1u64, 7, 30, 90, 365, 5 * 365, 30 * 365, 100 * 365] {
                let elapsed = days * DAY;
                let unclamped = (1.0_f64 + apy).powf(elapsed as f64 / YEAR as f64);
                if unclamped > 1e6 {
                    continue;
                }
                assert!(
                    compound_for(PRECISION, rate, elapsed).is_some(),
                    "None at {}% APY over {days} days ({unclamped:.3e}x, inside MAX_MULTIPLIER)",
                    apy * 100.0
                );
            }
        }
    }

    /// `MAX_RATE` (~2242% APY) computes over every realistic window.
    #[test]
    fn max_rate_computes_over_realistic_windows() {
        for days in [1u64, 7, 30, 90, 365, 3 * 365] {
            assert!(
                compound_for(PRECISION, MAX_RATE, days * DAY).is_some(),
                "MAX_RATE over {days} days returned None"
            );
        }
    }

    /// Pins the failure boundary (~1e23x and beyond) so a `wad.rs` change that
    /// moved it is visible.
    #[test]
    fn boundary_sits_far_beyond_the_clamp() {
        assert!(compound_for(PRECISION, MAX_RATE, 3 * YEAR).is_some());
        assert!(compound_for(PRECISION, rate_for_apy(1.00), 30 * YEAR).is_some());
        assert!(compound_for(PRECISION, rate_for_apy(0.20), 100 * YEAR).is_some());

        assert!(
            compound_for(PRECISION, rate_for_apy(5.00), 30 * YEAR).is_none(),
            "boundary moved — the reachability argument needs rechecking"
        );
        assert!(compound_for(PRECISION, rate_for_apy(1.00), 100 * YEAR).is_none());
    }

    /// Out of domain the result is an error, never a wrong number.
    #[test]
    fn out_of_domain_errors_rather_than_returning_a_wrong_value() {
        let s = Schedule {
            base_multiplier: PRECISION,
            rate_per_second: rate_for_apy(5.00),
            last_accrual_time: 0,
            rate_end: (30 * YEAR) as i64,
            pending_rate_per_second: PRECISION,
            pending_rate_end: 0,
        };
        assert_eq!(s.multiplier_at((30 * YEAR) as i64), None);
    }
}
