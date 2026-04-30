//! OkuDollar vault math helpers.
//!
//! Numeric constants live in `crate::constants`; this module defines the
//! pure-math conversion / collateralization helpers. The price-aware
//! wrap/unwrap math mirrors the EVM-side `OkuDollar.sol` ratios.
//! Taken from https://github.com/anomalyco/okuMoney/blob/main/contracts/EVM/src/token/OkuDollar.sol

use crate::constants::PRECISION;
use crate::errors::OkuDollarError;
use anchor_lang::prelude::*;

// Re-exports preserved for backwards compatibility with existing call sites.
pub use crate::constants::{MIN_COLLATERAL_RATIO_FLOOR, MINIMUM_LIQUIDITY};

/// Convert OkuMoney amount to USD value using oku_m_price
///
/// Formula: usd_value = (oku_m_amount * oku_m_price) / PRECISION
///
/// # Arguments
/// * `oku_m_amount` - Amount of OkuMoney tokens (6 decimals)
/// * `oku_m_price` - OkuMoney price multiplier from PsmConfig (1e9 = $1.00)
///
/// # Returns
/// * USD value scaled to 6 decimals
pub fn oku_money_to_usd(oku_m_amount: u64, oku_m_price: u64) -> Result<u64> {
    // Use u128 for intermediate calculation to prevent overflow
    let numerator = (oku_m_amount as u128)
        .checked_mul(oku_m_price as u128)
        .ok_or(OkuDollarError::Overflow)?;

    let result = numerator
        .checked_div(PRECISION as u128)
        .ok_or(OkuDollarError::Overflow)?;

    // Ensure result fits in u64
    if result > u64::MAX as u128 {
        return Err(OkuDollarError::Overflow.into());
    }

    Ok(result as u64)
}

/// Convert USD value to OkuMoney amount using oku_m_price
///
/// Formula: oku_m_amount = (usd_value * PRECISION) / oku_m_price
///
/// # Arguments
/// * `usd_value` - USD value scaled to 6 decimals
/// * `oku_m_price` - OkuMoney price multiplier from PsmConfig (1e9 = $1.00)
///
/// # Returns
/// * Amount of OkuMoney tokens (6 decimals)
pub fn usd_to_oku_money(usd_value: u64, oku_m_price: u64) -> Result<u64> {
    require!(oku_m_price > 0, OkuDollarError::InvalidPrice);

    // Use u128 for intermediate calculation to prevent overflow
    let numerator = (usd_value as u128)
        .checked_mul(PRECISION as u128)
        .ok_or(OkuDollarError::Overflow)?;

    let result = numerator
        .checked_div(oku_m_price as u128)
        .ok_or(OkuDollarError::Overflow)?;

    // Ensure result fits in u64
    if result > u64::MAX as u128 {
        return Err(OkuDollarError::Overflow.into());
    }

    Ok(result as u64)
}

