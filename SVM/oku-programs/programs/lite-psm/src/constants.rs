//! # OkuMoney SVM Constants (Lite-PSM)
//!
//! Numeric constants for the Lite-PSM program. Math helpers live in
//! `crate::helpers::math` so this module stays purely declarative
//! (mirrors `oku-dollar/src/constants.rs`).
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

/// Standard precision for price and multiplier calculations.
/// 1e9 = $1.00 on SVM (equivalent to 1e18 on EVM).
pub const PRECISION: u64 = 1_000_000_000;

/// Basis points denominator (10000 = 100%).
/// Used for fee calculations (e.g., 10 bps = 0.1%).
pub const BASIS_POINTS: u64 = 10_000;

/// Lower bound for the bridge deadline (in seconds). Anything below this is
/// rejected by `initialize_bridge` / `update_bridge_deadline` because deadlines
/// shorter than ~1 minute would routinely expire before the orchestrator has
/// finished signing.
pub const BRIDGE_DEADLINE_MIN_SECS: i64 = 60;

/// Upper bound for the bridge deadline (in seconds). Catches operator
/// misconfiguration that would silently allow signatures to be replayed weeks
/// after burn. Set to 7 days; mirrors `Constants.ORACLE_MAX_STALENESS` on EVM.
pub const BRIDGE_DEADLINE_MAX_SECS: i64 = 7 * 24 * 60 * 60;
