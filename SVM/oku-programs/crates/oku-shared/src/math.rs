//! Pure-math primitives shared by the programs. Return `Option` (`None` on
//! overflow or division by zero) so each program maps them to its own error.
//! EVM: `EVM/src/lib/MathLib.sol`.
//!
//! ## Rounding policy
//!
//! Every protocol-flow conversion rounds in favor of the protocol:
//!
//! | Conversion | Rounding | Primitive |
//! |---|---|---|
//! | OkuM -> dollars (redeem) | floor | [`raw_to_dollars`] |
//! | dollars -> OkuM (mint) | floor | [`dollars_to_raw`] |
//! | reserved-balance accounting | ceil | [`mul_div_ceil`] |
//!
//! Use `*_ceil` where a floor would under-reserve against other users' claims.

use crate::constants::PRECISION;

/// `floor(a * b / divisor)`, widened to `u128`. `None` on `divisor == 0` or a
/// result that does not fit `u64`. (`u64 * u64` always fits `u128`.)
#[inline]
pub fn mul_div_floor(a: u64, b: u64, divisor: u64) -> Option<u64> {
    if divisor == 0 {
        return None;
    }
    let product = (a as u128).checked_mul(b as u128)?;
    #[allow(clippy::arithmetic_side_effects)]
    let result = product / (divisor as u128);
    u64::try_from(result).ok()
}

/// OkuM raw amount -> dollar value: `floor(raw_amount * multiplier / PRECISION)`.
///
/// The product can reach ~1.8e43 (beyond `u128`), hence the 256-bit
/// [`crate::wad::mul_div_wad_floor`]. `None` if the result exceeds `u64`.
#[inline]
pub fn raw_to_dollars(raw_amount: u64, multiplier: u128) -> Option<u64> {
    let dollars = crate::wad::mul_div_wad_floor(raw_amount as u128, multiplier)?;
    u64::try_from(dollars).ok()
}

/// Dollar value -> OkuM raw amount: `floor(dollar_value * PRECISION / multiplier)`.
///
/// The numerator is `u64 * 1e18 <= 1.8e37`, inside `u128`, so the narrow
/// primitive suffices (see `wad::mul_div_floor_u128_narrow`). `None` if the
/// result exceeds `u64` or `multiplier == 0`.
#[inline]
pub fn dollars_to_raw(dollar_value: u64, multiplier: u128) -> Option<u64> {
    let raw = crate::wad::mul_div_floor_u128_narrow(dollar_value as u128, PRECISION, multiplier)?;
    u64::try_from(raw).ok()
}

/// `ceil(a * b / divisor)` as `floor((a*b + d - 1) / d)`. `None` on
/// `divisor == 0` or a result that does not fit `u64`. No on-chain caller yet.
///
/// The `d - 1` add cannot overflow: `a*b <= 2^128 - 2^65 + 1` for `u64`
/// operands, so the sum is at most `2^128 - 2^64`.
#[inline]
pub fn mul_div_ceil(a: u64, b: u64, divisor: u64) -> Option<u64> {
    if divisor == 0 {
        return None;
    }
    let d = divisor as u128;
    let product = (a as u128).checked_mul(b as u128)?;
    let numerator = product.checked_add(d.saturating_sub(1))?;
    #[allow(clippy::arithmetic_side_effects)]
    let result = numerator / d;
    u64::try_from(result).ok()
}

// Run: cargo kani --package oku-shared. Inputs are bounded to 8 bits where the
// property is expensive for the solver.
#[cfg(kani)]
mod verification {
    use super::*;

    /// Small-domain bound for tractable proofs (255).
    const DOMAIN_MAX: u64 = u8::MAX as u64;