/// Convert usdOku shares to OkuMoney amount (price-aware)
///
/// Formula: oku_m_amount = (usd_oku_shares * usd_multiplier) / oku_m_price
///
/// Equivalent to EVM: okuMReturned = (usdAmount * PRECISION) / okuMPrice
/// (EVM takes dollar amount, SVM takes shares — mathematically equivalent end-to-end)
///
/// # Arguments
/// * `usd_oku_shares` - Amount of usdOku shares (6 decimals)
/// * `usd_multiplier` - USD multiplier from OkuDollarConfig (1e9 = 1:1)
/// * `oku_m_price` - OkuMoney price from PsmConfig (1e9 = $1.00)
///
/// # Returns
/// * Amount of OkuMoney tokens (6 decimals)
pub fn shares_to_oku_money(
    usd_oku_shares: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Result<u64> {
    require!(oku_m_price > 0, OkuDollarError::InvalidPrice);

    // Use u128 for intermediate calculation to prevent overflow
    let numerator = (usd_oku_shares as u128)
        .checked_mul(usd_multiplier as u128)
        .ok_or(OkuDollarError::Overflow)?;

    let result = numerator
        .checked_div(oku_m_price as u128)
        .ok_or(OkuDollarError::Overflow)?;

    // Ensure result fits in u64
    if result > u64::MAX as u128 {
        return Err(OkuDollarError::Overflow.into());
    }

    Ok(result as u64)
}

/// Convert OkuMoney amount to usdOku shares (price-aware)
///
/// Formula: usd_oku_shares = (oku_m_amount * oku_m_price) / usd_multiplier
///
/// Matches EVM: sharesToMint = (actualReceived * okuMPrice) / usdMultiplier
///
/// # Arguments
/// * `oku_m_amount` - Amount of OkuMoney tokens (6 decimals)
/// * `usd_multiplier` - USD multiplier from OkuDollarConfig (1e9 = 1:1)
/// * `oku_m_price` - OkuMoney price from PsmConfig (1e9 = $1.00)
///
/// # Returns
/// * Amount of usdOku shares (6 decimals)
pub fn oku_money_to_shares(
    oku_m_amount: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Result<u64> {
    require!(usd_multiplier > 0, OkuDollarError::InvalidMultiplier);
    require!(oku_m_price > 0, OkuDollarError::InvalidPrice);

    // Use u128 for intermediate calculation to prevent overflow
    let numerator = (oku_m_amount as u128)
        .checked_mul(oku_m_price as u128)
        .ok_or(OkuDollarError::Overflow)?;

    let result = numerator
        .checked_div(usd_multiplier as u128)
        .ok_or(OkuDollarError::Overflow)?;

    // Ensure result fits in u64
    if result > u64::MAX as u128 {
        return Err(OkuDollarError::Overflow.into());
    }

    Ok(result as u64)
}

/// Calculate the collateralization ratio of the vault (price-aware)
///
/// Matches EVM:
///   reservesDollarValue = (totalOkuMReserves * okuMPrice) / PRECISION
///   ratio = (reservesDollarValue * PRECISION) / totalUsdObligations
///
/// Simplified: ratio = (reserve_balance * oku_m_price * PRECISION) / (total_usd_oku_supply * usd_multiplier)
///
/// # Arguments
/// * `reserve_balance` - OkuMoney balance in reserve vault (6 decimals)
/// * `total_usd_oku_supply` - Total usdOku supply (6 decimals)
/// * `usd_multiplier` - USD multiplier from OkuDollarConfig (1e9 = 1:1)
/// * `oku_m_price` - OkuMoney price from PsmConfig (1e9 = $1.00)
///
/// # Returns
/// * Collateralization ratio scaled by PRECISION (1e9 = 100%)
pub fn calculate_collateral_ratio(
    reserve_balance: u64,
    total_usd_oku_supply: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Result<u64> {
    // If no usdOku supply, ratio is infinite (represented as max)
    if total_usd_oku_supply == 0 {
        return Ok(u64::MAX);
    }

    // total_usd_obligations = (total_usd_oku_supply * usd_multiplier) / PRECISION
    let denominator = (total_usd_oku_supply as u128)
        .checked_mul(usd_multiplier as u128)
        .ok_or(OkuDollarError::Overflow)?;

    if denominator == 0 {
        return Ok(u64::MAX);
    }

    // ratio = (reserve_balance * oku_m_price * PRECISION) / (total_usd_oku_supply * usd_multiplier)
    let numerator = (reserve_balance as u128)
        .checked_mul(oku_m_price as u128)
        .ok_or(OkuDollarError::Overflow)?
        .checked_mul(PRECISION as u128)
        .ok_or(OkuDollarError::Overflow)?;

    let result = numerator
        .checked_div(denominator)
        .ok_or(OkuDollarError::Overflow)?;

    // Cap at u64::MAX
    if result > u64::MAX as u128 {
        return Ok(u64::MAX);
    }

    Ok(result as u64)
}

/// Calculate extractable surplus in OkuMoney tokens
/// surplus = reserve_balance - required_reserves
/// where required_reserves = (total_usd_oku_supply * usd_multiplier) / oku_m_price
///
/// Returns 0 if undercollateralized (no surplus)
pub fn calculate_surplus(
    reserve_balance: u64,
    total_usd_oku_supply: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Result<u64> {
    if total_usd_oku_supply == 0 {
        return Ok(reserve_balance); // All reserves are surplus
    }
    require!(oku_m_price > 0, OkuDollarError::InvalidPrice);

    // required = (total_usd_oku_supply * usd_multiplier) / oku_m_price
    let required = (total_usd_oku_supply as u128)
        .checked_mul(usd_multiplier as u128)
        .ok_or(OkuDollarError::Overflow)?
        .checked_div(oku_m_price as u128)
        .ok_or(OkuDollarError::Overflow)?;

    if required > reserve_balance as u128 {
        return Ok(0);
    }
    Ok(reserve_balance.saturating_sub(required as u64))
}

/// Check if the vault is sufficiently collateralized
///
/// # Arguments
/// * `reserve_balance` - OkuMoney balance in reserve vault (6 decimals)
/// * `total_usd_oku_supply` - Total usdOku supply (6 decimals)
/// * `usd_multiplier` - USD multiplier from OkuDollarConfig (1e9 = 1:1)
/// * `oku_m_price` - OkuMoney price from PsmConfig (1e9 = $1.00)
/// * `min_collateral_ratio` - Minimum required ratio (scaled by PRECISION)
///
/// # Returns
/// * true if sufficiently collateralized, false otherwise
pub fn is_sufficiently_collateralized(
    reserve_balance: u64,
    total_usd_oku_supply: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
    min_collateral_ratio: u64,
) -> Result<bool> {
    let ratio = calculate_collateral_ratio(
        reserve_balance,
        total_usd_oku_supply,
        usd_multiplier,
        oku_m_price,
    )?;
    Ok(ratio >= min_collateral_ratio)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_oku_money_to_usd() {
        // At $1.00 price (PRECISION), 1 OkuMoney = $1.00
        assert_eq!(oku_money_to_usd(1_000_000, PRECISION).unwrap(), 1_000_000);

        // At $1.10 price (1.1e9), 1 OkuMoney = $1.10
        assert_eq!(
            oku_money_to_usd(1_000_000, 1_100_000_000).unwrap(),
            1_100_000
        );

        // At $1.05 price (1.05e9), 100 OkuMoney = $105.00
        assert_eq!(
            oku_money_to_usd(100_000_000, 1_050_000_000).unwrap(),
            105_000_000
        );
    }

    #[test]
    fn test_usd_to_oku_money() {
        // At $1.00 price (PRECISION), $1.00 = 1 OkuMoney
        assert_eq!(usd_to_oku_money(1_000_000, PRECISION).unwrap(), 1_000_000);

        // At $1.10 price (1.1e9), $1.10 = 1 OkuMoney
        assert_eq!(
            usd_to_oku_money(1_100_000, 1_100_000_000).unwrap(),
            1_000_000
        );

        // At $1.05 price (1.05e9), $105.00 = 100 OkuMoney
        assert_eq!(
            usd_to_oku_money(105_000_000, 1_050_000_000).unwrap(),
            100_000_000
        );
    }

    #[test]
    fn test_shares_to_oku_money() {
        // At 1:1 multiplier, price $1.00: 1 usdOku = 1 OkuMoney
        assert_eq!(
            shares_to_oku_money(1_000_000, PRECISION, PRECISION).unwrap(),
            1_000_000
        );

        // At 1.1:1 multiplier, price $1.00: 1 usdOku = 1.1 OkuMoney
        assert_eq!(
            shares_to_oku_money(1_000_000, 1_100_000_000, PRECISION).unwrap(),
            1_100_000
        );

        // At 1:1 multiplier, price $1.05: 1 usdOku = ~0.952381 OkuMoney
        // (1_000_000 * 1_000_000_000) / 1_050_000_000 = 952_380
        assert_eq!(
            shares_to_oku_money(1_000_000, PRECISION, 1_050_000_000).unwrap(),
            952_380
        );

        // At 1:1 multiplier, price $1.05: 105 usdOku = 100 OkuMoney
        assert_eq!(
            shares_to_oku_money(105_000_000, PRECISION, 1_050_000_000).unwrap(),
            100_000_000
        );
    }

    #[test]
    fn test_oku_money_to_shares() {
        // At 1:1 multiplier, price $1.00: 1 OkuMoney = 1 usdOku
        assert_eq!(
            oku_money_to_shares(1_000_000, PRECISION, PRECISION).unwrap(),
            1_000_000
        );

        // At 1.1:1 multiplier, price $1.00: 1.1 OkuMoney = 1 usdOku
        assert_eq!(
            oku_money_to_shares(1_100_000, 1_100_000_000, PRECISION).unwrap(),
            1_000_000
        );

        // At 1:1 multiplier, price $1.05: 100 OkuMoney = 105 usdOku
        // (100_000_000 * 1_050_000_000) / 1_000_000_000 = 105_000_000
        assert_eq!(
            oku_money_to_shares(100_000_000, PRECISION, 1_050_000_000).unwrap(),
            105_000_000
        );
    }

    #[test]
    fn test_calculate_collateral_ratio() {
        // 100% collateralized at 1:1 multiplier, price $1.00
        assert_eq!(
            calculate_collateral_ratio(100_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            PRECISION
        );

        // 110% collateralized (reserve = 110, supply = 100, multiplier = 1:1, price $1.00)
        assert_eq!(
            calculate_collateral_ratio(110_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            1_100_000_000
        );

        // 95% collateralized (reserve = 95, supply = 100, multiplier = 1:1, price $1.00)
        assert_eq!(
            calculate_collateral_ratio(95_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            950_000_000
        );

        // Price-aware: reserve = 100 OkuM at price $1.05, supply = 100 usdOku at multiplier 1:1
        // reservesDollarValue = (100 * 1.05) = $105
        // totalUsdObligations = (100 * 1.0) = $100
        // ratio = 105/100 = 1.05 = 1_050_000_000
        assert_eq!(
            calculate_collateral_ratio(100_000_000, 100_000_000, PRECISION, 1_050_000_000).unwrap(),
            1_050_000_000
        );
    }

    #[test]
    fn test_calculate_surplus() {
        // 100% collateralized → surplus = 0
        // required = (100 * 1e9) / 1e9 = 100
        assert_eq!(
            calculate_surplus(100_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            0
        );

        // 110% collateralized → surplus = 10% of reserves
        // required = (100 * 1e9) / 1e9 = 100, surplus = 110 - 100 = 10
        assert_eq!(
            calculate_surplus(110_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            10_000_000
        );

        // Price > 1.0 → surplus increases (reserves worth more, fewer needed)
        // required = (100 * 1e9) / 1.05e9 = 95_238_095
        // surplus = 100_000_000 - 95_238_095 = 4_761_905
        assert_eq!(
            calculate_surplus(100_000_000, 100_000_000, PRECISION, 1_050_000_000).unwrap(),
            4_761_905
        );

        // Undercollateralized → surplus = 0
        assert_eq!(
            calculate_surplus(90_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            0
        );

        // No supply → all reserves are surplus
        assert_eq!(
            calculate_surplus(50_000_000, 0, PRECISION, PRECISION).unwrap(),
            50_000_000
        );
    }
}
