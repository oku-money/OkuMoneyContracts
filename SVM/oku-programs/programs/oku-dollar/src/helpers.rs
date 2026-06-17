//! OkuDollar vault math helpers.
//!
//! Cycle 4 (M-28): all share-system arithmetic now lives in
//! `oku_shared::vault_math`. The wrappers below remain only to map
//! `Option<u64>` → `OkuDollarError::*` so handlers can use `?`. The
//! tests below cover the Anchor-error mapping; primitive correctness
//! is covered by the unit tests + Kani harnesses + cargo-fuzz target
//! in `oku-shared`.
//!
//! Taken from <https://github.com/anomalyco/okuMoney/blob/main/contracts/EVM/src/token/OkuDollar.sol>.

use crate::errors::OkuDollarError;
use crate::state::OkuDollarConfig;
use anchor_lang::prelude::*;
use oku_shared::{math as shared, vault_math};

// ---------------------------------------------------------------------------
// Sandwich guard
// ---------------------------------------------------------------------------

/// Vault-side yield-distribution sandwich guard.
///
/// `update_usd_multiplier` stamps `last_yield_distribution_slot =
/// Clock::slot`, and `wrap` / `unwrap` reject when `Clock::slot ==
/// last_yield_distribution_slot`. This prevents the orchestrator
/// (or anyone observing the orchestrator's landed update) from
/// sandwiching the multiplier bump within a single slot to harvest
/// the yield.
///
/// Cycle 4 (OKUD-20): the slot comparison lives in the shared
/// `oku_shared::yield_lock_engaged`; this wrapper is just the
/// `Clock::get()` read + the Anchor-error mapping. Mirrors
/// `lite_psm::helpers::yield_lock::check_yield_lock` and EVM
/// `YieldSandwichGuard`.
pub fn check_vault_yield_lock(config: &OkuDollarConfig) -> Result<()> {
    let current_slot = Clock::get()?.slot;
    require!(
        !oku_shared::yield_lock_engaged(config.last_yield_distribution_slot, current_slot),
        OkuDollarError::YieldDistributionInProgress
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// Single-multiplier conversions (delegate to oku-shared::math)
// ---------------------------------------------------------------------------

/// Convert OkuMoney amount → USD value using `oku_m_price`.
///
/// `usd_value = floor(oku_m_amount * oku_m_price / PRECISION)`.
pub fn oku_money_to_usd(oku_m_amount: u64, oku_m_price: u64) -> Result<u64> {
    shared::oku_m_to_dollars(oku_m_amount, oku_m_price)
        .ok_or_else(|| error!(OkuDollarError::Overflow))
}

// ---------------------------------------------------------------------------
// Vault share + collateral conversions (delegate to oku-shared::vault_math)
// ---------------------------------------------------------------------------

/// Convert usdOku shares → OkuMoney amount.
///
/// Mirrors EVM `okuMReturned = (usdAmount * PRECISION) / okuMPrice`.
/// Floor rounding (protocol-favourable) — see
/// `oku_shared::math` for the workspace-wide rounding policy.
///
/// Mapping: `None` ⇒ `InvalidPrice` if the price is zero, else
/// `Overflow`. Guards are explicit so an auditor can see the failure-
/// mode → error-code map at a glance.
pub fn shares_to_oku_money(
    usd_oku_shares: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Result<u64> {
    require!(oku_m_price > 0, OkuDollarError::InvalidPrice);
    vault_math::shares_to_oku_money(usd_oku_shares, usd_multiplier, oku_m_price)
        .ok_or_else(|| error!(OkuDollarError::Overflow))
}

/// Convert OkuMoney amount → usdOku shares.
///
/// `shares = floor(oku_m_amount * oku_m_price / usd_multiplier)`.
pub fn oku_money_to_shares(
    oku_m_amount: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Result<u64> {
    require!(usd_multiplier > 0, OkuDollarError::InvalidMultiplier);
    require!(oku_m_price > 0, OkuDollarError::InvalidPrice);
    vault_math::oku_money_to_shares(oku_m_amount, usd_multiplier, oku_m_price)
        .ok_or_else(|| error!(OkuDollarError::Overflow))
}

/// Calculate the collateralization ratio of the vault.
///
/// See `oku_shared::vault_math::collateral_ratio` for the primitive;
/// this wrapper just maps overflow to `OkuDollarError::Overflow`.
///
/// Returns `u64::MAX` when `total_usd_oku_supply == 0` (no obligations
/// → undefined-but-infinite). Documented sentinel; downstream callers
/// only ever compare against `min_collateral_ratio ≤ PRECISION`, so
/// the sentinel always satisfies the "sufficiently collateralised"
/// predicate without ambiguity. Cycle 4 (OKUD-11): the sentinel-as-
/// value overload is intentional and bounded — pinned below.
pub fn calculate_collateral_ratio(
    reserve_balance: u64,
    total_usd_oku_supply: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Result<u64> {
    vault_math::collateral_ratio(
        reserve_balance,
        total_usd_oku_supply,
        usd_multiplier,
        oku_m_price,
    )
    .ok_or_else(|| error!(OkuDollarError::Overflow))
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

// Cycle 4 (S-33 / OKUD-18): dead `usd_to_oku_money` and
// `calculate_surplus` wrappers deleted. Both were
// `#[allow(dead_code)]` "MVP placeholders for a future
// `withdraw_surplus` instruction". The shared crate's
// `vault_math::surplus_oku_m` (and `dollars_to_oku_m`) is the
// canonical implementation; whoever lands `withdraw_surplus` should
// re-add a thin Anchor-error-mapping wrapper at that point.

// Cycle 4 (OKUD-11): pin the sentinel invariant — `u64::MAX` is the
// "infinite collateralisation" return value; it must remain strictly
// greater than any valid `min_collateral_ratio` so the
// `ratio >= min` comparison in `is_sufficiently_collateralized`
// always succeeds on the zero-supply branch. The setter bounds
// `min_collateral_ratio <= PRECISION` (= 1e9), well below u64::MAX.
const _: () = assert!(u64::MAX > oku_shared::PRECISION);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    //! Tests below cover the Anchor-error mapping ONLY. Primitive
    //! correctness (including the EVM-bug "ceil mutation" regression
    //! tests) lives in `oku_shared::vault_math` / `oku_shared::math`.
    use super::*;
    use oku_shared::PRECISION;

    #[test]
    fn oku_money_to_usd_basic() {
        assert_eq!(oku_money_to_usd(1_000_000, PRECISION).unwrap(), 1_000_000);
    }

    #[test]
    fn shares_to_oku_money_rejects_zero_price() {
        let err = shares_to_oku_money(1, PRECISION, 0).unwrap_err();
        assert!(err.to_string().contains("Invalid OkuMoney price"));
    }

    #[test]
    fn oku_money_to_shares_rejects_zero_multiplier() {
        let err = oku_money_to_shares(1, 0, PRECISION).unwrap_err();
        assert!(err.to_string().contains("Invalid USD multiplier"));
    }

    #[test]
    fn collateral_ratio_at_par_is_precision() {
        assert_eq!(
            calculate_collateral_ratio(100_000_000, 100_000_000, PRECISION, PRECISION).unwrap(),
            PRECISION
        );
    }

    #[test]
    fn is_sufficiently_collateralized_basic() {
        assert!(
            is_sufficiently_collateralized(110_000_000, 100_000_000, PRECISION, PRECISION, PRECISION)
                .unwrap()
        );
        assert!(
            !is_sufficiently_collateralized(90_000_000, 100_000_000, PRECISION, PRECISION, PRECISION)
                .unwrap()
        );
    }

    /// Pin the rounding direction at FLOOR — the unit-level analog of
    /// the EVM-side `LitePSMRebasingRedeem` ceil-mutation regression
    /// tests added in commit a8b82a9. If a future refactor flips
    /// `oku_shared::vault_math::shares_to_oku_money` from `mul_div_floor`
    /// to `mul_div_ceil`, this test fails on the very first assertion.
    ///
    /// Inputs chosen so floor and ceil diverge by exactly 1 unit.
    #[test]
    fn shares_to_oku_money_uses_floor_rounding() {
        // 7 shares * 1e9 mult / 3e9 price = 2.333... → floor = 2, ceil = 3.
        let out = shares_to_oku_money(7, PRECISION, 3 * PRECISION).unwrap();
        assert_eq!(
            out, 2,
            "shares_to_oku_money must floor — got {out}, ceil would return 3"
        );

        // Sepolia-flavoured slightly-elevated multiplier (regime where
        // the EVM bug surfaced).
        let sepolia_mult: u64 = 1_000_119_588;
        let shares: u64 = 999;
        let out2 = shares_to_oku_money(shares, sepolia_mult, PRECISION).unwrap();
        assert_eq!(out2, 999, "Sepolia-flavoured ceil would return 1000");
    }
}
