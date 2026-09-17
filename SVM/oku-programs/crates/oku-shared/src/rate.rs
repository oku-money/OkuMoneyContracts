//! Streaming accrual — the SVM port of `EVM/src/lib/MathLib.sol`.
//!
//! This module is a deliberate line-for-line port. The branch structure,
//! the defensive guards, and even the comment wording track the Solidity
//! so a reviewer can diff the two side by side. **Do not "improve" the
//! shape of this code** — divergence here silently breaks cross-chain
//! multiplier agreement, which has no on-chain detection layer on either
//! stack (see `EVM/README.md` § Accepted Risks (10)).
//!
//! ## The model
//!
//! The multiplier is not stored. It is a pure function of a six-field rate
//! schedule and the current timestamp:
//!
//! ```text
//!   m(t) = compute_multiplier(base, rate, anchor, rate_end,
//!                             pending_rate, pending_rate_end, t)
//! ```
//!
//! Because there is no supply term and no stored index, every chain holding
//! the same schedule returns the same value at the same wall-clock second,
//! with no messaging, no oracle, and — critically — **no transaction at the
//! epoch boundary**. A pre-staged `pending_rate` activates off the absolute
//! `rate_end`, so staging transactions may land on different chains days
//! apart and the handover is still simultaneous to the second.
//!
//! ## Rounding
//!
//! `rpow` uses MakerDAO's half-up assembly rounding; everything else floors.
//! That carve-out is inherited verbatim from `MathLib.sol:13-20` and is
//! implemented by [`crate::wad::mul_div_wad_half_up`].
//!
//! ## Known bounded divergence from EVM
//!
//! EVM's `rpow` reverts when an intermediate exceeds `uint256`; this port
//! returns `None` when an intermediate *quotient* exceeds `u128`. The SVM
//! bound binds first, at `x ≈ 1.84e28` versus EVM's `x < 2^128 ≈ 3.4e38`.
//! Both are far outside the reachable domain — `MAX_MULTIPLIER` clamps
//! output at `1e24` (1e6×), while the SVM bound only engages above ~1.8e10×
//! *within a single squaring step*. Tracked in `SVM/DECISIONS.md` (D-04).

use crate::constants::{MAX_MULTIPLIER, PRECISION};
use crate::wad::{mul_div_wad_floor, mul_div_wad_half_up};

/// The six-field rate schedule. Mirrors the `OkuMoneyStorage` accrual
/// fields at `EVM/src/token/OkuMoney.sol:78-96`.
///
/// Timestamps are `i64` to match Solana's `Clock::unix_timestamp`. EVM packs
/// them as `uint48`; the representable range is not the binding constraint
/// on either stack.
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
    /// Successor's own expiry. Bounds the overhang so an unattended
    /// successor halts rather than compounding forever. `0` = none armed.
    pub pending_rate_end: i64,
}

impl Schedule {
    /// The flat-and-halted initial state written at program init.
    /// Mirrors `EVM/src/token/OkuMoney.sol:195-199`.
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

