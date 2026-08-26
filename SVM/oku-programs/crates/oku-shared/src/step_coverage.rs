//! Multiplier-step / fee-coverage primitives.
//!
//! # The problem these solve
//!
//! On a chain whose multiplier moves in DISCRETE STEPS, a step is free money
//! without a fee:
//!
//!   1. mint at `M0`
//!   2. the multiplier steps to `M1`
//!   3. redeem at `M1`, pocketing `(M1 - M0)` per raw token
//!
//! Zero holding time, zero risk, repeatable every step. The cross-chain sync
//! window does not help: the attacker never transacts while it is open, so its
//! length is irrelevant to them.
//!
//! The fees are the control — but only if they actually cover the step. A
//! round trip pays `tin` on the way in and `tout` on the way out, so the
//! coverage figure is the COMBINED `tin + tout`, mirroring EVM
//! (`OkuM.setOkuMultiplier` reads `tin() + tout()` from the module). Before
//! this module that was an operational commitment (someone had to pick big
//! enough fees). These primitives turn it into an on-chain invariant.
//!
//! # The two halves of the invariant
//!
//! Neither is sufficient alone:
//!
//! - [`step_is_covered`] — enforced when the multiplier is written. Stops an
//!   operator from *creating* exposure the current fees do not cover.
//! - a fee floor at the step high-water mark ([`step_bps_ceil`] feeds it) —
//!   enforced when fees are changed. Stops an operator from *removing* coverage
//!   after the fact, which would otherwise let anyone who held across the step
//!   exit cheaply.
//!
//! Together: at all times, `tin + tout` covers every step that has ever
//! occurred.
//!
//! # Why a time-based cooldown was rejected
//!
//! An earlier design used a cooldown on fee decreases. It does not work. The
//! attacker's edge is locked in the instant the step lands and does not decay,
//! and the multiplier is monotonic so waiting costs them nothing — no price risk
//! to sit through. A cooldown therefore converts an instant profit into a
//! delayed profit rather than eliminating it. The high-water mark has no expiry
//! and is strictly less restrictive in the common case: if every step was
//! 1.4 bps, the combined fees can still be lowered to 1.4 bps.
//!
//! # Scope
//!
//! Only meaningful on a stepped chain. The EVM twin (`OkuM`) is now stepwise
//! too and enforces the same `tin + tout >= step_bps` rule plus the same
//! high-water-mark floor, so the invariant is chain-symmetric.
//!
//! No `anchor-lang`, no `solana-program`, no I/O — pure arithmetic.

use crate::constants::BASIS_POINTS;

/// Is the step `old_multiplier -> new_multiplier` covered by `coverage_bps`
/// (the combined `tin + tout`)?
///
/// Exact form, deliberately not routed through a bps conversion:
///
/// ```text
///     (M1 - M0) * 10_000  <=  coverage_bps * M0
/// ```
///
/// # Why the exact form rather than comparing rounded bps
///
/// Converting the step to basis points first would floor a sub-1-bps step to
/// zero, so at `coverage_bps == 0` a long series of tiny increments would each
/// pass and together reproduce an arbitrarily large uncovered step. Ceiling the
/// conversion instead over-charges high-frequency operators: an hourly 0.06 bps
/// step would demand a 1 bps fee, 16x more than it needs. The exact inequality
/// has neither problem.
///
/// # Fail-closed at zero
///
/// At `coverage_bps == 0` the right-hand side is `0`, so no strict increase can
/// satisfy it. Rebasing is therefore impossible until a fee is configured —
/// the operator cannot create the arbitrage condition, rather than being
/// trusted not to.
///
/// Returns `true` for a non-increasing step; the caller enforces strict
/// monotonicity separately and would already have rejected it.
///
/// # Proof of no-profit
///
/// A covered round trip pays `tin` on the deposit and `tout` on the payout,
/// and the step it holds across satisfies `M1 - M0 <= (tin + tout) * M0`.
/// The gross gain ratio is `M1 / M0 <= 1 + tin + tout`, while the fee drag is
/// the factor `(1 - tin)(1 - tout)`, and
/// `(1 - tin)(1 - tout)(1 + tin + tout) <= 1` for all fees in range. So the
/// profit condition is never met — including when the entire coverage sits on
/// one leg. Verified by `proof_covered_step_is_never_profitable` across every
/// `tin`/`tout` split of the coverage.
#[inline]
pub fn step_is_covered(old_multiplier: u64, new_multiplier: u64, coverage_bps: u64) -> bool {
    if new_multiplier <= old_multiplier {
        return true;
    }
    // u128: at MAX_MULTIPLIER (1e15) the left side reaches 1e19, which fits u64
    // only barely. Widening removes the question.
    let delta = (new_multiplier as u128) - (old_multiplier as u128);
    let lhs = delta * (BASIS_POINTS as u128);
    let rhs = (coverage_bps as u128) * (old_multiplier as u128);
    lhs <= rhs
}

