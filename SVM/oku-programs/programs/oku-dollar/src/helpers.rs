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
///
/// # MVP note
/// Currently unused by any instruction handler — kept for parity with EVM
/// `OkuDollar.dollarsToOkuM()` and for off-chain/test consumers that call
/// it directly. Will be plumbed into a future `withdraw_surplus` instruction.
pub fn usd_to_oku_money(usd_value: u64, oku_m_price: u64) -> Result<u64> {
    require!(oku_m_price > 0, OkuDollarError::InvalidPrice);
    shared::dollars_to_oku_m(usd_value, oku_m_price).ok_or_else(|| error!(OkuDollarError::Overflow))
}

// ---------------------------------------------------------------------------
// Vault share conversions (two-multiplier — no shared primitive)
// ---------------------------------------------------------------------------

/// Convert usdOku shares → OkuMoney amount (price-aware).
///
/// Formula: `oku_m_amount = floor(usd_oku_shares * usd_multiplier / oku_m_price)`.
/// Equivalent to EVM: `okuMReturned = (usdAmount * PRECISION) / okuMPrice`.
///
/// ## Rounding (F-05)
///
/// Uses **floor** rounding (via `mul_div_floor`). This is protocol-favorable:
/// the user always receives ≤ their mathematically-exact entitlement.
/// A zero result is rejected by the caller (`require!(oku_m_out > 0)`).
///
/// **Round-trip precision bound:** A `wrap` followed by `unwrap` at unchanged
/// prices loses at most `ceil(usd_multiplier / oku_m_price) + 1` lamports due
/// to two sequential floor divisions. At the current `oku_m_price = PRECISION`
/// ($1.00), this is at most 2 lamports per round-trip. At `MAX_MULTIPLIER`
/// ($1,000,000 / token), the worst-case is ~1e6 lamports ($1.00) per round-trip
/// — but the protocol only operates in the $1.00–$2.00 price range, limiting
/// practical loss to single-digit lamports.
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
/// Formula: `usd_oku_shares = floor(oku_m_amount * oku_m_price / usd_multiplier)`.
/// Matches EVM: `sharesToMint = (actualReceived * okuMPrice) / usdMultiplier`.
///
/// ## Rounding (F-05)
///
/// Uses **floor** rounding (via `mul_div_floor`). This is protocol-favorable:
/// the user receives ≤ their mathematically-exact share entitlement, meaning
/// the vault is always at least as well-collateralized after the deposit as
/// the math implies. A zero result is rejected by the caller
/// (`require!(shares > 0)`).
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

    // `denominator > 0` is asserted above so the divide cannot trap;
    // `checked_div` keeps clippy's `arithmetic_side_effects` lint happy
    // and documents the safety boundary explicitly.
    let result = numerator
        .checked_div(denominator)
        .ok_or(OkuDollarError::Overflow)?;
    Ok(u64::try_from(result).unwrap_or(u64::MAX))
}

