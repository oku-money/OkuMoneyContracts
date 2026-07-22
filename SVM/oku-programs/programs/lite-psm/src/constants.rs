//! # Lite-PSM constants
//!
//! Protocol-wide constants (`PRECISION`, `BASIS_POINTS`, `MAX_OKU_M_PRICE`)
//! live in the workspace crate `oku-shared` and
//! are re-exported here for ergonomics — call sites continue to write
//! `use crate::constants::*` without caring where the constant is
//! authored.
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

// ---------------------------------------------------------------------------
// Re-exports from the shared workspace crate
// ---------------------------------------------------------------------------

pub use oku_shared::{BASIS_POINTS, MAX_OKU_M_PRICE, PRECISION};

// Bridge-specific constants (BRIDGE_DEADLINE_*, BRIDGE_MESSAGE_LEN,
// BRIDGE_ED25519_*, MAX_SUPPORTED_CHAINS, MAX_NONCE_SKIP) were removed in the
// noBridge refactor (phase B). v1 cross-chain transfers are handled
// off-chain by an orchestrator; the on-chain bridge module that consumed
// these constants no longer exists.

// ---------------------------------------------------------------------------
// Cross-program references
// ---------------------------------------------------------------------------

/// OkuDollar program ID. Used by `mint_usd_oku_direct` to validate the
/// oku-dollar program account before issuing a CPI. Matches the
/// `declare_id!` in `oku-dollar/src/lib.rs`.
///
/// We cannot add oku-dollar as a cargo dependency (circular: oku-dollar
/// already depends on lite-psm), so the program ID is pinned here as raw
/// bytes. If the oku-dollar program ID ever changes, this constant MUST be
/// updated in lockstep.
pub const OKU_DOLLAR_PROGRAM_ID: anchor_lang::prelude::Pubkey =
    anchor_lang::prelude::Pubkey::new_from_array([
        // Base58: 5SK6EhbXf9d7jW4vzobZfbtUsZBQmFyo9w3xuSQY3Zke
        0x41, 0xea, 0xb9, 0x01, 0x52, 0x64, 0xdd, 0x53, 0x09, 0xfe, 0xb4, 0xa0, 0x70, 0x86, 0xdc,
        0xca, 0x52, 0x12, 0x1d, 0x19, 0x32, 0xa1, 0xc9, 0x8a, 0xc4, 0x16, 0x42, 0xa3, 0x69, 0xea,
        0x8a, 0x43,
    ]);
