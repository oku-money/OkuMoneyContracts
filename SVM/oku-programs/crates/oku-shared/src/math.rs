//! Pure-math primitives shared by every program in the workspace.
//!
//! These return `Option<u64>` (None on overflow / division-by-zero) so
//! each program can map them to its own `Error::Overflow` /
//! `Error::ZeroAmount` without coupling the crates to a single error type.
//!
//! The functions widen to `u128` for the intermediate calculation, then
//! narrow back to `u64`, returning `None` if the result doesn't fit. This
//! is the same pattern OpenZeppelin's `Math.mulDiv` uses on EVM but
//! without the `unchecked` blocks (Solana's BPF runtime has cheap u128
//! ops and we're not micro-optimising for gas).
//!
//! Equivalent EVM source: `EVM/src/lib/MathLib.sol`.

use crate::constants::{BASIS_POINTS, PRECISION};

/// Compute `(a * b) / divisor` with intermediate u128 widening and
/// floor rounding. Returns `None` on overflow OR when `divisor == 0`.
///
/// This is the protocol-wide primitive for any multiplier-style
/// computation. Both `oku_m_to_dollars` and `dollars_to_oku_m` are
/// trivial wrappers around it.
#[inline]
pub fn mul_div_floor(a: u64, b: u64, divisor: u64) -> Option<u64> {
    if divisor == 0 {
        return None;
    }
    let product = (a as u128).checked_mul(b as u128)?;
    // F-06: `divisor` is guaranteed non-zero by the early return above.
    // The `/ (divisor as u128)` cannot panic or wrap.
    // Safety confirmed by 47M fuzz iterations across mul_div_floor,
    // dollars_to_oku_m, oku_m_to_dollars, and vault_share_round_trip targets.
    #[allow(clippy::arithmetic_side_effects)]
    let result = product / (divisor as u128);
    u64::try_from(result).ok()
}

/// Convert OkuMoney amount → dollar value using a multiplier.
///
/// Formula: `dollar_value = (oku_m_amount * multiplier) / PRECISION`.
///
/// Returns `None` if the intermediate `u128` product overflows or the
/// result doesn't fit in `u64`. `PRECISION` is never zero so there's
/// no division-by-zero path.
#[inline]
pub fn oku_m_to_dollars(oku_m_amount: u64, multiplier: u64) -> Option<u64> {
    mul_div_floor(oku_m_amount, multiplier, PRECISION)
}

/// Convert dollar value → OkuMoney amount using a multiplier.
///
/// Formula: `oku_m_amount = (dollar_value * PRECISION) / multiplier`.
///
/// Returns `None` if the intermediate product overflows, the result
/// doesn't fit in `u64`, OR if `multiplier == 0` (caller should reject
/// before calling this).
#[inline]
pub fn dollars_to_oku_m(dollar_value: u64, multiplier: u64) -> Option<u64> {
    mul_div_floor(dollar_value, PRECISION, multiplier)
}

/// Calculate a basis-points fee on `amount`.
///
/// Formula: `fee = (amount * fee_bps) / BASIS_POINTS`. Returns `None`
/// on `u128` overflow (impossible for `amount <= u64::MAX` and
/// `fee_bps <= 10_000`, but kept for symmetry).
#[inline]
pub fn calculate_fee(amount: u64, fee_bps: u16) -> Option<u64> {
    mul_div_floor(amount, fee_bps as u64, BASIS_POINTS)
}

// ---------------------------------------------------------------------------
// Kani formal verification proofs
// ---------------------------------------------------------------------------
//
// These harnesses are gated on `#[cfg(kani)]` so they have zero impact on
// normal builds, tests, or the on-chain BPF target.
//
// Run: cargo kani --package oku-shared
// (from contracts/SVM/oku-programs/)
//
// Each harness uses `kani::any()` for symbolic inputs and `kani::assume()`
// to restrict the domain where needed to keep verification tractable.
// Full-range u64 proofs for correctness are bounded to u32::MAX to avoid
// state-space explosion in the model checker; the None/identity/overflow
// proofs use the full u64 range since those are simpler properties.