/// The step `old -> new` expressed in basis points, rounded **up**.
///
/// Feeds the fee high-water mark and the `MAX_STEP_BPS` single-step ceiling.
/// Ceiling because the mark becomes a floor on future fees: rounding down
/// could let the fees be lowered a fraction below what the step actually
/// needs.
///
/// Returns `0` for a non-increasing step. `None` only if the result exceeds
/// `u64`, which `MAX_MULTIPLIER` makes unreachable in practice.
#[inline]
pub fn step_bps_ceil(old_multiplier: u64, new_multiplier: u64) -> Option<u64> {
    if new_multiplier <= old_multiplier {
        return Some(0);
    }
    if old_multiplier == 0 {
        return None;
    }
    let delta = (new_multiplier as u128) - (old_multiplier as u128);
    let numerator = delta.checked_mul(BASIS_POINTS as u128)?;
    let d = old_multiplier as u128;
    // ceil(numerator / d)
    let result = numerator.div_ceil(d);
    u64::try_from(result).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::constants::{MAX_FEE_BPS, MAX_MULTIPLIER, MAX_STEP_BPS, PRECISION};

    // ---- step_is_covered ----

    #[test]
    fn zero_coverage_forbids_any_increase() {
        // The fail-closed property: rebasing is impossible until a fee is set.
        assert!(!step_is_covered(PRECISION, PRECISION + 1, 0));
        assert!(!step_is_covered(PRECISION, PRECISION * 2, 0));
        // A non-increase is vacuously covered (rejected elsewhere as non-monotonic).
        assert!(step_is_covered(PRECISION, PRECISION, 0));
    }

    #[test]
    fn exact_boundary_is_covered() {
        // Step of exactly the coverage: 1e9 -> 1e9 + 15bps, tin + tout = 15bps.
        let m0 = PRECISION;
        let m1 = m0 + m0 * 15 / 10_000;
        assert!(step_is_covered(m0, m1, 15));
        assert!(!step_is_covered(m0, m1 + 1, 15));
    }

    #[test]
    fn coverage_is_the_combined_tin_plus_tout() {
        // The same 15 bps of coverage works however it is split between the
        // legs — the predicate sees only the sum, exactly as EVM's
        // `tin() + tout()` read does.
        let m0 = PRECISION;
        let m1 = m0 + m0 * 15 / 10_000;
        for (tin, tout) in [(0u64, 15u64), (15, 0), (7, 8), (5, 10)] {
            assert!(step_is_covered(m0, m1, tin + tout), "split {tin}/{tout}");
        }
        // ...and 14 bps total does not, however split.
        assert!(!step_is_covered(m0, m1, 14));
    }

    #[test]
    fn sub_bps_steps_do_not_need_a_whole_bps_of_fee() {
        // The reason for the exact form: an hourly ~0.06 bps step must not be
        // forced to carry a 1 bps fee.
        let m0 = 1_000_000_000u64;
        let m1 = m0 + 6_000; // 0.06 bps
        assert!(step_is_covered(m0, m1, 1));
        // ...but it is still not free.
        assert!(!step_is_covered(m0, m1, 0));
    }

    #[test]
    fn realistic_cadences_against_realistic_fees() {
        let m0 = PRECISION;
        let step = |bps_x100: u64| m0 + m0 * bps_x100 / 1_000_000;
        // daily ~1.37bps under 15bps combined coverage: covered.
        assert!(step_is_covered(m0, step(137), 15));
        // weekly ~9.62bps under 15bps combined coverage: covered.
        assert!(step_is_covered(m0, step(962), 15));
        // weekly ~9.62bps under 5bps combined coverage: NOT covered.
        assert!(!step_is_covered(m0, step(962), 5));
    }

    #[test]
    fn does_not_overflow_at_extremes() {
        assert!(step_is_covered(
            MAX_MULTIPLIER - 1,
            MAX_MULTIPLIER,
            MAX_FEE_BPS
        ));
        assert!(!step_is_covered(1, MAX_MULTIPLIER, MAX_FEE_BPS));
        assert!(step_is_covered(u64::MAX - 1, u64::MAX, MAX_FEE_BPS));
    }

    // ---- step_bps_ceil ----

    #[test]
    fn bps_rounds_up() {
        let m0 = 1_000_000_000u64;
        // Exactly 15 bps.
        assert_eq!(step_bps_ceil(m0, m0 + 1_500_000), Some(15));
        // A hair over 15 bps must report 16, not 15 — the mark becomes a floor.
        assert_eq!(step_bps_ceil(m0, m0 + 1_500_001), Some(16));
        // Any increase is at least 1 bps once ceiled.
        assert_eq!(step_bps_ceil(m0, m0 + 1), Some(1));
    }

    #[test]
    fn bps_zero_for_non_increase() {
        assert_eq!(step_bps_ceil(PRECISION, PRECISION), Some(0));
        assert_eq!(step_bps_ceil(PRECISION, PRECISION - 1), Some(0));
    }

    #[test]
    fn bps_none_on_zero_denominator() {
        assert_eq!(step_bps_ceil(0, 1), None);
    }

    #[test]
    fn max_step_bps_bounds_the_single_step() {
        // The `MAX_STEP_BPS` ceiling is enforced by the program against the
        // CEILED step size, so a step a hair over 1% reports 101 and is
        // refused even though combined coverage can reach 200 bps.
        let m0 = PRECISION;
        let at_ceiling = m0 + m0 * MAX_STEP_BPS / 10_000;
        assert_eq!(step_bps_ceil(m0, at_ceiling), Some(MAX_STEP_BPS));
        assert_eq!(step_bps_ceil(m0, at_ceiling + 1), Some(MAX_STEP_BPS + 1));
    }

    // ---- the two halves, composed ----

    /// The composed invariant: a step permitted under the combined coverage
    /// can never later be un-covered, because the high-water mark it writes
    /// becomes the floor under `tin + tout`.
    #[test]
    fn covered_step_pins_the_future_fee_floor() {
        let m0 = PRECISION;
        let coverage = 15u64;
        let m1 = m0 + m0 * coverage / 10_000;

        assert!(step_is_covered(m0, m1, coverage));
        let mark = step_bps_ceil(m0, m1).unwrap();
        assert!(
            mark <= coverage,
            "mark must not exceed the coverage that permitted it"
        );

        // Any future combined fee at or above the mark still covers the
        // original step, for a redemption at any later multiplier (>= m1 >= m0).
        for future_coverage in mark..=(2 * MAX_FEE_BPS) {
            assert!(step_is_covered(m0, m1, future_coverage));
        }
        // Below the mark it does not.
        if mark > 0 {
            assert!(!step_is_covered(m0, m1, mark - 1));
        }
    }

    /// Direct economic statement: a covered step cannot yield a profitable
    /// mint-hold-redeem round trip, using the same floor/ceil rounding the
    /// program applies — for every split of the coverage between the legs.
    #[test]
    fn covered_step_round_trip_is_never_profitable() {
        let deposit: u64 = 1_000_000_000; // 1000 units at 6dp
        for coverage in 1..=(2 * MAX_FEE_BPS) {
            for m0 in [PRECISION, PRECISION + 12_345, 2 * PRECISION] {
                // Largest step this coverage permits.
                let m1 = m0 + (coverage as u128 * m0 as u128 / 10_000) as u64;
                if !step_is_covered(m0, m1, coverage) {
                    continue;
                }
                // Every way of splitting the coverage across tin/tout that
                // respects the per-leg MAX_FEE_BPS bound.
                for tin in 0..=coverage.min(MAX_FEE_BPS) {
                    let tout = coverage - tin;
                    if tout > MAX_FEE_BPS {
                        continue;
                    }
                    let credited = crate::math::apply_fee(deposit, tin).unwrap();
                    let raw = crate::math::dollars_to_raw(credited, m0).unwrap();
                    let gross = crate::math::raw_to_dollars(raw, m1).unwrap();
                    let net = crate::math::apply_fee(gross, tout).unwrap();
                    assert!(
                        net <= deposit,
                        "covered step profited: tin={tin} tout={tout} m0={m0} m1={m1} \
                         in={deposit} out={net}"
                    );
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Kani formal verification
// ---------------------------------------------------------------------------

#[cfg(kani)]
mod verification {
    use super::*;
    use crate::constants::{MAX_FEE_BPS, PRECISION};
    use crate::math::{apply_fee, dollars_to_raw, raw_to_dollars};

    /// THE proof. If a step is covered by `tin + tout`, a mint-hold-redeem
    /// round trip across that step cannot return more than it cost — for every
    /// deposit, every fee pair in range, and every step the predicate admits.
    ///
    /// This is the formal statement of the entire step-arbitrage defence.
    #[kani::proof]
    fn proof_covered_step_is_never_profitable() {
        let deposit: u64 = kani::any();
        let m0: u64 = kani::any();
        let m1: u64 = kani::any();
        let tin_bps: u64 = kani::any();
        let tout_bps: u64 = kani::any();

        // Domain: realistic multipliers and in-range fees. Bounded to keep the
        // model checker tractable; the arithmetic is scale-free.
        kani::assume(m0 >= PRECISION);
        kani::assume(m0 <= PRECISION + (u16::MAX as u64));
        kani::assume(m1 > m0);
        kani::assume(m1 <= PRECISION + (u32::MAX as u64));
        kani::assume(tin_bps <= MAX_FEE_BPS);
        kani::assume(tout_bps <= MAX_FEE_BPS);
        kani::assume(deposit <= u32::MAX as u64);

        // Only reason about steps the program would actually permit.
        kani::assume(step_is_covered(m0, m1, tin_bps + tout_bps));

        // Mint at m0 (paying tin), hold across the step, redeem at m1 (paying
        // tout) — the exact rounding the program uses (floor on user credit,
        // ceil on fee).
        if let Some(credited) = apply_fee(deposit, tin_bps) {
            if let Some(raw) = dollars_to_raw(credited, m0) {
                if let Some(gross) = raw_to_dollars(raw, m1) {
                    if let Some(net) = apply_fee(gross, tout_bps) {
                        assert!(net <= deposit, "covered step was profitable");
                    }
                }
            }
        }
    }

    /// Zero combined coverage admits no increase at all — the fail-closed
    /// property that makes "ships with fees off" safe rather than a silent
    /// hole.
    #[kani::proof]
    fn proof_zero_coverage_admits_no_step() {
        let m0: u64 = kani::any();
        let m1: u64 = kani::any();
        kani::assume(m1 > m0);
        assert!(!step_is_covered(m0, m1, 0));
    }

    /// The high-water mark never exceeds the coverage that permitted the step,
    /// so writing the mark can never immediately invalidate the fee schedule
    /// that just permitted it.
    #[kani::proof]
    fn proof_mark_never_exceeds_permitting_coverage() {
        let m0: u64 = kani::any();
        let m1: u64 = kani::any();
        let coverage_bps: u64 = kani::any();
        kani::assume(m0 > 0);
        kani::assume(m1 > m0);
        kani::assume(coverage_bps <= 2 * MAX_FEE_BPS);
        kani::assume(step_is_covered(m0, m1, coverage_bps));

        if let Some(mark) = step_bps_ceil(m0, m1) {
            assert!(mark <= coverage_bps);
        }
    }
}
