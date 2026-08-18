//! # Lite-PSM constants
//!
//! Protocol-wide constants (`PRECISION`, `MAX_MULTIPLIER`)
//! live in the workspace crate `oku-shared` and
//! are re-exported here for ergonomics — call sites continue to write
//! `use crate::constants::*` without caring where the constant is
//! authored.
//!
//! ## Single-Token Design (OkuM)
//!
//! The PSM operates on a single token: **OkuM**, a Token-2022 mint with
//! the `ScaledUiAmount` extension. The multiplier that converts between
//! raw token amounts and dollar-display values is stored on the mint
//! itself via `ScaledUiAmountConfig`.
//!
//! ### Token Amounts
//!
//! | Name | Decimals | Description |
//! |------|----------|-------------|
//! | `raw_amount` | 6 | Raw OkuM token count (on-chain) |
//! | `usdc_amount` | 6 | USDC amount |
//!
//! ## Key Formulas
//!
//! The `multiplier` is read from the OkuM mint's `ScaledUiAmountConfig`
//! extension at the time of the operation.
//!
//! ```text
//! USDC -> OkuM:  raw_amount  = (usdc_amount * PRECISION) / multiplier
//! OkuM -> USDC:  usdc_amount = (raw_amount * multiplier) / PRECISION
//! ```
//!
//! ## EVM ↔ SVM Decimal Mapping
//!
//! | Type | EVM (decimals) | SVM (decimals) |
//! |------|----------------|----------------|
//! | USDC | 6 | 6 |
//! | OkuM | 18 | 6 |
//! | Multipliers | 18 (1e18 = $1) | 9 (1e9 = $1) |

// ---------------------------------------------------------------------------
// Re-exports from the shared workspace crate
// ---------------------------------------------------------------------------

pub use oku_shared::{MAX_MULTIPLIER, PRECISION, TOKEN_DECIMALS};

// ---------------------------------------------------------------------------
// On-chain Token-2022 metadata identity (OkuM)
// ---------------------------------------------------------------------------
//
// Single source of truth for the OkuM mint's Token-2022 `TokenMetadata`
// `name`/`symbol`. These are the TRUE on-chain identity of the token and
// are what wallets and block explorers display for the mint itself and
// for transfers. They MUST match the EVM `OkuMoney` (OkuM) token so the
// two chains present a consistent identity:
//
//   EVM `EVM/test/shared/Constants.sol`: OKUMONEY_NAME="OkuMoney",
//   OKUMONEY_SYMBOL="OkuM".
//
// Design note — OkuM vs usdOku:
//   * The on-chain metadata below is the base, value-appreciating,
//     T-Bill-backed token: **OkuM ("OkuMoney")**. Explorers and generic
//     wallets show these true, non-$1-pegged OkuM amounts.
//   * The "$1-pegged usdOku" number is a *display-layer* value produced
//     by the mint's `ScaledUiAmount` extension (raw_amount * multiplier),
//     which Token-2022-aware wallets render automatically. usdOku is NOT
//     the on-chain symbol; it is the wallet presentation of the scaled
//     UI amount. (On EVM, usdOku/"OkuDollar" is a *separate* wrapper
//     token; SVM collapses that into the ScaledUiAmount display of the
//     single OkuM mint.)
//
// These constants are consumed by `initialize` (mint metadata init) and
// by `update_token_metadata` (in-place rename of an already-deployed
// mint). Keeping a single definition prevents the two call sites from
// drifting on a future rename.
pub const OKU_M_METADATA_NAME: &str = "OkuMoney";
pub const OKU_M_METADATA_SYMBOL: &str = "OkuM";
