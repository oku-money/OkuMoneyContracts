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

// ===== Bridge wire-format constants =====

/// Length of the canonical 80-byte BridgeRequest message (both directions).
/// See `state::BridgeRequest::to_message_bytes` and the SVM-burn handler.
pub const BRIDGE_MESSAGE_LEN: usize = 80;

/// Length of an Ed25519 detached signature (libsodium format).
pub const ED25519_SIGNATURE_LEN: usize = 64;

/// Number of leading instructions scanned by the Ed25519 introspection helper
/// when looking for a matching sigverify ix. Set high enough that real
/// transactions (compute-budget + ATA create + bridge_mint + ...) fit, low
/// enough that a griefer cannot inflate scan cost to OOM.
pub const ED25519_INSTRUCTION_SCAN_LIMIT: usize = 16;

/// Maximum number of supported destination chains stored on `BridgeConfig`.
/// Backing array is `[u16; 32]`.
pub const MAX_SUPPORTED_CHAINS: u8 = 32;

/// Maximum number of nonces `skip_nonce` may skip in a single call.
/// Defends against an admin foot-gun that would jump `next_nonce` near
/// `u64::MAX`, which would risk eventual overflow in `bridge_burn`'s
/// `next_nonce.checked_add(1)`. EVM `OkuBridge.skipNonce` increments by
/// exactly 1; SVM allows arbitrary delta but caps it here.
pub const MAX_NONCE_SKIP: u64 = 10_000;

// ===== Oracle staleness bounds =====

/// Lower bound on the configurable oracle staleness threshold. Below this,
/// freshness is so tight that benign network jitter will force `mint_oku_m`
/// to fall through into a hard-fail oracle path. Mirrors EVM
/// `Constants.ORACLE_MIN_STALENESS`.
pub const ORACLE_MIN_STALENESS_SECS: i64 = 60;

/// Upper bound on the configurable oracle staleness threshold. Above this,
/// the oracle is essentially always "fresh" and provides no protection.
/// Mirrors EVM `Constants.ORACLE_MAX_STALENESS` (7 days).
pub const ORACLE_MAX_STALENESS_SECS: i64 = 7 * 24 * 60 * 60;

// ===== Yield-rebaser sanity bounds =====

/// Maximum allowed `oku_m_price` ceiling. Even with the rebaser key
/// compromised, the rebaser cannot push the price beyond this value, which
/// keeps subsequent multiplications inside the `u128` intermediate space and
/// avoids permanent DoS via overflow. Set to 1e15 = $1,000,000.00 per
/// OkuMoney token, which is far above any realistic yield trajectory.
pub const MAX_OKU_M_PRICE: u64 = 1_000_000_000_000_000;