    /// The rate that is *actually* accruing right now, which lags the stored
    /// `rate_per_second` once the active window has closed.
    ///
    /// Used by the pause gate so a stale stored rate cannot be used to
    /// disguise an increase as a decrease.
    ///
    /// Mirrors `EVM/src/token/OkuMoney.sol:321-331`.
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

// ---------------------------------------------------------------------------
// rpow
// ---------------------------------------------------------------------------

/// `x^n / PRECISION^(n-1)` — exponentiation by squaring with half-up rounding.
///
/// Verbatim port of MakerDAO `pot.sol`'s `rpow`, as reproduced at
/// `EVM/src/lib/MathLib.sol:36-67`. The `b` parameter is fixed at
/// [`PRECISION`] here because that is the only value the protocol ever
/// passes.
///
/// Returns `None` where EVM would revert (overflow). See the module-level
/// note on the bounded divergence between the two overflow thresholds.
// `n % 2` is kept rather than `n.is_multiple_of(2)` because it mirrors the
// `mod(n, 2)` in the Solidity assembly character-for-character. This function
// is reviewed by diffing it against `MathLib.sol:36-67`; idiomatic Rust that
// obscures that correspondence is a net loss here.
#[allow(clippy::manual_is_multiple_of)]
pub const fn rpow(x: u128, n: u64) -> Option<u128> {
    // switch x case 0 { switch n case 0 { z := b } default { z := 0 } }
    if x == 0 {
        return Some(if n == 0 { PRECISION } else { 0 });
    }

    // switch mod(n, 2) case 0 { z := b } default { z := x }
    let mut z = if n % 2 == 0 { PRECISION } else { x };
    let mut x = x;
    let mut n = n / 2;

    // for { n := div(n, 2) } n { n := div(n, 2) }
    while n != 0 {
        // xx := x*x ; xxRound := xx + half ; x := xxRound / b
        x = match mul_div_wad_half_up(x, x) {
            Some(v) => v,
            None => return None,
        };

        if n % 2 != 0 {
            // zx := z*x ; zxRound := zx + half ; z := zxRound / b
            z = match mul_div_wad_half_up(z, x) {
                Some(v) => v,
                None => return None,
            };
        }

        n /= 2;
    }

    Some(z)
}

// ---------------------------------------------------------------------------
// compoundFor
// ---------------------------------------------------------------------------

/// Compound `base` by `rate^elapsed`, clamped at [`MAX_MULTIPLIER`].
///
/// Identity when `elapsed == 0`. Every caller bounds `elapsed` via the
/// mandatory rate-window timestamps enforced when the schedule is written —
/// every yielding rate carries a bounded window. That requirement exists
/// primarily so an open-ended rate can never end at a transaction-dependent,
/// per-chain moment (which would reintroduce the cross-chain divergence
/// streaming accrual exists to eliminate). A secondary benefit of the same
/// bound: the `MAX_MULTIPLIER` cap only bounds the OUTPUT — it cannot
/// prevent `rpow` from failing internally on a huge `elapsed` — so the
/// mandatory window also keeps `rpow` in its safe range.
///
/// Mirrors `EVM/src/lib/MathLib.sol:87-101`.
pub const fn compound_for(base: u128, rate: u128, elapsed: u64) -> Option<u128> {
    if elapsed == 0 {
        return Some(base);
    }
    let factor = match rpow(rate, elapsed) {
        Some(v) => v,
        None => return None,
    };
    let result = match mul_div_wad_floor(base, factor) {
        Some(v) => v,
        None => return None,
    };
    Some(if result > MAX_MULTIPLIER { MAX_MULTIPLIER } else { result })
}

// ---------------------------------------------------------------------------
// computeMultiplier
// ---------------------------------------------------------------------------

/// Continuous streaming accrual — the protocol's single multiplier function.
///
/// Pure function of the rate schedule and `now_ts`; contains no supply term,
/// which is what makes the multiplier identical across chains given
/// identical schedule state and timestamp.
///
/// Branches:
///   1. Active rate is the no-yield placeholder (`<= PRECISION`): return
///      `base`. (`rate_end` is always 0 in this state — the writers never
///      write a bounded window against a halted rate — so there is no
///      overhang to compound here.)
///   2. Active rate is yielding and the window has closed: compound to
///      `rate_end`, then compound the pending rate over the overhang, itself
///      bounded by `pending_rate_end`.
///   3. Otherwise: compound the active rate from `anchor` to `now_ts`.
///      Bounded because `now_ts <= rate_end` here and any yielding `rate`
///      always has `rate_end` set at write time.
///
/// A `pending_rate` activates with no transaction at the boundary, which is
/// what keeps multi-chain epoch handovers simultaneous.
///
/// Mirrors `EVM/src/lib/MathLib.sol:135-190`.
///
/// Returns `None` where EVM would revert: `rpow` overflow, `now_ts` before
/// `anchor` in branch 3 (which underflows Solidity's checked subtraction at
/// `MathLib.sol:189`), or a negative timestamp (see below).
///
/// ## Why the negative-timestamp guard exists
///
/// EVM stores these as `uint48` and does the arithmetic in `uint256`, so the
/// "timestamp is negative" state is unrepresentable there. Solana's
/// `Clock::unix_timestamp` is `i64`, so it is representable here, and the
/// differences below (`rate_end - anchor`, `now_ts - anchor`, …) overflow
/// `i64` for extreme operands of opposite sign — found by
/// `fuzz_targets/compute_multiplier.rs`, which asserts this function never
/// panics.
///
/// A panic would be severe: this is a *view*, evaluated on every mint and
/// every redeem, so a panicking input would brick the PSM rather than merely
/// return a wrong number. Rejecting negative timestamps up front restores
/// EVM's domain exactly, and with all four timestamps in `[0, i64::MAX]`
/// every subtraction below is guarded by a strict `>` comparison between
/// non-negative values and therefore cannot overflow.
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
    // Restore EVM's unsigned-timestamp domain. See the doc-comment above.
    if anchor < 0 || rate_end < 0 || pending_rate_end < 0 || now_ts < 0 {
        return None;
    }

