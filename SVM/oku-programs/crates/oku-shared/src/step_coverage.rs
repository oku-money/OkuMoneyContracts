//! Multiplier-step sizing primitive, and the proof that the static fee floor
//! covers every step it admits.
//!
//! # The problem
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
//! length is irrelevant to them. The fees are the only control.
//!
//! # The invariant, and why it needs no state
//!
//! Coverage is enforced as a relationship between two constants rather than as
//! a runtime read:
//!
//! ```text
//!     set_multiplier / distribute_yield:  step_bps <= MAX_STEP_BPS
//!     set_fees:                           tin_bps  >= MAX_STEP_BPS
//!                                         tout_bps >= MAX_STEP_BPS
//! ```
//!
//! Every step the program can take is therefore covered on each leg
//! independently, for all time. [`step_bps_ceil`] is all this module needs to
//! provide; the comparison itself is a single `<=` at each site.
//!
//! # What this replaced
//!
//! An earlier design read `step_is_covered(tin + tout)` at multiplier-write
//! time, ratcheted a `max_step_bps` high-water mark, floored later `set_fees`
//! calls against that mark, and provided a cold `reset_step_high_water_mark`
//! escape hatch to clear it. Three coupled mutable mechanisms maintaining one
//! inequality, plus an escape hatch whose honest precondition — that supply
//! outstanding at the time of a large past step had substantially turned over —
//! was not verifiable on-chain.
//!
//! The static floor is strictly stronger (the ratchet only ever covered steps
//! that had actually occurred), needs no account space, and has no escape hatch
//! to model. Changing cadence is now an edit to `MAX_STEP_BPS`, reviewed as
//! code.
//!
//! # Why per-leg rather than combined
//!
//! A combined `tin + tout >= step` bound is sufficient for a single chain and
//! insufficient across two. A cross-chain round trip pays `tin` on the chain it
//! mints on and `tout` on the chain it redeems on, so fees of `(0, 2x)` here
//! and `(2x, 0)` on EVM each satisfy a combined check while the pair pays
//! nothing at all. Only a per-leg floor survives that composition. The cost is
//! that the minimum round trip is `2 * MAX_STEP_BPS` rather than
//! `MAX_STEP_BPS`.
//!
//! # Why a time-based cooldown was rejected
//!
//! An earlier design used a cooldown on fee decreases. It does not work. The
//! attacker's edge is locked in the instant the step lands and does not decay,
//! and the multiplier is monotonic so waiting costs them nothing — no price
//! risk to sit through. A cooldown converts an instant profit into a delayed
//! profit rather than eliminating it.
//!
//! Contrast the sync window ([`crate::sync_window`]), where a time lock IS the
//! right tool: cross-chain divergence is transient and self-correcting, so
//! waiting genuinely removes the edge.
//!
//! # Scope
//!
//! Chain-symmetric. The EVM twin enforces the identical pair of rules in
//! `OkuM.setOkuMultiplier` and `SubscriptionModule.setFees`.
//!
//! No `anchor-lang`, no `solana-program`, no I/O — pure arithmetic.

use crate::constants::BASIS_POINTS;

