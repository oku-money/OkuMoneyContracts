//! OkuDollar vault math helpers.
//!
//! Numeric constants live in `crate::constants` (which re-exports from
//! the workspace `oku-shared` crate). The single-multiplier conversions
//! delegate to `oku_shared::math`; vault-specific multi-multiplier
//! helpers (collateral ratio, surplus, share conversions) live below
//! because they have no lite-psm counterpart.
//!
//! Taken from https://github.com/anomalyco/okuMoney/blob/main/contracts/EVM/src/token/OkuDollar.sol

use crate::constants::PRECISION;
use crate::errors::OkuDollarError;
use crate::state::OkuDollarConfig;
use anchor_lang::prelude::*;
use oku_shared::math as shared;

// ---------------------------------------------------------------------------
// Sandwich guard
// ---------------------------------------------------------------------------

/// Vault-side yield-distribution sandwich guard.
///
/// `update_usd_multiplier` stamps `last_yield_distribution_slot = Clock::slot`,
/// and `wrap` / `unwrap` reject when `Clock::slot == last_yield_distribution_slot`.
/// This prevents the orchestrator (or anyone observing the orchestrator's
/// landed update) from sandwiching the multiplier bump within a single slot
/// to harvest the yield.
///
/// Mirrors `lite_psm::helpers::yield_lock::check_yield_lock` for the PSM, and
/// EVM `YieldSandwichGuard` for the vault. Cross-program: the existing PSM
/// yield lock check is still required because PSM `set_oku_m_price` /
/// `distribute_yield` also count as yield-affecting events for the vault math
/// (which reads `oku_m_price`).
pub fn check_vault_yield_lock(config: &OkuDollarConfig) -> Result<()> {
    let current_slot = Clock::get()?.slot;
    require!(
        current_slot != config.last_yield_distribution_slot,
        OkuDollarError::YieldDistributionInProgress
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Single-multiplier conversions (delegate to oku-shared)
// ---------------------------------------------------------------------------

/// Convert OkuMoney amount → USD value using `oku_m_price`.
///
/// Formula: `usd_value = (oku_m_amount * oku_m_price) / PRECISION`.
/// Returns the OkuDollar-flavoured error on overflow.
pub fn oku_money_to_usd(oku_m_amount: u64, oku_m_price: u64) -> Result<u64> {
    shared::oku_m_to_dollars(oku_m_amount, oku_m_price)
        .ok_or_else(|| error!(OkuDollarError::Overflow))
}

/// Convert USD value → OkuMoney amount using `oku_m_price`.
///
/// Formula: `oku_m_amount = (usd_value * PRECISION) / oku_m_price`.
/// Rejects `oku_m_price == 0` with `InvalidPrice` (vault-side semantic);
/// pure overflow propagates as `Overflow`.
pub fn usd_to_oku_money(usd_value: u64, oku_m_price: u64) -> Result<u64> {
    require!(oku_m_price > 0, OkuDollarError::InvalidPrice);
    shared::dollars_to_oku_m(usd_value, oku_m_price)
        .ok_or_else(|| error!(OkuDollarError::Overflow))
}

// ---------------------------------------------------------------------------
// Vault share conversions (two-multiplier — no shared primitive)
// ---------------------------------------------------------------------------

/// Convert usdOku shares → OkuMoney amount (price-aware).
///
/// Formula: `oku_m_amount = (usd_oku_shares * usd_multiplier) / oku_m_price`.
/// Equivalent to EVM: `okuMReturned = (usdAmount * PRECISION) / okuMPrice`.
pub fn shares_to_oku_money(
    usd_oku_shares: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Result<u64> {
    require!(oku_m_price > 0, OkuDollarError::InvalidPrice);
    shared::mul_div_floor(usd_oku_shares, usd_multiplier, oku_m_price)
        .ok_or_else(|| error!(OkuDollarError::Overflow))
}

/// Convert OkuMoney amount → usdOku shares (price-aware).
///
/// Formula: `usd_oku_shares = (oku_m_amount * oku_m_price) / usd_multiplier`.
/// Matches EVM: `sharesToMint = (actualReceived * okuMPrice) / usdMultiplier`.
pub fn oku_money_to_shares(
    oku_m_amount: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Result<u64> {
    require!(usd_multiplier > 0, OkuDollarError::InvalidMultiplier);
    require!(oku_m_price > 0, OkuDollarError::InvalidPrice);
    shared::mul_div_floor(oku_m_amount, oku_m_price, usd_multiplier)
        .ok_or_else(|| error!(OkuDollarError::Overflow))
}

// ---------------------------------------------------------------------------
// Collateralization
// ---------------------------------------------------------------------------

/// Calculate the collateralization ratio of the vault (price-aware).
///
/// Matches EVM:
///   `reservesDollarValue = (totalOkuMReserves * okuMPrice) / PRECISION`
///   `ratio = (reservesDollarValue * PRECISION) / totalUsdObligations`
///
/// Simplified: `ratio = (reserve_balance * oku_m_price * PRECISION)
///                     / (total_usd_oku_supply * usd_multiplier)`.
///
/// Returns `u64::MAX` when `total_usd_oku_supply == 0` (no obligations →
/// infinite collateralization) or when the divisor in any
/// sub-calculation collapses to zero. Overflow returns the error.
pub fn calculate_collateral_ratio(
    reserve_balance: u64,
    total_usd_oku_supply: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Result<u64> {
    if total_usd_oku_supply == 0 {
        return Ok(u64::MAX);
    }

    let denominator = (total_usd_oku_supply as u128)
        .checked_mul(usd_multiplier as u128)
        .ok_or(OkuDollarError::Overflow)?;
    if denominator == 0 {
        return Ok(u64::MAX);
    }

    let numerator = (reserve_balance as u128)
        .checked_mul(oku_m_price as u128)
        .ok_or(OkuDollarError::Overflow)?
        .checked_mul(PRECISION as u128)
        .ok_or(OkuDollarError::Overflow)?;

    let result = numerator / denominator;
    Ok(u64::try_from(result).unwrap_or(u64::MAX))
}

/// Calculate extractable surplus in OkuMoney tokens.
///
///   `surplus = reserve_balance - required_reserves`
///   `required_reserves = (total_usd_oku_supply * usd_multiplier) / oku_m_price`
///
/// Returns 0 if undercollateralized (no surplus). Mirrors EVM
/// `OkuDollar.surplus()` and `getExtractableSurplus()`.
pub fn calculate_surplus(
    reserve_balance: u64,
    total_usd_oku_supply: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Result<u64> {
    if total_usd_oku_supply == 0 {
        // All reserves are surplus when there's no supply.
        return Ok(reserve_balance);
    }
    require!(oku_m_price > 0, OkuDollarError::InvalidPrice);

    let required = shared::mul_div_floor(total_usd_oku_supply, usd_multiplier, oku_m_price)
        .ok_or_else(|| error!(OkuDollarError::Overflow))?;
    Ok(reserve_balance.saturating_sub(required))
}

/// Check if the vault is sufficiently collateralized.
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Vault-specific helper tests. Single-multiplier conversions
    //! delegate to `oku_shared::math` which has its own coverage; we
    //! retain the parametric examples below as anchors for the
    //! mapping into OkuDollar-flavoured errors.
    use super::*;

    #[test]
    fn test_oku_money_to_usd() {
        assert_eq!(oku_money_to_usd(1_000_000, PRECISION).unwrap(), 1_000_000);
        assert_eq!(
            oku_money_to_usd(1_000_000, 1_100_000_000).unwrap(),
            1_100_000
        );
        assert_eq!(
            oku_money_to_usd(100_000_000, 1_050_000_000).unwrap(),
            105_000_000
        );
    }

    #[test]
    fn test_usd_to_oku_money() {
        assert_eq!(usd_to_oku_money(1_000_000, PRECISION).unwrap(), 1_000_000);
        assert_eq!(
            usd_to_oku_money(1_100_000, 1_100_000_000).unwrap(),
            1_000_000
        );
        assert_eq!(
            usd_to_oku_money(105_000_000, 1_050_000_000).unwrap(),
            100_000_000
        );
    }

    #[test]
    fn test_shares_to_oku_money() {
        assert_eq!(
            shares_to_oku_money(1_000_000, PRECISION, PRECISION).unwrap(),
            1_000_000
        );
        assert_eq!(
            shares_to_oku_money(1_000_000, 1_100_000_000, PRECISION).unwrap(),
            1_100_000
        );
        // At 1:1 multiplier, price $1.05: 1 usdOku → ~0.952381 OkuMoney.
        assert_eq!(
            shares_to_oku_money(1_000_000, PRECISION, 1_050_000_000).unwrap(),
            952_380
        );
        // At 1:1 multiplier, price $1.05: 105 usdOku → 100 OkuMoney.
        assert_eq!(
            shares_to_oku_money(105_000_000, PRECISION, 1_050_000_000).unwrap(),
            100_000_000
        );
    }

    #[test]
    fn test_oku_money_to_shares() {
        assert_eq!(
            oku_money_to_shares(1_000_000, PRECISION, PRECISION).unwrap(),
            1_000_000
        );
        assert_eq!(
            oku_money_to_shares(1_100_000, 1_100_000_000, PRECISION).unwrap(),
            1_000_000
        );
        assert_eq!(
            oku_money_to_shares(100_000_000, PRECISION, 1_050_000_000).unwrap(),
            105_000_000
        );
    }

    #[test]
    fn test_calculate_collateral_ratio() {
        // 100% at 1:1 multiplier, price $1.00.
        assert_eq!(
            calculate_collateral_ratio(100_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            PRECISION
        );
        // 110% (reserve = 110, supply = 100).
        assert_eq!(
            calculate_collateral_ratio(110_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            1_100_000_000
        );
        // 95% (reserve = 95).
        assert_eq!(
            calculate_collateral_ratio(95_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            950_000_000
        );
        // Price-aware: reserve = 100 OkuM at $1.05 → ratio = 105%.
        assert_eq!(
            calculate_collateral_ratio(100_000_000, 100_000_000, PRECISION, 1_050_000_000)
                .unwrap(),
            1_050_000_000
        );
    }

    #[test]
    fn test_calculate_surplus() {
        // 100% → surplus = 0.
        assert_eq!(
            calculate_surplus(100_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            0
        );
        // 110% → 10 OkuM surplus.
        assert_eq!(
            calculate_surplus(110_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            10_000_000
        );
        // Price > $1.00 → reserves worth more → surplus increases.
        assert_eq!(
            calculate_surplus(100_000_000, 100_000_000, PRECISION, 1_050_000_000).unwrap(),
            4_761_905
        );
        // Undercollateralized → surplus = 0.
        assert_eq!(
            calculate_surplus(90_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            0
        );
        // No supply → all reserves are surplus.
        assert_eq!(
            calculate_surplus(50_000_000, 0, PRECISION, PRECISION).unwrap(),
            50_000_000
        );
    }
}