    /// `divisor == 0` always returns `None`.
    #[kani::proof]
    fn proof_mul_div_floor_none_on_zero_divisor() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let result = mul_div_floor(a, b, 0);
        assert!(result.is_none());
    }

    /// Division-free floor property: `q * d <= a * b < (q + 1) * d`.
    #[kani::proof]
    fn proof_mul_div_floor_correctness_bounded() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let divisor: u64 = kani::any();
        kani::assume(a <= DOMAIN_MAX);
        kani::assume(b <= DOMAIN_MAX);
        kani::assume(divisor > 0);
        kani::assume(divisor <= DOMAIN_MAX);

        let result = mul_div_floor(a, b, divisor);
        let product = (a as u128) * (b as u128);
        let q = result.expect("in-domain inputs must produce a value") as u128;
        let d = divisor as u128;
        assert!(q * d <= product, "quotient too large");
        assert!(product < (q + 1) * d, "quotient too small");
    }

    /// `u64 * u64` never overflows `u128`.
    #[kani::proof]
    fn proof_mul_div_floor_no_u128_overflow() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();

        let product = (a as u128).checked_mul(b as u128);
        assert!(product.is_some(), "u64*u64 must always fit in u128");
    }

    /// Identity at `multiplier == PRECISION`, over the whole `u64` range.
    #[kani::proof]
    fn proof_raw_to_dollars_identity_at_precision() {
        let amount: u64 = kani::any();
        let result = raw_to_dollars(amount, PRECISION);
        assert_eq!(result, Some(amount));
    }

    /// `raw_to_dollars` faithfully narrows `mul_div_wad_floor` (the arithmetic
    /// itself is covered by the exact-floor proof and the `wad` proofs). Not
    /// currently discharged: `cargo kani` does not terminate.
    #[kani::proof]
    fn proof_raw_to_dollars_narrowing_is_faithful() {
        let amount: u64 = kani::any();
        let multiplier: u128 = kani::any();
        kani::assume(multiplier <= crate::constants::MAX_MULTIPLIER);
        let wide = crate::wad::mul_div_wad_floor(amount as u128, multiplier);
        match (raw_to_dollars(amount, multiplier), wide) {
            (Some(d), Some(w)) => assert!(w <= u64::MAX as u128 && d as u128 == w),
            (None, Some(w)) => assert!(w > u64::MAX as u128),
            (None, None) => {}
            (Some(_), None) => panic!("narrowed a value the primitive refused"),
        }
    }

    /// Exact floor: `d * PRECISION <= amount * multiplier < (d + 1) * PRECISION`.
    /// `multiplier <= 2^63` keeps the product in `u128` (far above the reachable
    /// 1e24). Not currently discharged: `cargo kani` does not terminate.
    #[kani::proof]
    fn proof_raw_to_dollars_is_exact_floor() {
        let amount: u64 = kani::any();
        let multiplier: u128 = kani::any();
        kani::assume(multiplier <= 1u128 << 63);

        let product = (amount as u128) * multiplier;
        let d =
            raw_to_dollars(amount, multiplier).expect("quotient fits u64 on this domain") as u128;

        assert!(d * PRECISION <= product, "quotient too large");
        assert!(product < (d + 1) * PRECISION, "quotient too small");
    }

    /// `multiplier == 0` always returns `None`.
    #[kani::proof]
    fn proof_dollars_to_raw_none_on_zero_multiplier() {
        let dollar_value: u64 = kani::any();
        let result = dollars_to_raw(dollar_value, 0);
        assert!(result.is_none());
    }

    /// dollars -> raw -> dollars never returns more than the input.
    #[kani::proof]
    fn proof_dollars_to_raw_round_trip_monotone() {
        let dollar_value: u64 = kani::any();
        let multiplier: u128 = kani::any();
        kani::assume(dollar_value <= u16::MAX as u64); // tight bound for CBMC
        kani::assume(multiplier > 0);
        kani::assume(multiplier <= crate::constants::MAX_MULTIPLIER);

        if let Some(raw) = dollars_to_raw(dollar_value, multiplier) {
            if let Some(dollars_back) = raw_to_dollars(raw, multiplier) {
                assert!(dollars_back <= dollar_value);
            }
        }
    }

    /// `divisor == 0` returns `None` for the ceil variant too.
    #[kani::proof]
    fn proof_mul_div_ceil_none_on_zero_divisor() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        assert!(mul_div_ceil(a, b, 0).is_none());
    }

    /// The `+ (d - 1)` numerator add cannot overflow `u128`.
    #[kani::proof]
    fn proof_mul_div_ceil_numerator_fits_u128() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let d: u64 = kani::any();
        kani::assume(d > 0);
        let product = (a as u128) * (b as u128);
        let add = product.checked_add((d as u128) - 1);
        assert!(add.is_some());
    }

    /// `ceil >= floor`, differing by at most one.
    #[kani::proof]
    fn proof_mul_div_ceil_ge_floor() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let d: u64 = kani::any();
        kani::assume(a <= DOMAIN_MAX);
        kani::assume(b <= DOMAIN_MAX);
        kani::assume(d > 0);
        kani::assume(d <= DOMAIN_MAX);
        if let (Some(ceil_val), Some(floor_val)) = (mul_div_ceil(a, b, d), mul_div_floor(a, b, d)) {
            assert!(ceil_val >= floor_val);
            assert!(ceil_val - floor_val <= 1);
        }
    }

    /// When the product divides evenly, ceil == floor.
    #[kani::proof]
    fn proof_mul_div_ceil_eq_floor_on_exact() {
        let a: u64 = kani::any();
        let b: u64 = kani::any();
        let d: u64 = kani::any();
        kani::assume(a <= DOMAIN_MAX);
        kani::assume(b <= DOMAIN_MAX);
        kani::assume(d > 0);
        kani::assume(d <= DOMAIN_MAX);
        let product = (a as u128) * (b as u128);
        kani::assume(product % (d as u128) == 0);
        if let (Some(ceil_val), Some(floor_val)) = (mul_div_ceil(a, b, d), mul_div_floor(a, b, d)) {
            assert_eq!(ceil_val, floor_val);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `1.10` at WAD scale.
    const M_1_10: u128 = 1_100_000_000_000_000_000;
    /// `1.05` at WAD scale.
    const M_1_05: u128 = 1_050_000_000_000_000_000;

    #[test]
    fn mul_div_floor_basics() {
        assert_eq!(mul_div_floor(1, 3, 2), Some(1));
        assert_eq!(mul_div_floor(10, 10, 4), Some(25));
    }

    #[test]
    fn mul_div_floor_overflow() {
        assert_eq!(mul_div_floor(u64::MAX, u64::MAX, 1), None);
    }

    #[test]
    fn mul_div_floor_div_by_zero() {
        assert_eq!(mul_div_floor(1, 1, 0), None);
    }

    #[test]
    fn raw_to_dollars_works() {
        assert_eq!(raw_to_dollars(1_000_000, PRECISION), Some(1_000_000));
        assert_eq!(raw_to_dollars(1_000_000, M_1_10), Some(1_100_000));
        assert_eq!(raw_to_dollars(100_000_000, M_1_05), Some(105_000_000));
    }

    #[test]
    fn dollars_to_raw_works() {
        assert_eq!(dollars_to_raw(1_000_000, PRECISION), Some(1_000_000));
        assert_eq!(dollars_to_raw(1_100_000, M_1_10), Some(1_000_000));
        assert_eq!(dollars_to_raw(1_000_000, 0), None);
    }

    /// `1e15` raw times a 1e24 multiplier is ~1e39, past `u128::MAX`.
    #[test]
    fn raw_to_dollars_survives_the_old_overflow_region() {
        let raw = 1_000_000_000_000_000u64;
        let mult = 2 * PRECISION;
        assert_eq!(raw_to_dollars(raw, mult), Some(2_000_000_000_000_000));
        assert_eq!(
            raw_to_dollars(u64::MAX, crate::constants::MAX_MULTIPLIER),
            None
        );
    }

    /// Round trip never gains value and loses at most `ceil(m/PRECISION)+1`
    /// units (two chained floors; the bound scales with the multiplier).
    #[test]
    fn round_trip_never_gains_and_loses_within_bound() {
        for mult in [
            PRECISION,
            1_037_419_283_746_192_837u128, // ~1.037x
            2 * PRECISION,
            1_000 * PRECISION,
        ] {
            let bound = mult.div_ceil(PRECISION) as u64 + 1;
            for dollars in [1u64, 999, 1_000_000, 123_456_789, 999_999_999_999] {
                let raw = dollars_to_raw(dollars, mult).unwrap();
                let back = raw_to_dollars(raw, mult).unwrap();
                assert!(
                    back <= dollars,
                    "round trip GAINED value: {back} > {dollars} at m={mult}"
                );
                assert!(
                    dollars - back <= bound,
                    "lost {} units at m={mult}, bound {bound}",
                    dollars - back
                );
            }
        }
    }

    #[test]
    fn mul_div_ceil_basics() {
        assert_eq!(mul_div_ceil(2, 3, 2), Some(3));
        assert_eq!(mul_div_floor(2, 3, 2), Some(3));
        assert_eq!(mul_div_ceil(1, 3, 2), Some(2));
        assert_eq!(mul_div_floor(1, 3, 2), Some(1));
        assert_eq!(mul_div_ceil(7, 1, 3), Some(3));
        assert_eq!(mul_div_floor(7, 1, 3), Some(2));
    }

    #[test]
    fn mul_div_ceil_div_by_zero() {
        assert_eq!(mul_div_ceil(1, 1, 0), None);
    }

    #[test]
    fn mul_div_ceil_overflow() {
        assert_eq!(mul_div_ceil(u64::MAX, u64::MAX, 1), None);
    }

    #[test]
    fn mul_div_ceil_at_u64_max_boundary() {
        assert_eq!(mul_div_ceil(u64::MAX, u64::MAX, u64::MAX), Some(u64::MAX));
        assert_eq!(mul_div_floor(u64::MAX, u64::MAX, u64::MAX), Some(u64::MAX));
    }
}
