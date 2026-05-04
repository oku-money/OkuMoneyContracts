//! Pure-math helpers for the Lite-PSM program.
//!
//! Conversions between OkuMoney token amounts and dollar values, and the bridge
//! fee calculation. Used across `instructions/psm.rs` and `instructions/bridge.rs`.

use crate::constants::{BASIS_POINTS, PRECISION};
use crate::errors::LitePsmError;
use anchor_lang::prelude::*;

/// Convert OkuMoney amount to dollar value using `oku_m_price`.
///
/// Formula: `dollar_value = (oku_m_amount * oku_m_price) / PRECISION`
pub fn oku_m_to_dollars(oku_m_amount: u64, oku_m_price: u64) -> Result<u64> {
    let result = (oku_m_amount as u128)
        .checked_mul(oku_m_price as u128)
        .ok_or(LitePsmError::Overflow)?
        .checked_div(PRECISION as u128)
        .ok_or(LitePsmError::Overflow)?;

    require!(result <= u64::MAX as u128, LitePsmError::Overflow);
    Ok(result as u64)
}

/// Convert dollar value to OkuMoney amount using `oku_m_price`.
///
/// Formula: `oku_m_amount = (dollar_value * PRECISION) / oku_m_price`
pub fn dollars_to_oku_m(dollar_value: u64, oku_m_price: u64) -> Result<u64> {
    require!(oku_m_price > 0, LitePsmError::ZeroAmount);

    let result = (dollar_value as u128)
        .checked_mul(PRECISION as u128)
        .ok_or(LitePsmError::Overflow)?
        .checked_div(oku_m_price as u128)
        .ok_or(LitePsmError::Overflow)?;

    require!(result <= u64::MAX as u128, LitePsmError::Overflow);
    Ok(result as u64)
}

/// Calculate fee from amount using basis points.
///
/// Formula: `fee = (amount * fee_bps) / BASIS_POINTS`
pub fn calculate_fee(amount: u64, fee_bps: u16) -> Result<u64> {
    let fee = (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(LitePsmError::Overflow)?
        .checked_div(BASIS_POINTS as u128)
        .ok_or(LitePsmError::Overflow)?;

    Ok(fee as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_oku_m_to_dollars() {
        // At $1.00 price, 1 OkuMoney = $1.00
        assert_eq!(oku_m_to_dollars(1_000_000, PRECISION).unwrap(), 1_000_000);

        // At $1.10 price, 1 OkuMoney = $1.10
        assert_eq!(oku_m_to_dollars(1_000_000, 1_100_000_000).unwrap(), 1_100_000);

        // At $1.05 price, 100 OkuMoney = $105.00
        assert_eq!(
            oku_m_to_dollars(100_000_000, 1_050_000_000).unwrap(),
            105_000_000
        );
    }

    #[test]
    fn test_dollars_to_oku_m() {
        // At $1.00 price, $1.00 = 1 OkuMoney
        assert_eq!(dollars_to_oku_m(1_000_000, PRECISION).unwrap(), 1_000_000);

        // At $1.10 price, $1.10 = 1 OkuMoney
        assert_eq!(dollars_to_oku_m(1_100_000, 1_100_000_000).unwrap(), 1_000_000);
    }

    #[test]
    fn test_calculate_fee() {
        // 10 bps (0.1%) of 1000 = 1
        assert_eq!(calculate_fee(1000, 10).unwrap(), 1);

        // 100 bps (1%) of 10000 = 100
        assert_eq!(calculate_fee(10000, 100).unwrap(), 100);

        // 50 bps (0.5%) of 1_000_000 = 5000
        assert_eq!(calculate_fee(1_000_000, 50).unwrap(), 5000);
    }
}
