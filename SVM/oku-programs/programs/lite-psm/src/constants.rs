//! # Lite-PSM constants
//!
//! Protocol-wide constants (`PRECISION`, `BASIS_POINTS`, `MAX_OKU_M_PRICE`,
//! oracle staleness bounds) live in the workspace crate `oku-shared` and
//! are re-exported here for ergonomics — call sites continue to write
//! `use crate::constants::*` without caring where the constant is
//! authored.
//!
//! Bridge-specific constants (deadline bounds, wire-format lengths, the
//! `skip_nonce` cap) stay in this module because they have no
//! `oku-dollar` counterpart.
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
    BASIS_POINTS, MAX_OKU_M_PRICE, ORACLE_MAX_STALENESS_SECS, ORACLE_MIN_STALENESS_SECS, PRECISION,
};

// ---------------------------------------------------------------------------
// Bridge-specific constants (no oku-dollar counterpart)
// ---------------------------------------------------------------------------

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
// F-10: declared as u16 (matches Solana's instruction index type) to avoid
// the usize→u16 truncation cast at the loop site in ed25519.rs.
pub const ED25519_INSTRUCTION_SCAN_LIMIT: u16 = 16;

/// Maximum number of supported destination chains stored on `BridgeConfig`.
/// Backing array is `[u16; 32]`.
pub const MAX_SUPPORTED_CHAINS: u8 = 32;

/// Maximum number of nonces `skip_nonce` may skip in a single call.
/// Defends against an admin foot-gun that would jump `next_nonce` near
/// `u64::MAX`, which would risk eventual overflow in `bridge_burn`'s
/// `next_nonce.checked_add(1)`. EVM `OkuBridge.skipNonce` increments by
/// exactly 1; SVM allows arbitrary delta but caps it here.
pub const MAX_NONCE_SKIP: u64 = 10_000;
