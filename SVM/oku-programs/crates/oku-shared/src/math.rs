//! Pure-math primitives shared by the programs. Return `Option` (`None` on
//! overflow or division by zero) so each program maps them to its own error.
//! EVM: `EVM/src/lib/MathLib.sol`.
//!
//! ## Rounding policy
//!
//! Both conversions floor, in favor of the protocol:
//!
//! | Conversion | Primitive |
//! |---|---|
//! | OkuM -> dollars (redeem) | [`raw_to_dollars`] |
//! | dollars -> OkuM (mint) | [`dollars_to_raw`] |

use crate::constants::PRECISION;

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

// Run: cargo kani --package oku-shared.
#[cfg(kani)]
mod verification {
    use super::*;

    /// `multiplier == 0` always returns `None`.
    #[kani::proof]
    fn proof_dollars_to_raw_none_on_zero_multiplier() {
        let dollar_value: u64 = kani::any();
        let result = dollars_to_raw(dollar_value, 0);
        assert!(result.is_none());
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
}