/// The step `old -> new` expressed in basis points, rounded **up**.
///
/// Feeds the `MAX_STEP_BPS` single-step ceiling. Ceiling rather than floor
/// because the result is compared against a bound the step must not exceed:
/// rounding down would let a fractionally-oversized step through, and at
/// sub-1-bps granularity would floor a real increase to zero.
///
/// Returns `0` for a non-increasing step (callers enforce strict monotonicity
/// separately and would already have rejected it). `None` only on a zero
/// denominator or a `u64` overflow, which `MAX_MULTIPLIER` makes unreachable in
/// practice.
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
    use crate::constants::{MAX_FEE_BPS, MAX_STEP_BPS, PRECISION};

    // ---- step_bps_ceil ----

    #[test]
    fn bps_rounds_up() {
        let m0 = 1_000_000_000u64;
        // Exactly 15 bps.
        assert_eq!(step_bps_ceil(m0, m0 + 1_500_000), Some(15));
        // A hair over 15 bps must report 16, not 15 — the value is compared
        // against a ceiling the step must not exceed.
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
        // The ceiling is enforced against the CEILED step size, so a step a
        // hair over the bound reports one more and is refused.
        let m0 = PRECISION;
        let at_ceiling = m0 + m0 * MAX_STEP_BPS / 10_000;
        assert_eq!(step_bps_ceil(m0, at_ceiling), Some(MAX_STEP_BPS));
        assert_eq!(step_bps_ceil(m0, at_ceiling + 1), Some(MAX_STEP_BPS + 1));
    }

    #[test]
    fn realistic_daily_cadence_fits_the_bound() {
        // ~1.37 bps daily at 5% APY, against a 5 bps bound: ~3.5x headroom, so
        // a missed day is caught up in one write.
        let m0 = PRECISION;
        let daily = m0 + m0 * 137 / 1_000_000;
        assert!(step_bps_ceil(m0, daily).unwrap() <= MAX_STEP_BPS);
        // Three missed days still fit.
        let three_days = m0 + m0 * 411 / 1_000_000;
        assert!(step_bps_ceil(m0, three_days).unwrap() <= MAX_STEP_BPS);
    }

    // ---- the composed invariant ----

    /// The whole step-arbitrage defence, stated as a test: for every step the
    /// program admits and every fee schedule `set_fees` admits, a
    /// mint-hold-redeem round trip returns no more than it cost.
    ///
    /// Note what is NOT quantified here: there is no dependence on which steps
    /// happened previously, because the floor is static. That absence is the
    /// simplification.
    #[test]
    fn admissible_step_under_admissible_fees_is_never_profitable() {
        let deposit: u64 = 1_000_000_000; // 1000 units at 6dp
        for m0 in [PRECISION, PRECISION + 12_345, 2 * PRECISION] {
            // Every step the program admits, up to and including the ceiling.
            for step_bps in 1..=MAX_STEP_BPS {
                let m1 = m0 + (step_bps as u128 * m0 as u128 / 10_000) as u64;
                if step_bps_ceil(m0, m1).unwrap() > MAX_STEP_BPS {
                    continue;
                }
                // Every fee schedule `set_fees` admits: each leg in
                // [MAX_STEP_BPS, MAX_FEE_BPS]. Sampling the floor and the
                // ceiling of each leg is sufficient — the round-trip payout is
                // monotonically decreasing in both fees, so the floor pair is
                // the worst case.
                for tin in [MAX_STEP_BPS, MAX_FEE_BPS] {
                    for tout in [MAX_STEP_BPS, MAX_FEE_BPS] {
                        let credited = crate::math::apply_fee(deposit, tin).unwrap();
                        let raw = crate::math::dollars_to_raw(credited, m0).unwrap();
                        let gross = crate::math::raw_to_dollars(raw, m1).unwrap();
                        let net = crate::math::apply_fee(gross, tout).unwrap();
                        assert!(
                            net <= deposit,
                            "admissible step profited: tin={tin} tout={tout} \
                             m0={m0} m1={m1} step={step_bps} in={deposit} out={net}"
                        );
                    }
                }
            }
        }
    }

    /// The cross-chain composition the per-leg floor exists for: minting on one
    /// chain and redeeming on the other pays `tin` from chain A and `tout` from
    /// chain B, and must still be lossy across a full step of divergence.
    ///
    /// Under a COMBINED floor this would fail — `(0, 2x)` and `(2x, 0)` both
    /// satisfy `tin + tout >= step` while the cross pair pays nothing.
    #[test]
    fn cross_chain_leg_pairing_is_never_profitable() {
        let deposit: u64 = 1_000_000_000;
        let m0 = PRECISION;
        // Worst case: a full maximal step of divergence between the chains.
        let m1 = m0 + m0 * MAX_STEP_BPS / 10_000;
        // Mint on the lagging chain at its floor `tin`, redeem on the leading
        // chain at its floor `tout` — the cheapest possible pairing.
        let tin_a = MAX_STEP_BPS;
        let tout_b = MAX_STEP_BPS;
        let credited = crate::math::apply_fee(deposit, tin_a).unwrap();
        let raw = crate::math::dollars_to_raw(credited, m0).unwrap();
        let gross = crate::math::raw_to_dollars(raw, m1).unwrap();
        let net = crate::math::apply_fee(gross, tout_b).unwrap();
        assert!(
            net <= deposit,
            "cross-chain pairing profited: in={deposit} out={net}"
        );
    }
}

