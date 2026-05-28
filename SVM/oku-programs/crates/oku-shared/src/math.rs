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
