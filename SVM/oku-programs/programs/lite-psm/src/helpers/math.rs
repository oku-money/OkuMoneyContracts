//! `oku-shared` conversions with `None` mapped to `LitePsmError::Overflow`.

use crate::errors::LitePsmError;
use anchor_lang::prelude::*;
use oku_shared::math as shared;

/// Raw OkuM -> dollars, floor: `raw * multiplier / PRECISION` (redeem direction).
/// `multiplier` is the canonical value from `helpers::multiplier`, never the mint extension.
pub fn raw_to_dollars(raw_amount: u64, multiplier: u128) -> Result<u64> {
    shared::raw_to_dollars(raw_amount, multiplier).ok_or_else(|| error!(LitePsmError::Overflow))
}

/// Dollars -> raw OkuM, floor: `dollars * PRECISION / multiplier` (mint direction).
/// `multiplier == 0` is `ZeroAmount`; overflow is `Overflow`.
pub fn dollars_to_raw(dollar_value: u64, multiplier: u128) -> Result<u64> {
    require!(multiplier > 0, LitePsmError::ZeroAmount);
    shared::dollars_to_raw(dollar_value, multiplier).ok_or_else(|| error!(LitePsmError::Overflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use oku_shared::PRECISION;

    #[test]
    fn raw_to_dollars_basic_at_par() {
        assert_eq!(raw_to_dollars(1_000_000, PRECISION).unwrap(), 1_000_000);
    }

    #[test]
    fn raw_to_dollars_at_105_multiplier() {
        let multiplier = 1_050_000_000_000_000_000u128; // 1.05
        let dollars = raw_to_dollars(100_000_000, multiplier).unwrap();
        assert_eq!(dollars, 105_000_000);

        let raw_back = dollars_to_raw(100_000_000, multiplier).unwrap();
        assert_eq!(raw_back, 95_238_095); // floor
    }

    #[test]
    fn multiplier_resolution_is_fine_enough_to_be_useful() {
        // 1.05 and 1.05 + 1e-9 price differently on a large position.
        let m1 = 1_050_000_000_000_000_000u128;
        let m2 = m1 + 1_000_000_000; // +1e-9 relative
        let big = 1_000_000_000_000u64; // 1M OkuM
        assert!(raw_to_dollars(big, m2).unwrap() > raw_to_dollars(big, m1).unwrap());
    }

    #[test]
    fn dollars_to_raw_zero_price_is_zero_amount() {
        let err = dollars_to_raw(1_000_000, 0).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("Amount must be greater than zero"),
            "got: {msg}"
        );
    }
}