/// Calculate extractable surplus in OkuMoney tokens.
///
///   `surplus = reserve_balance - required_reserves`
///   `required_reserves = (total_usd_oku_supply * usd_multiplier) / oku_m_price`
///
/// Returns 0 if undercollateralized (no surplus). Mirrors EVM
/// `OkuDollar.surplus()` and `getExtractableSurplus()`.
///
/// # MVP note
/// Currently unused by any instruction handler — kept for parity with EVM
/// `OkuDollar.surplus()`. Will be plumbed into a future `withdraw_surplus`
/// instruction (not yet implemented on SVM).
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

    /// F-05: Verify wrap→unwrap round-trip precision bound.
    ///
    /// Properties:
    /// 1. `oku_m_out <= oku_m_in` (monotonicity — floor rounding never overpays).
    /// 2. Loss bounded by `ceil(usd_multiplier / oku_m_price) + 1`.
    #[test]
    fn test_share_round_trip_precision_bound() {
        // At $1.00 price, $1.00 multiplier — loss should be 0 for round amounts.
        let oku_m_in = 1_000_000u64; // 1 OkuMoney
        let oku_m_price = PRECISION;
        let usd_multiplier = PRECISION;
        let shares = oku_money_to_shares(oku_m_in, usd_multiplier, oku_m_price).unwrap();
        let oku_m_out = shares_to_oku_money(shares, usd_multiplier, oku_m_price).unwrap();
        assert!(oku_m_out <= oku_m_in, "round-trip must not overpay");
        let max_loss = (usd_multiplier / oku_m_price) + 2;
        assert!(
            oku_m_in.saturating_sub(oku_m_out) <= max_loss,
            "round-trip loss exceeds bound"
        );

        // At $1.05 price, $1.00 multiplier — loss should remain small.
        let oku_m_price_105 = 1_050_000_000u64;
        let shares2 = oku_money_to_shares(oku_m_in, usd_multiplier, oku_m_price_105).unwrap();
        let oku_m_out2 = shares_to_oku_money(shares2, usd_multiplier, oku_m_price_105).unwrap();
        assert!(
            oku_m_out2 <= oku_m_in,
            "round-trip at $1.05 must not overpay"
        );
        let max_loss2 = (usd_multiplier / oku_m_price_105) + 2;
        assert!(
            oku_m_in.saturating_sub(oku_m_out2) <= max_loss2,
            "round-trip loss at $1.05 exceeds bound"
        );

        // At $1.10 price, $1.05 multiplier — test divergence case.
        let oku_m_price_110 = 1_100_000_000u64;
        let usd_multiplier_105 = 1_050_000_000u64;
        let shares3 = oku_money_to_shares(oku_m_in, usd_multiplier_105, oku_m_price_110).unwrap();
        let oku_m_out3 = shares_to_oku_money(shares3, usd_multiplier_105, oku_m_price_110).unwrap();
        assert!(
            oku_m_out3 <= oku_m_in,
            "round-trip at diverged prices must not overpay"
        );
        let max_loss3 = (usd_multiplier_105 / oku_m_price_110) + 2;
        assert!(
            oku_m_in.saturating_sub(oku_m_out3) <= max_loss3,
            "round-trip loss at diverged prices exceeds bound"
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
            calculate_collateral_ratio(100_000_000, 100_000_000, PRECISION, 1_050_000_000).unwrap(),
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

    /// Pin the rounding direction of `shares_to_oku_money` at FLOOR.
    ///
    /// This is the unit-level analog of the EVM-side `LitePSMRebasingRedeem`
    /// fuzz tests added in commit a8b82a9 — those pin-assert that
    /// `InsufficientBalance()` (the selector that surfaced when EVM
    /// `OkuDollar.unwrap` used ceiling division) can never appear post-fix.
    ///
    /// On SVM there is no analogous revert selector to pin (the EVM bug
    /// stemmed from a transfer-vs-unwrap asymmetry that does not exist on
    /// SVM), but the equivalent regression surface IS the rounding
    /// direction of `shares_to_oku_money`. If anyone flips floor → ceil
    /// (the EVM-style mutation), this test fails on the very first
    /// assertion — the share-conversion overpays by one unit.
    ///
    /// Inputs chosen so that `shares * usd_multiplier` has a non-zero
    /// remainder modulo `oku_m_price`, which is exactly where ceil and
    /// floor diverge by one unit.
    #[test]
    fn test_shares_to_oku_money_uses_floor_rounding() {
        // Case 1: shares=7, usd_multiplier=PRECISION, oku_m_price=3*PRECISION.
        //   floor(7 * 1e9 / 3e9) = floor(2.333...) = 2
        //   ceil(.)              = 3
        // The protocol must round DOWN (favours the vault). A ceil flip
        // would return 3 here and overpay the user by 1 OkuMoney unit.
        let out = shares_to_oku_money(7, PRECISION, 3 * PRECISION).unwrap();
        assert_eq!(
            out, 2,
            "shares_to_oku_money must floor — got {out}, ceil would return 3"
        );

        // Case 2: realistic Sepolia-flavoured numbers. usd_multiplier just
        // barely above PRECISION (the regime where the EVM bug surfaced).
        // Use a shares count that produces a non-zero remainder under
        // floor — `shares = 999` * usd_multiplier needs a non-zero mod
        // against 1e9. We pick 999 because 999 * 1_000_119_588 has a
        // remainder of 880_413_588 mod 1e9 — solidly non-zero, so floor
        // and ceil diverge by exactly 1 unit, matching the 1-share
        // mismatch that produced the EVM `InsufficientBalance()` revert.
        //
        //   shares * usd_multiplier = 999 * 1_000_119_588 = 999_119_468_412
        //   floor(.. / 1e9)         = 999
        //   ceil  (.. / 1e9)        = 1000  <-- the EVM-style mutation
        let sepolia_mult: u64 = 1_000_119_588u64;
        let shares: u64 = 999;
        let out2 = shares_to_oku_money(shares, sepolia_mult, PRECISION).unwrap();
        assert_eq!(
            out2, 999,
            "Sepolia-flavoured shares_to_oku_money must floor (ceil would return 1000)"
        );
    }

    /// Round-trip invariant that is SENSITIVE to a floor->ceil mutation.
    ///
    /// The existing `test_share_round_trip_precision_bound` test uses inputs
    /// whose product divides evenly under the test prices, so it silently
    /// passes even if `shares_to_oku_money` is mutated to use ceiling
    /// division. This test sweeps a range of (shares, multiplier, price)
    /// triples chosen so that floor and ceil ALWAYS differ by exactly 1
    /// unit; a ceil mutation makes every triple fail.
    ///
    /// Mirrors EVM `LitePSMRebasingRedeem.t.sol::test_RedeemUsdOku_Property_USDCOutLessThanOrEqualToUsdOkuIn`.
    #[test]
    fn test_share_round_trip_is_sensitive_to_ceil_mutation() {
        // Each tuple = (shares, usd_multiplier, oku_m_price, expected floor).
        // For every triple, prod = shares*mult is NOT divisible by price,
        // so floor < ceil by exactly 1 unit. The expected value is the
        // floor; the ceil mutation would return floor+1.
        let cases: &[(u64, u64, u64, u64)] = &[
            // shares=7, mult=1e9, price=3e9: prod=7e9, /3e9 = 2.333... → floor=2.
            (7, PRECISION, 3 * PRECISION, 2),
            // The Sepolia-flavoured slightly-elevated multiplier regime.
            // shares=999, mult=1_000_119_588, price=1e9: prod=999_119_468_412
            //   → floor=999, ceil=1000.
            (999, 1_000_119_588, PRECISION, 999),
            // Larger multiplier (yield trajectory): mult=1.5e9.
            // shares=11, mult=1.5e9, price=4e9: prod=16.5e9, /4e9 = 4.125 → floor=4.
            (11, 1_500_000_000, 4 * PRECISION, 4),
            // Dust shares at high multiplier — most sensitive to ceil overpay.
            // shares=1, mult=1_500_000_001, price=1e9: prod=1_500_000_001
            //   → floor=1, ceil=2 (overpay = 100%).
            (1, 1_500_000_001, PRECISION, 1),
        ];

        for &(shares, mult, price, expected_floor) in cases {
            let actual = shares_to_oku_money(shares, mult, price).unwrap();
            assert_eq!(
                actual, expected_floor,
                "shares_to_oku_money({shares}, {mult}, {price}) must floor — got {actual}, \
                 expected {expected_floor} (a ceil mutation would return {})",
                expected_floor + 1
            );
        }
    }
}
