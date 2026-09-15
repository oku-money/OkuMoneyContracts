//! Math helpers for the Lite-PSM program.
//!
//! Thin wrappers around the pure-math primitives in `oku-shared` that
//! map `None` → `LitePsmError::Overflow` so the rest of the program can
//! use the `?` operator naturally.
//!
//! Anything tested in `oku_shared::math` is also tested there; the
//! tests below cover only the Anchor-error mapping.

use crate::errors::LitePsmError;
use anchor_lang::prelude::*;
use oku_shared::math as shared;

/// Convert raw OkuM amount to dollar value using the CANONICAL multiplier,
/// with **floor** rounding. Use when the dollar figure is being credited to a
/// user (user gets no more than they earned).
///
/// Formula: `dollar_value = floor(raw_amount * multiplier / PRECISION)`.
///
/// `multiplier` is `u128` since the PRECISION migration: at 1e18 it ranges to
/// `MAX_MULTIPLIER = 1e24`. Callers get it from `helpers::multiplier::current`,
/// NOT from the mint extension.
pub fn raw_to_dollars(raw_amount: u64, multiplier: u128) -> Result<u64> {
    shared::raw_to_dollars(raw_amount, multiplier).ok_or_else(|| error!(LitePsmError::Overflow))
}

/// Convert dollar value to raw OkuM amount using the CANONICAL multiplier.
///
/// Formula: `raw_amount = floor(dollar_value * PRECISION / multiplier)`.
/// Rejects `multiplier == 0` with `ZeroAmount` (the program-side
/// invariant); pure overflow propagates as `Overflow`.
pub fn dollars_to_raw(dollar_value: u64, multiplier: u128) -> Result<u64> {
    require!(multiplier > 0, LitePsmError::ZeroAmount);
    shared::dollars_to_raw(dollar_value, multiplier).ok_or_else(|| error!(LitePsmError::Overflow))
}

#[cfg(test)]
mod tests {
    //! These tests cover the Anchor-error-mapping layer. The underlying
    //! math primitives have their own coverage in
    //! `oku_shared::math::tests`.
    use super::*;
    use oku_shared::PRECISION;

    #[test]
    fn raw_to_dollars_basic_at_par() {
        assert_eq!(raw_to_dollars(1_000_000, PRECISION).unwrap(), 1_000_000);
    }

    #[test]
    fn raw_to_dollars_at_105_multiplier() {
        // At multiplier 1.05 (5% yield), 100_000_000 raw tokens
        // should redeem for 105_000_000 USDC lamports ($105).
        //
        // NOTE the multiplier is WAD-scaled (1e18) since the PRECISION
        // migration — it used to be `1_050_000_000` at 1e9. The token amounts
        // are unchanged: those are still 6-decimal `u64`.
        let multiplier = 1_050_000_000_000_000_000u128; // 1.05 * PRECISION
        let raw_amount = 100_000_000u64; // 100 OkuM (6 decimals)
        let dollars = raw_to_dollars(raw_amount, multiplier).unwrap();
        assert_eq!(dollars, 105_000_000); // $105 USDC

        // Reverse: $100 USDC at 1.05 multiplier = ~95.238095 raw tokens
        let raw_back = dollars_to_raw(100_000_000, multiplier).unwrap();
        assert_eq!(raw_back, 95_238_095); // floor rounding
    }

    /// The migration's headline property, asserted at the program's own
    /// boundary: a rate schedule can now express a realistic APY, which at
    /// PRECISION = 1e9 was impossible (one ulp was >3% APY).
    #[test]
    fn multiplier_resolution_is_fine_enough_to_be_useful() {
        // 1.05 and 1.05 + 1e-9 must be distinguishable, and must price
        // differently on a large position.
        let m1 = 1_050_000_000_000_000_000u128;
        let m2 = m1 + 1_000_000_000; // +1e-9 relative
        let big = 1_000_000_000_000u64; // 1M OkuM
        assert!(raw_to_dollars(big, m2).unwrap() > raw_to_dollars(big, m1).unwrap());
    }

    #[test]
    fn dollars_to_raw_zero_price_is_zero_amount() {
        let err = dollars_to_raw(1_000_000, 0).unwrap_err();
        // `ZeroAmount` is the program-side invariant; the underlying
        // primitive returns `None` on division-by-zero and we surface
        // it as a specific error rather than the generic Overflow.
        let msg = err.to_string();
        assert!(
            msg.contains("Amount must be greater than zero"),
            "got: {msg}"
        );
    }
}