// ---------------------------------------------------------------------------
// Kani formal verification
// ---------------------------------------------------------------------------

#[cfg(kani)]
mod verification {
    use super::*;
    use crate::constants::{MAX_FEE_BPS, MAX_STEP_BPS, PRECISION};
    use crate::math::{apply_fee, dollars_to_raw, raw_to_dollars};

    /// THE proof. For every step the program admits (`step_bps <=
    /// MAX_STEP_BPS`) and every fee schedule `set_fees` admits (each leg in
    /// `[MAX_STEP_BPS, MAX_FEE_BPS]`), a mint-hold-redeem round trip cannot
    /// return more than it cost.
    ///
    /// This is the formal statement of the entire step-arbitrage defence. It is
    /// strictly simpler than the proof it replaces: the old one had to assume
    /// `step_is_covered(m0, m1, tin + tout)` — a relation between the step and
    /// the live fee schedule — whereas this quantifies the two independently,
    /// because the constants already guarantee the relation.
    #[kani::proof]
    fn proof_admissible_step_under_admissible_fees_is_never_profitable() {
        let deposit: u64 = kani::any();
        let m0: u64 = kani::any();
        let m1: u64 = kani::any();
        let tin_bps: u64 = kani::any();
        let tout_bps: u64 = kani::any();

        // Domain: realistic multipliers. Bounded to keep the model checker
        // tractable; the arithmetic is scale-free.
        kani::assume(m0 >= PRECISION);
        kani::assume(m0 <= PRECISION + (u16::MAX as u64));
        kani::assume(m1 > m0);
        kani::assume(m1 <= PRECISION + (u32::MAX as u64));
        kani::assume(deposit <= u32::MAX as u64);

        // Exactly the fee schedules `set_fees` admits.
        kani::assume(tin_bps >= MAX_STEP_BPS && tin_bps <= MAX_FEE_BPS);
        kani::assume(tout_bps >= MAX_STEP_BPS && tout_bps <= MAX_FEE_BPS);

        // Exactly the steps `set_multiplier` admits.
        if let Some(step_bps) = step_bps_ceil(m0, m1) {
            kani::assume(step_bps <= MAX_STEP_BPS);

            // Mint at m0 (paying tin), hold across the step, redeem at m1
            // (paying tout) — the exact rounding the program uses.
            if let Some(credited) = apply_fee(deposit, tin_bps) {
                if let Some(raw) = dollars_to_raw(credited, m0) {
                    if let Some(gross) = raw_to_dollars(raw, m1) {
                        if let Some(net) = apply_fee(gross, tout_bps) {
                            assert!(net <= deposit, "admissible step was profitable");
                        }
                    }
                }
            }
        }
    }

    /// The ceiling rounding is conservative: a step reported as within the
    /// bound really is within the bound, with no fractional slack. Guards the
    /// `div_ceil` against being weakened to a truncating divide.
    #[kani::proof]
    fn proof_step_bps_ceil_is_conservative() {
        let m0: u64 = kani::any();
        let m1: u64 = kani::any();
        kani::assume(m0 >= PRECISION);
        kani::assume(m0 <= PRECISION + (u32::MAX as u64));
        kani::assume(m1 > m0);
        kani::assume(m1 <= PRECISION + (u32::MAX as u64));

        if let Some(bps) = step_bps_ceil(m0, m1) {
            // The reported bps, applied back to m0, reaches at least m1 — i.e.
            // it never under-reports the step.
            let reconstructed = (m0 as u128) + (bps as u128 * m0 as u128) / (BASIS_POINTS as u128);
            assert!(reconstructed >= m1 as u128, "step_bps_ceil under-reported");
        }
    }
}
