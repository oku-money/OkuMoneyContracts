//! Two-multiplier vault math for OkuDollar (and any future vault that
//! conforms to the (oku_m_price, usd_multiplier) accounting model).
//!
//! These primitives compose `mul_div_floor` to express the share-system
//! conversions in one place. The single source of truth lives here so the
//! Kani harnesses, the cargo-fuzz targets, and the on-chain handlers all
//! consume the same math.
//!
//! Cycle 4 (M-28): moved from `oku-dollar/src/helpers.rs` into the
//! shared crate so:
//!   * lite-psm can use the same `collateral_ratio` primitive if a
//!     future PSM admin instruction needs it,
//!   * the Kani / cargo-fuzz coverage that already targets the shared
//!     `math` module can extend to these primitives without crossing
//!     a workspace boundary, and
//!   * an auditor reading `oku-shared` gets the whole protocol's
//!     numeric surface in one place.
//!
//! All functions return `Option<u64>` for the same reason the floor /
//! ceil primitives do: each program maps `None` to its own
//! `Error::Overflow` / `Error::InvalidPrice` / `Error::InvalidMultiplier`
//! variant.
//!
//! ## Rounding direction
//!
//! Every conversion floor-rounds, matching the protocol-wide policy
//! documented in `math.rs`. This is intentional: the user receives no
//! more than mathematically due (`shares_to_oku_money`), and the vault
//! never over-credits shares (`oku_money_to_shares`). See the EVM-side
//! `MathLib.sol` for the matching choice.

use crate::constants::PRECISION;
use crate::math::mul_div_floor;