    // Branch 1: active rate is the no-yield placeholder. `rate_end` is always
    // 0 here by construction — the writers never write a bounded window
    // against a halted rate — so under the current writer set this is just
    // the flat base. Defensive fallback below mirrors branch 2's overhang
    // handling in case that invariant is ever violated by a future writer,
    // rather than silently dropping a pending rate that should be accruing.
    if rate <= PRECISION {
        if rate_end != 0 && now_ts > rate_end && pending_rate > PRECISION {
            let overhang_end = if pending_rate_end != 0 && now_ts > pending_rate_end {
                pending_rate_end
            } else {
                now_ts
            };
            if overhang_end > rate_end {
                return compound_for(base, pending_rate, (overhang_end - rate_end) as u64);
            }
        }
        return Some(base);
    }

    // Branch 2: active rate is yielding and its window has closed.
    if rate_end != 0 && now_ts > rate_end {
        // Defensive: `anchor` should never be past `rate_end` given the
        // writers (every write that moves `anchor` either clears `rate_end`
        // or sets a fresh one strictly in the future), but guard the
        // subtraction anyway rather than let a future writer bug underflow
        // this view forever.
        let elapsed_in_window = if anchor < rate_end { (rate_end - anchor) as u64 } else { 0 };
        let mut compounded = match compound_for(base, rate, elapsed_in_window) {
            Some(v) => v,
            None => return None,
        };
        if pending_rate > PRECISION {
            let overhang_start = if anchor > rate_end { anchor } else { rate_end };
            // Bound the overhang at `pending_rate_end`: an unattended
            // successor compounds only up to its own expiry, then accrual
            // halts (safe) rather than running unbounded until the next
            // schedule write.
            let overhang_end = if pending_rate_end != 0 && now_ts > pending_rate_end {
                pending_rate_end
            } else {
                now_ts
            };
            if overhang_end > overhang_start {
                compounded = match compound_for(
                    compounded,
                    pending_rate,
                    (overhang_end - overhang_start) as u64,
                ) {
                    Some(v) => v,
                    None => return None,
                };
            }
        }
        return Some(compounded);
    }

    // Branch 3: active rate still running. Bounded because now_ts <= rate_end
    // here and every yielding rate has rate_end set at write time.
    //
    // EVM reverts on `nowTs < anchor` (checked subtraction); mirror that as
    // `None` rather than saturating, which would silently freeze accrual.
    if now_ts < anchor {
        return None;
    }
    compound_for(base, rate, (now_ts - anchor) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400;

    /// ~5% APY as a per-second rate at 1e18, computed the way the off-chain
    /// deriver does: rate = (1 + apy)^(1/SECONDS_PER_YEAR).
    fn rate_for_apy(apy: f64) -> u128 {
        let r = (1.0_f64 + apy).powf(1.0 / 31_536_000.0);
        (r * 1e18_f64).round() as u128
    }

    // -- rpow -------------------------------------------------------------

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
        // 2.0^2 == 4.0 at WAD scale
        let two = 2 * PRECISION;
        assert_eq!(rpow(two, 2), Some(4 * PRECISION));
        assert_eq!(rpow(two, 3), Some(8 * PRECISION));
        assert_eq!(rpow(two, 10), Some(1024 * PRECISION));
    }

    #[test]
    fn rpow_monotonic_in_n() {
        let r = rate_for_apy(0.05);
        let mut prev = rpow(r, 0).unwrap();
        for n in [1u64, 10, 100, 3600, 86_400, 604_800, 2_592_000] {
            let cur = rpow(r, n).unwrap();
            assert!(cur >= prev, "rpow not monotonic at n={n}");
            prev = cur;
        }
    }

    #[test]
    fn rpow_five_percent_apy_over_a_year() {
        let r = rate_for_apy(0.05);
        let got = rpow(r, 31_536_000).unwrap();
        // Expect ~1.05e18, within a few ppm of the float round-trip.
        let expected = 1_050_000_000_000_000_000u128;
        let diff = got.abs_diff(expected);
        assert!(diff < expected / 100_000, "got {got}, expected ~{expected}");
    }

    // -- compound_for -----------------------------------------------------

    #[test]
    fn compound_for_is_identity_at_zero_elapsed() {
        assert_eq!(compound_for(PRECISION, rate_for_apy(0.05), 0), Some(PRECISION));
        // Even a nonsense rate is the identity when no time has passed.
        assert_eq!(compound_for(12345, u128::MAX, 0), Some(12345));
    }

