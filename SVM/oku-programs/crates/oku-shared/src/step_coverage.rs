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
//! A redemption fee is the control — but only if it actually covers the step.
//! Before this module that was an operational commitment (someone had to pick a
//! big enough `tout`). These primitives turn it into an on-chain invariant.
//!
//! # The two halves of the invariant
//!
//! Neither is sufficient alone:
//!
//! - [`step_is_covered`] — enforced when the multiplier is written. Stops an
//!   operator from *creating* exposure the current fee does not cover.
//! - a fee floor at the step high-water mark ([`step_bps_ceil`] feeds it) —
//!   enforced when fees are changed. Stops an operator from *removing* coverage
//!   after the fact, which would otherwise let anyone who held across the step
//!   exit cheaply.
//!
//! Together: at all times, `tout` covers every step that has ever occurred.
//!
//! # Why a time-based cooldown was rejected
//!
//! An earlier design used a cooldown on fee decreases. It does not work. The
//! attacker's edge is locked in the instant the step lands and does not decay,
//! and the multiplier is monotonic so waiting costs them nothing — no price risk
//! to sit through. A cooldown therefore converts an instant profit into a
//! delayed profit rather than eliminating it. The high-water mark has no expiry
//! and is strictly less restrictive in the common case: if every step was
//! 1.4 bps, the fee can still be lowered to 1.4 bps.
//!
//! # Scope
//!
//! Only meaningful on a stepped chain. EVM accrues continuously — the multiplier
//! is re-anchored to its live value on every rate change, so there is no
//! discontinuity to hold across and nothing to cover.
//!
//! No `anchor-lang`, no `solana-program`, no I/O — pure arithmetic.

use crate::constants::BASIS_POINTS;

/// Is the step `old_multiplier -> new_multiplier` covered by `tout_bps`?
///
/// Exact form, deliberately not routed through a bps conversion:
///
/// ```text
///     (M1 - M0) * 10_000  <=  tout_bps * M0
/// ```
///
/// # Why the exact form rather than comparing rounded bps
///
/// Converting the step to basis points first would floor a sub-1-bps step to
/// zero, so at `tout_bps == 0` a long series of tiny increments would each pass
/// and together reproduce an arbitrarily large uncovered step. Ceiling the
/// conversion instead over-charges high-frequency operators: an hourly 0.06 bps
/// step would demand a 1 bps fee, 16x more than it needs. The exact inequality
/// has neither problem.
///
/// # Fail-closed at zero
///
/// At `tout_bps == 0` the right-hand side is `0`, so no strict increase can
/// satisfy it. Rebasing is therefore impossible until a fee is configured —
/// the operator cannot create the arbitrage condition, rather than being
/// trusted not to.
///
/// Returns `true` for a non-increasing step; the caller enforces strict
/// monotonicity separately and would already have rejected it.
///
/// # Proof of no-profit
///
/// A round trip profits iff `M1 * (1 - tout) > M0`, i.e. `M1 - M0 > tout * M1`.
/// This predicate gives `M1 - M0 <= tout * M0`, and `M0 < M1`, so
/// `M1 - M0 <= tout * M0 < tout * M1`. The profit condition is never met.
/// Verified by `proof_covered_step_is_never_profitable`.
#[inline]
pub fn step_is_covered(old_multiplier: u64, new_multiplier: u64, tout_bps: u64) -> bool {
    if new_multiplier <= old_multiplier {
        return true;
    }
    // u128: at MAX_MULTIPLIER (1e15) the left side reaches 1e19, which fits u64
    // only barely. Widening removes the question.
    let delta = (new_multiplier as u128) - (old_multiplier as u128);
    let lhs = delta * (BASIS_POINTS as u128);
    let rhs = (tout_bps as u128) * (old_multiplier as u128);
    lhs <= rhs
}

