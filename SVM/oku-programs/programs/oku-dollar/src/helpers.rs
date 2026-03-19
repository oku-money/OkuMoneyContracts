use crate::errors::OkuDollarError;
use anchor_lang::prelude::*;

/// Precision for multipliers (1e9 = $1.00)
/// Matches EVM's PRECISION constant
pub const PRECISION: u64 = 1_000_000_000;

/// Dead shares permanently locked in an ATA owned by the System Program.
/// Nobody holds the System Program's private key, so the tokens are unrecoverable.
/// This prevents the first-depositor inflation attack on vault shares.
pub const MINIMUM_LIQUIDITY: u64 = 1_000_000; // 10^6 = 1 usdOku (6 decimals)

/// Minimum collateral ratio floor (90% = 900_000_000)
/// Protocol cannot set min_collateral_ratio below this value
pub const MIN_COLLATERAL_RATIO_FLOOR: u64 = 900_000_000;

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

/// Convert usdOku shares to OkuMoney amount
///
/// Formula: oku_m_amount = (usd_oku_shares * usd_multiplier) / PRECISION
///
/// This represents how much OkuMoney backing corresponds to the given usdOku shares.
///
/// # Arguments
/// * `usd_oku_shares` - Amount of usdOku shares (6 decimals)
/// * `usd_multiplier` - USD multiplier from OkuDollarConfig (1e9 = 1:1)
///
/// # Returns
/// * Amount of OkuMoney tokens (6 decimals)
pub fn shares_to_oku_money(usd_oku_shares: u64, usd_multiplier: u64) -> Result<u64> {
    // Use u128 for intermediate calculation to prevent overflow
    let numerator = (usd_oku_shares as u128)
        .checked_mul(usd_multiplier as u128)
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

/// Convert OkuMoney amount to usdOku shares
///
/// Formula: usd_oku_shares = (oku_m_amount * PRECISION) / usd_multiplier
///
/// This calculates how many usdOku shares correspond to a given OkuMoney deposit.
///
/// # Arguments
/// * `oku_m_amount` - Amount of OkuMoney tokens (6 decimals)
/// * `usd_multiplier` - USD multiplier from OkuDollarConfig (1e9 = 1:1)
///
/// # Returns
/// * Amount of usdOku shares (6 decimals)
pub fn oku_money_to_shares(oku_m_amount: u64, usd_multiplier: u64) -> Result<u64> {
    require!(usd_multiplier > 0, OkuDollarError::InvalidMultiplier);

    // Use u128 for intermediate calculation to prevent overflow
    let numerator = (oku_m_amount as u128)
        .checked_mul(PRECISION as u128)
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

/// Calculate the collateralization ratio of the vault
///
/// Formula: ratio = (reserve_balance * PRECISION) / total_usd_oku_supply
///
/// Where reserve_balance is in OkuMoney terms and total_usd_oku_supply
/// is converted to OkuMoney-equivalent using usd_multiplier.
///
/// # Arguments
/// * `reserve_balance` - OkuMoney balance in reserve vault (6 decimals)
/// * `total_usd_oku_supply` - Total usdOku supply (6 decimals)
/// * `usd_multiplier` - USD multiplier from OkuDollarConfig (1e9 = 1:1)
///
/// # Returns
/// * Collateralization ratio scaled by PRECISION (1e9 = 100%)
pub fn calculate_collateral_ratio(
    reserve_balance: u64,
    total_usd_oku_supply: u64,
    usd_multiplier: u64,
) -> Result<u64> {
    // If no usdOku supply, ratio is infinite (represented as max)
    if total_usd_oku_supply == 0 {
        return Ok(u64::MAX);
    }

    // Calculate OkuMoney-equivalent of total usdOku supply
    let required_oku_money = shares_to_oku_money(total_usd_oku_supply, usd_multiplier)?;

    if required_oku_money == 0 {
        return Ok(u64::MAX);
    }

    // Calculate ratio: (reserve_balance * PRECISION) / required_oku_money
    let numerator = (reserve_balance as u128)
        .checked_mul(PRECISION as u128)
        .ok_or(OkuDollarError::Overflow)?;

    let result = numerator
        .checked_div(required_oku_money as u128)
        .ok_or(OkuDollarError::Overflow)?;

    // Cap at u64::MAX
    if result > u64::MAX as u128 {
        return Ok(u64::MAX);
    }

    Ok(result as u64)
}

/// Check if the vault is sufficiently collateralized
///
/// # Arguments
/// * `reserve_balance` - OkuMoney balance in reserve vault (6 decimals)
/// * `total_usd_oku_supply` - Total usdOku supply (6 decimals)
/// * `usd_multiplier` - USD multiplier from OkuDollarConfig (1e9 = 1:1)
/// * `min_collateral_ratio` - Minimum required ratio (scaled by PRECISION)
///
/// # Returns
/// * true if sufficiently collateralized, false otherwise
pub fn is_sufficiently_collateralized(
    reserve_balance: u64,
    total_usd_oku_supply: u64,
    usd_multiplier: u64,
    min_collateral_ratio: u64,
) -> Result<bool> {
    let ratio = calculate_collateral_ratio(reserve_balance, total_usd_oku_supply, usd_multiplier)?;
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
        // At 1:1 multiplier (PRECISION), 1 usdOku = 1 OkuMoney
        assert_eq!(
            shares_to_oku_money(1_000_000, PRECISION).unwrap(),
            1_000_000
        );

        // At 1.1:1 multiplier, 1 usdOku = 1.1 OkuMoney
        assert_eq!(
            shares_to_oku_money(1_000_000, 1_100_000_000).unwrap(),
            1_100_000
        );
    }

    #[test]
    fn test_oku_money_to_shares() {
        // At 1:1 multiplier (PRECISION), 1 OkuMoney = 1 usdOku
        assert_eq!(
            oku_money_to_shares(1_000_000, PRECISION).unwrap(),
            1_000_000
        );

        // At 1.1:1 multiplier, 1.1 OkuMoney = 1 usdOku
        assert_eq!(
            oku_money_to_shares(1_100_000, 1_100_000_000).unwrap(),
            1_000_000
        );
    }

    #[test]
    fn test_calculate_collateral_ratio() {
        // 100% collateralized at 1:1 multiplier
        assert_eq!(
            calculate_collateral_ratio(100_000_000, 100_000_000, PRECISION).unwrap(),
            PRECISION
        );

        // 110% collateralized (reserve = 110, supply = 100, multiplier = 1:1)
        assert_eq!(
            calculate_collateral_ratio(110_000_000, 100_000_000, PRECISION).unwrap(),
            1_100_000_000
        );

        // 95% collateralized (reserve = 95, supply = 100, multiplier = 1:1)
        assert_eq!(
            calculate_collateral_ratio(95_000_000, 100_000_000, PRECISION).unwrap(),
            950_000_000
        );
    }
}