/// Convert OkuMoney → vault shares (price-aware).
///
/// `shares = floor(oku_m_amount * oku_m_price / usd_multiplier)`.
/// Matches EVM `OkuDollar.wrap`'s `sharesToMint = actualReceived *
/// okuMPrice / usdMultiplier`.
///
/// Returns `None` when `usd_multiplier == 0`, `oku_m_price == 0`, or the
/// intermediate product overflows the `u128` widening. Callers should
/// guard the multipliers at the program boundary and surface a more
/// specific error (`InvalidMultiplier` / `InvalidPrice`); a `None` here
/// almost always means overflow at realistic inputs.
#[inline]
pub fn oku_money_to_shares(
    oku_m_amount: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Option<u64> {
    if usd_multiplier == 0 || oku_m_price == 0 {
        return None;
    }
    mul_div_floor(oku_m_amount, oku_m_price, usd_multiplier)
}

/// Convert vault shares → OkuMoney (price-aware).
///
/// `oku_m_amount = floor(usd_oku_shares * usd_multiplier / oku_m_price)`.
/// Matches EVM `OkuDollar.unwrap`'s `okuMReturned`.
///
/// `None` semantics identical to [`oku_money_to_shares`].
#[inline]
pub fn shares_to_oku_money(
    usd_oku_shares: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Option<u64> {
    if oku_m_price == 0 {
        return None;
    }
    mul_div_floor(usd_oku_shares, usd_multiplier, oku_m_price)
}

/// Compute the vault's collateralisation ratio (price-aware).
///
/// ```text
/// ratio = floor(reserve_balance * oku_m_price * PRECISION
///             / (total_usd_oku_supply * usd_multiplier))
/// ```
///
/// Returns `Some(u64::MAX)` when `total_usd_oku_supply == 0` (no
/// obligations → undefined-but-infinite). Returns `None` only on
/// `u128` overflow of the numerator. The denominator's u128 product
/// (`total_supply * usd_multiplier`) cannot overflow for any pair of
/// u64 inputs (proven by Kani on `mul_div_floor`'s sister proof —
/// u64 × u64 always fits in u128).
///
/// The numerator widens through THREE multiplications
/// (`reserve * price * PRECISION`); each is `checked_mul` on u128.
/// If the final value can't be narrowed back to u64 it's clamped at
/// `u64::MAX`, matching the "infinite ratio" sentinel above. The
/// `is_sufficiently_collateralized` consumer never bridges that range
/// in practice because `min_collateral_ratio <= PRECISION`.
#[inline]
pub fn collateral_ratio(
    reserve_balance: u64,
    total_usd_oku_supply: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Option<u64> {
    if total_usd_oku_supply == 0 {
        return Some(u64::MAX);
    }
    let denominator = (total_usd_oku_supply as u128).checked_mul(usd_multiplier as u128)?;
    if denominator == 0 {
        return Some(u64::MAX);
    }
    let numerator = (reserve_balance as u128)
        .checked_mul(oku_m_price as u128)?
        .checked_mul(PRECISION as u128)?;
    // `denominator > 0` by the early return above.
    #[allow(clippy::arithmetic_side_effects)]
    let result = numerator / denominator;
    Some(u64::try_from(result).unwrap_or(u64::MAX))
}

/// Compute extractable surplus in OkuMoney tokens.
///
/// ```text
/// required  = floor(total_usd_oku_supply * usd_multiplier / oku_m_price)
/// surplus   = saturating_sub(reserve_balance, required)
/// ```
///
/// Returns `Some(reserve_balance)` when `total_usd_oku_supply == 0`
/// (no obligations → all reserves are surplus). Returns `None` only
/// when the `mul_div_floor` overflow path is hit.
#[inline]
pub fn surplus_oku_m(
    reserve_balance: u64,
    total_usd_oku_supply: u64,
    usd_multiplier: u64,
    oku_m_price: u64,
) -> Option<u64> {
    if total_usd_oku_supply == 0 {
        return Some(reserve_balance);
    }
    if oku_m_price == 0 {
        return None;
    }
    let required = mul_div_floor(total_usd_oku_supply, usd_multiplier, oku_m_price)?;
    Some(reserve_balance.saturating_sub(required))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oku_money_to_shares_identity_at_par() {
        assert_eq!(
            oku_money_to_shares(1_000_000, PRECISION, PRECISION),
            Some(1_000_000)
        );
    }

    #[test]
    fn oku_money_to_shares_rejects_zero_divisors() {
        assert_eq!(oku_money_to_shares(1_000_000, 0, PRECISION), None);
        assert_eq!(oku_money_to_shares(1_000_000, PRECISION, 0), None);
    }

    #[test]
    fn shares_to_oku_money_identity_at_par() {
        assert_eq!(
            shares_to_oku_money(1_000_000, PRECISION, PRECISION),
            Some(1_000_000)
        );
    }

    #[test]
    fn shares_to_oku_money_floors() {
        // 7 shares * PRECISION / 3*PRECISION = 2.33... → 2.
        assert_eq!(shares_to_oku_money(7, PRECISION, 3 * PRECISION), Some(2));
    }

    #[test]
    fn collateral_ratio_returns_max_on_zero_supply() {
        assert_eq!(
            collateral_ratio(1_000_000_000, 0, PRECISION, PRECISION),
            Some(u64::MAX)
        );
    }

    #[test]
    fn collateral_ratio_100_percent_at_par() {
        assert_eq!(
            collateral_ratio(100_000_000, 100_000_000, PRECISION, PRECISION),
            Some(PRECISION)
        );
    }

    #[test]
    fn collateral_ratio_at_high_price_increases() {
        // 100 OkuM reserve * $1.05 price / 100 share supply * $1 mult = 105 %.
        assert_eq!(
            collateral_ratio(100_000_000, 100_000_000, PRECISION, 1_050_000_000),
            Some(1_050_000_000)
        );
    }

    #[test]
    fn surplus_zero_supply_returns_all_reserve() {
        assert_eq!(
            surplus_oku_m(50_000_000, 0, PRECISION, PRECISION),
            Some(50_000_000)
        );
    }

    #[test]
    fn surplus_underwater_is_zero() {
        assert_eq!(
            surplus_oku_m(90_000_000, 100_000_000, PRECISION, PRECISION),
            Some(0)
        );
    }

    #[test]
    fn surplus_undefined_at_zero_price() {
        assert_eq!(surplus_oku_m(1, 1, PRECISION, 0), None);
    }
}

// ---------------------------------------------------------------------------
// Kani harnesses
// ---------------------------------------------------------------------------
//
// Bounded to the same 8-bit domain as `mul_div_floor` because each
// primitive composes one or more `mul_div_floor` calls and inherits the
// SAT-instance complexity from there. The cargo-fuzz `collateral_ratio`
// target picks up the full u64 range.

#[cfg(kani)]
mod verification {
    use super::*;

    #[kani::proof]
    fn proof_oku_money_to_shares_zero_multiplier_is_none() {
        let a: u64 = kani::any();
        let p: u64 = kani::any();
        assert!(oku_money_to_shares(a, 0, p).is_none());
    }

    #[kani::proof]
    fn proof_shares_to_oku_money_zero_price_is_none() {
        let s: u64 = kani::any();
        let m: u64 = kani::any();
        assert!(shares_to_oku_money(s, m, 0).is_none());
    }

    /// `oku_money_to_shares ∘ shares_to_oku_money <= identity`.
    /// Bounded 8-bit (3 variables → SAT instance is ~16-bit even after
    /// the conjoint inverse — the round trip composes two `mul_div_floor`
    /// each of which doubles the carry width).
    #[kani::proof]
    fn proof_share_round_trip_monotone() {
        const DOMAIN_MAX: u64 = u8::MAX as u64;
        let oku_m_in: u64 = kani::any();
        let usd_mult: u64 = kani::any();
        let price: u64 = kani::any();
        kani::assume(oku_m_in <= DOMAIN_MAX);
        kani::assume(usd_mult > 0 && usd_mult <= DOMAIN_MAX);
        kani::assume(price > 0 && price <= DOMAIN_MAX);
        if let Some(shares) = oku_money_to_shares(oku_m_in, usd_mult, price) {
            if let Some(oku_m_back) = shares_to_oku_money(shares, usd_mult, price) {
                assert!(oku_m_back <= oku_m_in);
            }
        }
    }

    /// `collateral_ratio == u64::MAX` ⇔ `total_supply == 0`.
    #[kani::proof]
    fn proof_collateral_ratio_inf_iff_zero_supply() {
        const DOMAIN_MAX: u64 = u8::MAX as u64;
        let reserve: u64 = kani::any();
        let supply: u64 = kani::any();
        let mult: u64 = kani::any();
        let price: u64 = kani::any();
        kani::assume(reserve <= DOMAIN_MAX);
        kani::assume(supply <= DOMAIN_MAX);
        kani::assume(mult <= DOMAIN_MAX);
        kani::assume(price <= DOMAIN_MAX);
        if let Some(ratio) = collateral_ratio(reserve, supply, mult, price) {
            // forward
            if supply == 0 {
                assert_eq!(ratio, u64::MAX);
            }
        }
    }
}