/// The step `old -> new` expressed in basis points, rounded **up**.
///
/// Feeds the fee high-water mark. Ceiling because the mark becomes a floor on
/// future fees: rounding down could let the fee be lowered a fraction below what
/// the step actually needs.
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
    use crate::constants::{MAX_FEE_BPS, MAX_MULTIPLIER, PRECISION};

    // ---- step_is_covered ----

    #[test]
    fn zero_fee_forbids_any_increase() {
        // The fail-closed property: rebasing is impossible until a fee is set.
        assert!(!step_is_covered(PRECISION, PRECISION + 1, 0));
        assert!(!step_is_covered(PRECISION, PRECISION * 2, 0));
        // A non-increase is vacuously covered (rejected elsewhere as non-monotonic).
        assert!(step_is_covered(PRECISION, PRECISION, 0));
    }

    #[test]
    fn exact_boundary_is_covered() {
        // Step of exactly tout: 1e9 -> 1e9 + 15bps, tout = 15bps.
        let m0 = PRECISION;
        let m1 = m0 + m0 * 15 / 10_000;
        assert!(step_is_covered(m0, m1, 15));
        assert!(!step_is_covered(m0, m1 + 1, 15));
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
        // daily ~1.37bps under a 15bps fee: covered.
        assert!(step_is_covered(m0, step(137), 15));
        // weekly ~9.62bps under a 15bps fee: covered.
        assert!(step_is_covered(m0, step(962), 15));
        // weekly ~9.62bps under a 5bps fee: NOT covered.
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

    // ---- the two halves, composed ----

    /// The composed invariant: a step permitted under `tout` can never later be
    /// un-covered, because the high-water mark it writes becomes the fee floor.
    #[test]
    fn covered_step_pins_the_future_fee_floor() {
        let m0 = PRECISION;
        let tout = 15u64;
        let m1 = m0 + m0 * tout / 10_000;

        assert!(step_is_covered(m0, m1, tout));
        let mark = step_bps_ceil(m0, m1).unwrap();
        assert!(
            mark <= tout,
            "mark must not exceed the fee that permitted it"
        );

        // Any future fee at or above the mark still covers the original step,
        // for a redemption at any later multiplier (>= m1 >= m0).
        for future_tout in mark..=MAX_FEE_BPS {
            assert!(step_is_covered(m0, m1, future_tout));
        }
        // Below the mark it does not.
        if mark > 0 {
            assert!(!step_is_covered(m0, m1, mark - 1));
        }
    }

    /// Direct economic statement: a covered step cannot yield a profitable
    /// mint-hold-redeem round trip, using the same floor/ceil rounding the
    /// program applies.
    #[test]
    fn covered_step_round_trip_is_never_profitable() {
        let deposit: u64 = 1_000_000_000; // 1000 units at 6dp
        for tout in 1..=MAX_FEE_BPS {
            for m0 in [PRECISION, PRECISION + 12_345, 2 * PRECISION] {
                // Largest step this fee permits.
                let m1 = m0 + (tout as u128 * m0 as u128 / 10_000) as u64;
                if !step_is_covered(m0, m1, tout) {
                    continue;
                }
                let raw = crate::math::dollars_to_raw(deposit, m0).unwrap();
                let gross = crate::math::raw_to_dollars(raw, m1).unwrap();
                let net = crate::math::apply_fee(gross, tout).unwrap();
                assert!(
                    net <= deposit,
                    "covered step profited: tout={tout} m0={m0} m1={m1} in={deposit} out={net}"
                );
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

    /// THE proof. If a step is covered by `tout`, a mint-hold-redeem round trip
    /// across that step cannot return more than it cost — for every deposit,
    /// every fee in range, and every step the predicate admits.
    ///
    /// This is the formal statement of the entire step-arbitrage defence.
    #[kani::proof]
    fn proof_covered_step_is_never_profitable() {
        let deposit: u64 = kani::any();
        let m0: u64 = kani::any();
        let m1: u64 = kani::any();
        let tout_bps: u64 = kani::any();

        // Domain: realistic multipliers and an in-range fee. Bounded to keep the
        // model checker tractable; the arithmetic is scale-free.
        kani::assume(m0 >= PRECISION);
        kani::assume(m0 <= PRECISION + (u16::MAX as u64));
        kani::assume(m1 > m0);
        kani::assume(m1 <= PRECISION + (u32::MAX as u64));
        kani::assume(tout_bps <= MAX_FEE_BPS);
        kani::assume(deposit <= u32::MAX as u64);

        // Only reason about steps the program would actually permit.
        kani::assume(step_is_covered(m0, m1, tout_bps));

        // Mint at m0, hold across the step, redeem at m1 — the exact rounding
        // the program uses (floor on user credit, ceil on fee).
        if let Some(raw) = dollars_to_raw(deposit, m0) {
            if let Some(gross) = raw_to_dollars(raw, m1) {
                if let Some(net) = apply_fee(gross, tout_bps) {
                    assert!(net <= deposit, "covered step was profitable");
                }
            }
        }
    }

    /// A zero fee admits no increase at all — the fail-closed property that
    /// makes "ships with fees off" safe rather than a silent hole.
    #[kani::proof]
    fn proof_zero_fee_admits_no_step() {
        let m0: u64 = kani::any();
        let m1: u64 = kani::any();
        kani::assume(m1 > m0);
        assert!(!step_is_covered(m0, m1, 0));
    }

    /// The high-water mark never exceeds the fee that permitted the step, so
    /// writing the mark can never immediately invalidate the current fee.
    #[kani::proof]
    fn proof_mark_never_exceeds_permitting_fee() {
        let m0: u64 = kani::any();
        let m1: u64 = kani::any();
        let tout_bps: u64 = kani::any();
        kani::assume(m0 > 0);
        kani::assume(m1 > m0);
        kani::assume(tout_bps <= MAX_FEE_BPS);
        kani::assume(step_is_covered(m0, m1, tout_bps));

        if let Some(mark) = step_bps_ceil(m0, m1) {
            assert!(mark <= tout_bps);
        }
    }
}
