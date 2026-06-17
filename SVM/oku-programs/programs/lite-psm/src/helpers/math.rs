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

/// Convert OkuMoney amount to dollar value using `oku_m_price` with
/// **floor** rounding. Use when the dollar figure is being credited to a
/// user (user gets no more than they earned).
///
/// Formula: `dollar_value = floor(oku_m_amount * oku_m_price / PRECISION)`.
pub fn oku_m_to_dollars(oku_m_amount: u64, oku_m_price: u64) -> Result<u64> {
    shared::oku_m_to_dollars(oku_m_amount, oku_m_price)
        .ok_or_else(|| error!(LitePsmError::Overflow))
}

/// Convert OkuMoney amount to dollar value using `oku_m_price` with
/// **ceil** rounding. Use when the dollar figure becomes a protocol
/// obligation (reserved-balance accounting in `withdraw_buffer`, e.g.).
///
/// Formula: `dollar_value = ceil(oku_m_amount * oku_m_price / PRECISION)`.
///
/// The semantic contract — over-reserve by at most one lamport per call
/// rather than under-reserve by up to `queue_depth` lamports per batch —
/// is the audit-grade fix for the rounding asymmetry between
/// `withdraw_buffer` (single floor) and `process_queue` (per-entry
/// floors that sum to `≤ floor(sum)`).
pub fn oku_m_to_dollars_ceil(oku_m_amount: u64, oku_m_price: u64) -> Result<u64> {
    shared::oku_m_to_dollars_ceil(oku_m_amount, oku_m_price)
        .ok_or_else(|| error!(LitePsmError::Overflow))
}

/// Convert dollar value to OkuMoney amount using `oku_m_price`.
///
/// Formula: `oku_m_amount = (dollar_value * PRECISION) / oku_m_price`.
/// Rejects `oku_m_price == 0` with `ZeroAmount` (the program-side
/// invariant); pure overflow propagates as `Overflow`.
pub fn dollars_to_oku_m(dollar_value: u64, oku_m_price: u64) -> Result<u64> {
    require!(oku_m_price > 0, LitePsmError::ZeroAmount);
    shared::dollars_to_oku_m(dollar_value, oku_m_price)
        .ok_or_else(|| error!(LitePsmError::Overflow))
}

// Cycle 4 (S-33): `calculate_fee` wrapper deleted (was
// `#[allow(dead_code)]` for the "future PSM fee" seam). The
// `oku_shared::calculate_fee` primitive remains — whoever lands a
// PSM fee instruction adds the thin Anchor-error wrapper at that
// time.

#[cfg(test)]
mod tests {
    //! These tests cover the Anchor-error-mapping layer. The underlying
    //! math primitives have their own coverage in
    //! `oku_shared::math::tests`.
    use super::*;
    use oku_shared::PRECISION;

    #[test]
    fn oku_m_to_dollars_basic_at_par() {
        assert_eq!(oku_m_to_dollars(1_000_000, PRECISION).unwrap(), 1_000_000);
    }

    #[test]
    fn oku_m_to_dollars_ceil_basic() {
        // Exact division — equal to floor.
        assert_eq!(oku_m_to_dollars_ceil(1_000_000, PRECISION).unwrap(), 1_000_000);
    }

    #[test]
    fn dollars_to_oku_m_zero_price_is_zero_amount() {
        let err = dollars_to_oku_m(1_000_000, 0).unwrap_err();
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