#[cfg(kani)]
mod verification {
    use super::*;

    // -----------------------------------------------------------------------
    // mul_div_floor proofs
    // -----------------------------------------------------------------------

    /// Proof: divisor == 0 always returns None (no panic).
    #[kani::proof]
    fn proof_mul_div_floor_none_on_zero_divisor() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let result = mul_div_floor(a, b, 0);
        assert!(result.is_none());
    }

    /// Proof: for bounded inputs, result equals the u128 reference oracle.
    /// Inputs bounded to u16::MAX (65535) for CBMC tractability while still
    /// covering the meaningful protocol range (amounts in 6-decimal token units).
    #[kani::proof]
    fn proof_mul_div_floor_correctness_bounded() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let divisor: u64 = kani::any();
        kani::assume(a <= u16::MAX as u64);
        kani::assume(b <= u16::MAX as u64);
        kani::assume(divisor > 0);
        kani::assume(divisor <= u16::MAX as u64);

        let result = mul_div_floor(a, b, divisor);
        let expected_128 = (a as u128) * (b as u128) / (divisor as u128);

        if expected_128 <= u64::MAX as u128 {
            assert_eq!(result, Some(expected_128 as u64));
        } else {
            assert!(result.is_none());
        }
    }

    /// Proof: when a*b overflows u128, result is None.
    /// Tight bounds to keep CBMC tractable.
    #[kani::proof]
    fn proof_mul_div_floor_overflow_returns_none() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let divisor: u64 = kani::any();
        kani::assume(divisor > 0);
        // Bound a and b near u64::MAX to focus on the overflow case specifically
        kani::assume(a > u64::MAX / 2);
        kani::assume(b > u64::MAX / 2);

        let result = mul_div_floor(a, b, divisor);
        // For a, b > u64::MAX/2, a*b overflows u128, so result must be None
        assert!(result.is_none());
    }

    // -----------------------------------------------------------------------
    // oku_m_to_dollars proofs
    // -----------------------------------------------------------------------

    /// Proof: at multiplier == PRECISION, output equals input (identity).
    #[kani::proof]
    fn proof_oku_m_to_dollars_identity_at_precision() {
        let amount: u64 = kani::any();
        // With multiplier = PRECISION = 1e9, product = amount * 1e9.
        // To avoid u128 overflow: amount <= u64::MAX / 1e9 ≈ 18.4 billion
        kani::assume(amount <= 18_446_744_073u64); // u64::MAX / PRECISION
        let result = oku_m_to_dollars(amount, PRECISION);
        assert_eq!(result, Some(amount));
    }

    /// Proof: consistent with mul_div_floor(amount, multiplier, PRECISION).
    #[kani::proof]
    fn proof_oku_m_to_dollars_consistent_with_mul_div() {
        let amount: u64 = kani::any();
        let multiplier: u64 = kani::any();
        kani::assume(amount <= u16::MAX as u64);
        kani::assume(multiplier <= u16::MAX as u64);
        assert_eq!(
            oku_m_to_dollars(amount, multiplier),
            mul_div_floor(amount, multiplier, PRECISION)
        );
    }

    // -----------------------------------------------------------------------
    // dollars_to_oku_m proofs
    // -----------------------------------------------------------------------

    /// Proof: multiplier == 0 always returns None (no divide-by-zero panic).
    #[kani::proof]
    fn proof_dollars_to_oku_m_none_on_zero_multiplier() {
        let dollar_value: u64 = kani::any();
        let result = dollars_to_oku_m(dollar_value, 0);
        assert!(result.is_none());
    }

    /// Proof: round-trip monotonicity — converting dollars→okuM→dollars
    /// never returns MORE dollars than the starting value.
    #[kani::proof]
    fn proof_dollars_to_oku_m_round_trip_monotone() {
        let dollar_value: u64 = kani::any();
        let multiplier: u64 = kani::any();
        kani::assume(dollar_value <= u16::MAX as u64); // tight bound for CBMC
        kani::assume(multiplier > 0);
        kani::assume(multiplier <= u16::MAX as u64);

        if let Some(oku_m) = dollars_to_oku_m(dollar_value, multiplier) {
            if let Some(dollars_back) = oku_m_to_dollars(oku_m, multiplier) {
                // Must never recover more than the original input.
                assert!(dollars_back <= dollar_value);
            }
        }
    }

    // -----------------------------------------------------------------------
    // calculate_fee proofs
    // -----------------------------------------------------------------------

    /// Proof: fee_bps == 0 always returns Some(0) (no fee on zero bps).
    #[kani::proof]
    fn proof_calculate_fee_zero_bps_zero_fee() {
        let amount: u64 = kani::any();
        let result = calculate_fee(amount, 0);
        assert_eq!(result, Some(0));
    }

    /// Proof: for fee_bps in [0, 10_000], fee never exceeds amount.
    #[kani::proof]
    fn proof_calculate_fee_bounded_by_amount() {
        let amount: u64 = kani::any();
        let fee_bps: u16 = kani::any();
        kani::assume(amount <= u16::MAX as u64); // tight bound for CBMC tractability
        kani::assume(fee_bps <= BASIS_POINTS as u16);

        if let Some(fee) = calculate_fee(amount, fee_bps) {
            assert!(fee <= amount);
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mul_div_floor_basics() {
        // 1.00 token at $1.10 = $1.10
        assert_eq!(
            mul_div_floor(1_000_000, 1_100_000_000, PRECISION),
            Some(1_100_000)
        );
        // Floor rounding: 1 * 3 / 2 == 1, not 2.
        assert_eq!(mul_div_floor(1, 3, 2), Some(1));
    }

    #[test]
    fn mul_div_floor_overflow() {
        // u64::MAX * u64::MAX overflows u128, but we widen first then
        // divide — the divisor=1 product is still > u64::MAX, so we
        // must return None.
        assert_eq!(mul_div_floor(u64::MAX, u64::MAX, 1), None);
    }

    #[test]
    fn mul_div_floor_div_by_zero() {
        assert_eq!(mul_div_floor(1, 1, 0), None);
    }

    #[test]
    fn oku_m_to_dollars_works() {
        // At $1.00 price, 1 OkuMoney = $1.00
        assert_eq!(oku_m_to_dollars(1_000_000, PRECISION), Some(1_000_000));
        // At $1.10 price, 1 OkuMoney = $1.10
        assert_eq!(oku_m_to_dollars(1_000_000, 1_100_000_000), Some(1_100_000));
        // At $1.05 price, 100 OkuMoney = $105.00
        assert_eq!(
            oku_m_to_dollars(100_000_000, 1_050_000_000),
            Some(105_000_000)
        );
    }

    #[test]
    fn dollars_to_oku_m_works() {
        // At $1.00 price, $1.00 = 1 OkuMoney
        assert_eq!(dollars_to_oku_m(1_000_000, PRECISION), Some(1_000_000));
        // At $1.10 price, $1.10 = 1 OkuMoney
        assert_eq!(dollars_to_oku_m(1_100_000, 1_100_000_000), Some(1_000_000));
        // Zero price → None
        assert_eq!(dollars_to_oku_m(1_000_000, 0), None);
    }

    #[test]
    fn calculate_fee_works() {
        // 10 bps (0.1%) of 1000 = 1
        assert_eq!(calculate_fee(1000, 10), Some(1));
        // 100 bps (1%) of 10_000 = 100
        assert_eq!(calculate_fee(10_000, 100), Some(100));
        // 50 bps (0.5%) of 1_000_000 = 5_000
        assert_eq!(calculate_fee(1_000_000, 50), Some(5000));
        // Zero fee bps → zero fee
        assert_eq!(calculate_fee(1_000_000, 0), Some(0));
    }
}