    #[test]
    fn compound_for_clamps_at_max_multiplier() {
        // A huge base with any growth must clamp, not error.
        let got = compound_for(MAX_MULTIPLIER, rate_for_apy(1.0), 31_536_000);
        assert_eq!(got, Some(MAX_MULTIPLIER));
    }

    #[test]
    fn compound_for_no_yield_rate_is_identity() {
        assert_eq!(compound_for(PRECISION, PRECISION, 31_536_000), Some(PRECISION));
    }

    // -- compute_multiplier: branch 1 (halted) ----------------------------

    #[test]
    fn branch1_halted_is_flat() {
        let s = Schedule::halted_at(1_000);
        assert_eq!(s.multiplier_at(1_000), Some(PRECISION));
        assert_eq!(s.multiplier_at(1_000 + 10 * 365 * DAY), Some(PRECISION));
    }

    #[test]
    fn branch1_defensive_overhang_fires() {
        // Halted rate WITH a rate_end and an armed successor — a state the
        // writers never produce, but the defensive fallback must accrue it
        // rather than silently drop it. Mirrors MathLib.t.sol:314 / :329.
        let r = rate_for_apy(0.05);
        let got = compute_multiplier(PRECISION, PRECISION, 0, 1_000, r, 0, 1_000 + 30 * DAY).unwrap();
        assert!(got > PRECISION, "defensive overhang did not accrue");
    }

    // -- compute_multiplier: branch 3 (running) ---------------------------

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

    /// Regression: `compute_multiplier` must never panic, including on
    /// timestamps that are negative or far apart enough to overflow an `i64`
    /// subtraction. Found by `fuzz_targets/compute_multiplier.rs`.
    ///
    /// EVM cannot reach this state (`uint48` storage, `uint256` arithmetic),
    /// so it is a port-introduced hazard rather than a shared one.
    #[test]
    fn never_panics_on_extreme_or_negative_timestamps() {
        let cases: [(i64, i64, i64, i64); 6] = [
            // (anchor, rate_end, pending_rate_end, now_ts)
            (i64::MIN, i64::MAX, i64::MAX, i64::MAX),
            (i64::MAX, i64::MIN, i64::MIN, i64::MIN),
            (-8542639707296468366, 8246779703540740749, 8246779703540740722, 1920103026),
            (i64::MIN, 0, 0, i64::MAX),
            (-1, 1, 1, 1),
            (0, i64::MAX, i64::MAX, i64::MAX),
        ];
        for (anchor, rate_end, pending_rate_end, now_ts) in cases {
            // Must return a value or None — never unwind.
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
        // EVM's domain is unsigned; mirror it rather than inventing semantics.
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

    // -- compute_multiplier: branch 2 (window closed) ---------------------

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
        assert_eq!(at_end, later, "accrual must HALT when no successor is armed");
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
        // And it halts at its own expiry.
        let at_pending_end = s.multiplier_at(60 * DAY).unwrap();
        let way_later = s.multiplier_at(365 * DAY).unwrap();
        assert_eq!(at_pending_end, way_later, "overhang must be bounded by pending_rate_end");
    }

    #[test]
    fn branch2_handover_is_continuous() {
        // The value one second either side of the boundary must differ only
        // by one second of yield — no jump, no double-count.
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
        // One second of 10% APY on ~1.004 is about 3e9 at WAD scale.
        assert!(at >= before && after >= at);
        assert!(after - at < PRECISION / 1_000_000, "discontinuity at handover");
    }

    #[test]
    fn branch2_anchor_past_rate_end_does_not_underflow() {
        // Mirrors MathLib.t.sol:382 — defensive guard at MathLib.sol:171.
        let got = compute_multiplier(
            PRECISION,
            rate_for_apy(0.05),
            50 * DAY, // anchor AFTER rate_end
            30 * DAY,
            PRECISION,
            0,
            90 * DAY,
        );
        assert_eq!(got, Some(PRECISION), "anchor > rate_end must contribute zero elapsed");
    }

    // -- monotonicity invariant -------------------------------------------

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

    // -- effective_rate ---------------------------------------------------

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

// ---------------------------------------------------------------------------
// Kani formal verification
// ---------------------------------------------------------------------------

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
        kani::assume(elapsed <= 90 * 86_400);
        if let Some(v) = compound_for(base, rate, elapsed) {
            assert!(v <= MAX_MULTIPLIER);
        }
    }

