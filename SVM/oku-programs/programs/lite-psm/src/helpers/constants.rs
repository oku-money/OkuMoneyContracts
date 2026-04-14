//! # OkuMoney SVM Constants
//!
//! Shared constants for all OkuMoney SVM programs.
//! Equivalent to EVM's `Constants.sol` and `MathLib.sol`.
//!
//! ## Terminology Legend
//!
//! ### Multipliers (Dollar Value Per Token)
//!
//! | SVM Name | EVM Equivalent | Description |
//! |----------|----------------|-------------|
//! | `oku_m_price` | `okuMMultiplier()` | Dollar value of 1 OkuMoney token (1e9 = $1.00, grows with yield) |
//! | `usd_multiplier` | `usdMultiplier()` | Dollar value of 1 OkuDollar share (1e9 = $1.00, grows with yield) |
//!
//! ### Token Amounts
//!
//! | Name | Decimals | Description |
//! |------|----------|-------------|
//! | `oku_m_amount` | 6 | Raw OkuMoney token count (non-rebasing, Token-2022) |
//! | `usd_amount` | 6 | OkuDollar amount in dollar terms (rebasing via `usd_multiplier`) |
//! | `usdc_amount` | 6 | USDC amount |
//!
//! ### Internal Accounting
//!
//! | Name | Description |
//! |------|-------------|
//! | `shares` | Internal accounting units for rebasing tokens (OkuDollar uses `usd_oku_shares`) |
//! | `dollar_value` | Dollar-denominated value (6 decimals on SVM, 18 on EVM) |
//!
//! ### Conversion Constants
//!
//! | Constant | Value | Description |
//! |----------|-------|-------------|
//! | `PRECISION` | 1e9 (SVM) / 1e18 (EVM) | Base unit for multiplier math (= $1.00) |
//! | `BASIS_POINTS` | 10,000 | 100% in basis points |
//!
//! ## Key Formulas
//!
//! ```text
//! USDC -> OkuMoney:  oku_m_amount = (usdc_amount * PRECISION) / oku_m_price
//! OkuMoney -> USDC:  usdc_amount = (oku_m_amount * oku_m_price) / PRECISION
//! OkuMoney -> OkuDollar shares: shares = (oku_m_amount * oku_m_price) / usd_multiplier
//! OkuDollar -> OkuMoney: oku_m_amount = (usd_amount * usd_multiplier) / oku_m_price
//! Dollar value: dollar_value = (oku_m_amount * oku_m_price) / PRECISION
//! ```
//!
//! ## EVM ↔ SVM Decimal Mapping
//!
//! | Type | EVM (decimals) | SVM (decimals) |
//! |------|----------------|----------------|
//! | USDC | 6 | 6 |
//! | OkuMoney | 18 | 6 |
//! | OkuDollar | 18 | 6 |
//! | Multipliers | 18 (1e18 = $1) | 9 (1e9 = $1) |

use crate::errors::OkuError;
use anchor_lang::prelude::*;

/// Standard precision for price and multiplier calculations.
/// 1e9 = $1.00 on SVM (equivalent to 1e18 on EVM).
pub const PRECISION: u64 = 1_000_000_000;

/// Basis points denominator (10000 = 100%).
/// Used for fee calculations (e.g., 10 bps = 0.1%).
pub const BASIS_POINTS: u64 = 10_000;

/// Maximum yield rate safety cap.
/// ~3700% APY, well beyond any T-Bill rate.
/// Matches EVM: PRECISION + 1e11 scaled to SVM precision.
pub const MAX_RATE: u64 = PRECISION + 100_000; // 1e9 + 1e5 (scaled from EVM's 1e18 + 1e11)

/// Default bridge deadline in seconds (1 hour).
pub const DEFAULT_BRIDGE_DEADLINE_SECS: i64 = 3600;

/// Maximum supported destination chains.
pub const MAX_SUPPORTED_CHAINS: usize = 32;

// ============================================================================
// Math Utilities
// ============================================================================

/// Convert OkuMoney amount to dollar value using oku_m_price.
///
/// Formula: `dollar_value = (oku_m_amount * oku_m_price) / PRECISION`
///
/// # Arguments
/// * `oku_m_amount` - Amount of OkuMoney tokens (6 decimals)
/// * `oku_m_price` - OkuMoney price multiplier (1e9 = $1.00)
///
/// # Returns
/// * Dollar value (6 decimals)
pub fn oku_m_to_dollars(oku_m_amount: u64, oku_m_price: u64) -> Result<u64> {
    let result = (oku_m_amount as u128)
        .checked_mul(oku_m_price as u128)
        .ok_or(OkuError::Overflow)?
        .checked_div(PRECISION as u128)
        .ok_or(OkuError::Overflow)?;

    require!(result <= u64::MAX as u128, OkuError::Overflow);
    Ok(result as u64)
}

/// Convert dollar value to OkuMoney amount using oku_m_price.
///
/// Formula: `oku_m_amount = (dollar_value * PRECISION) / oku_m_price`
///
/// # Arguments
/// * `dollar_value` - Dollar value (6 decimals)
/// * `oku_m_price` - OkuMoney price multiplier (1e9 = $1.00)
///
/// # Returns
/// * Amount of OkuMoney tokens (6 decimals)
pub fn dollars_to_oku_m(dollar_value: u64, oku_m_price: u64) -> Result<u64> {
    require!(oku_m_price > 0, OkuError::ZeroAmount);

    let result = (dollar_value as u128)
        .checked_mul(PRECISION as u128)
        .ok_or(OkuError::Overflow)?
        .checked_div(oku_m_price as u128)
        .ok_or(OkuError::Overflow)?;

    require!(result <= u64::MAX as u128, OkuError::Overflow);
    Ok(result as u64)
}

/// Calculate fee from amount using basis points.
///
/// Formula: `fee = (amount * fee_bps) / BASIS_POINTS`
///
/// # Arguments
/// * `amount` - Base amount
/// * `fee_bps` - Fee in basis points (e.g., 10 = 0.1%)
///
/// # Returns
/// * Fee amount
pub fn calculate_fee(amount: u64, fee_bps: u16) -> Result<u64> {
    let fee = (amount as u128)
        .checked_mul(fee_bps as u128)
        .ok_or(OkuError::Overflow)?
        .checked_div(BASIS_POINTS as u128)
        .ok_or(OkuError::Overflow)?;

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
        assert_eq!(
            oku_m_to_dollars(1_000_000, 1_100_000_000).unwrap(),
            1_100_000
        );

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
        assert_eq!(
            dollars_to_oku_m(1_100_000, 1_100_000_000).unwrap(),
            1_000_000
        );
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
