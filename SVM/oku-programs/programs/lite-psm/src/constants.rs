//! # Lite-PSM constants
//!
//! Protocol-wide constants (`PRECISION`, `BASIS_POINTS`, `MAX_OKU_M_PRICE`,
//! oracle staleness bounds) live in the workspace crate `oku-shared` and
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

pub use oku_shared::{
    BASIS_POINTS, MAX_FEED_EXPO_MAGNITUDE, MAX_OKU_M_PRICE, ORACLE_MAX_STALENESS_SECS,
    ORACLE_MIN_STALENESS_SECS, ORACLE_USDC_PRICE_CEILING, ORACLE_USDC_PRICE_FLOOR, PRECISION,
};

// Bridge-specific constants (BRIDGE_DEADLINE_*, BRIDGE_MESSAGE_LEN,
// ED25519_*, MAX_SUPPORTED_CHAINS, MAX_NONCE_SKIP) were removed in the
// noBridge refactor (phase B). v1 cross-chain transfers are handled
// off-chain by an orchestrator; the on-chain bridge module that consumed
// these constants no longer exists.