    /// A halted schedule (`rate == PRECISION`, `rate_end == 0`) is flat for
    /// every timestamp — accrual genuinely stops.
    #[kani::proof]
    fn proof_halted_schedule_is_flat() {
        let base: u128 = kani::any();
        let anchor: i64 = kani::any();
        let now: i64 = kani::any();
        let pending: u128 = kani::any();
        assert!(compute_multiplier(base, PRECISION, anchor, 0, pending, 0, now) == Some(base));
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

// ---------------------------------------------------------------------------
// Reachability bound (SVM/DECISIONS.md D-04)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod reachability {
    //! Proves the accepted EVM divergence (`SVM/DECISIONS.md` D-04) is
    //! unreachable, rather than merely arguing it.
    //!
    //! Solidity's `rpow` reverts when an intermediate **product** exceeds
    //! `uint256`; this port returns `None` when an intermediate **quotient**
    //! exceeds `u128`. The SVM bound binds first, so a band exists where EVM
    //! succeeds and SVM errors. The differential corpus deliberately does not
    //! generate vectors there — doing so would produce known-failing cases and
    //! devalue it — so the "unreachable" claim needed its own test.
    //!
    //! The result is stronger than expected. `rpow` only fails where the
    //! multiplier would be on the order of **1e23x or more**, while
    //! `MAX_MULTIPLIER` already clamps it at **1e6x** ($1,000,000 per token).
    //! There are roughly seventeen orders of magnitude between the point at
    //! which the value stops being economically meaningful and the point at
    //! which the arithmetic stops working.

    use super::*;
    use crate::constants::MAX_RATE;

    const YEAR: u64 = 31_536_000;

    /// Per-second rate compounding to `apy` over a 365-day year.
    fn rate_for_apy(apy: f64) -> u128 {
        ((1.0_f64 + apy).powf(1.0 / YEAR as f64) * 1e18_f64).round() as u128
    }

    /// **The claim that matters.** Anywhere the multiplier is still inside the
    /// protocol's own ceiling, the arithmetic works.
    ///
    /// Swept across every rate the rails permit and windows from one day to a
    /// century — far beyond any schedule that would ever be published.
    #[test]
    fn computes_everywhere_the_result_is_within_max_multiplier() {
        for apy in [0.0001, 0.01, 0.05, 0.20, 0.50, 1.00, 5.00, 20.00] {
            let rate = rate_for_apy(apy).min(MAX_RATE);
            for days in [1u64, 7, 30, 90, 365, 5 * 365, 30 * 365, 100 * 365] {
                let elapsed = days * 86_400;
                let unclamped = (1.0_f64 + apy).powf(elapsed as f64 / YEAR as f64);
                // Only assert inside the meaningful domain: past MAX_MULTIPLIER
                // the value is clamped and economically meaningless anyway.
                if unclamped > 1e6 {
                    continue;
                }
                assert!(
                    compound_for(PRECISION, rate, elapsed).is_some(),
                    "returned None at {}% APY over {days} days, where the result                      ({unclamped:.3e}x) is still inside MAX_MULTIPLIER",
                    apy * 100.0
                );
            }
        }
    }

    /// `MAX_RATE` (~2242% APY) is the most extreme rate the rails permit. It
    /// computes over every window an epoch schedule would realistically use —
    /// epochs are 7-30 days, so this covers a fat-fingered `rateEnd` by orders
    /// of magnitude.
    #[test]
    fn max_rate_computes_over_realistic_windows() {
        for days in [1u64, 7, 30, 90, 365, 3 * 365] {
            assert!(
                compound_for(PRECISION, MAX_RATE, days * 86_400).is_some(),
                "MAX_RATE over {days} days returned None"
            );
        }
    }

    /// Pins where the boundary actually falls, so a change in `wad.rs` that
    /// moved it would be visible rather than silent.
    ///
    /// Note how far past anything meaningful these are: the failing cases
    /// produce multipliers of ~1e23x and ~1e30x against a 1e6x clamp.
    #[test]
    fn boundary_sits_far_beyond_the_clamp() {
        // Safe side.
        assert!(compound_for(PRECISION, MAX_RATE, 3 * YEAR).is_some());
        assert!(compound_for(PRECISION, rate_for_apy(1.00), 30 * YEAR).is_some());
        assert!(compound_for(PRECISION, rate_for_apy(0.20), 100 * YEAR).is_some());

        // Failing side — both already ~17+ orders past MAX_MULTIPLIER.
        assert!(
            compound_for(PRECISION, rate_for_apy(5.00), 30 * YEAR).is_none(),
            "boundary moved — D-04's reachability argument needs rechecking"
        );
        assert!(compound_for(PRECISION, rate_for_apy(1.00), 100 * YEAR).is_none());
    }

    /// Out of domain, the failure is an ERROR, never a wrong number. The PSM
    /// refuses to price rather than mispricing, and the operator recovers by
    /// republishing the schedule.
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
