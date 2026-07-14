//! # Lite-PSM constants
//!
//! Protocol-wide constants (`PRECISION`, `BASIS_POINTS`, `MAX_MULTIPLIER`)
//! live in the workspace crate `oku-shared` and
//! are re-exported here for ergonomics — call sites continue to write
//! `use crate::constants::*` without caring where the constant is
//! authored.
//!
//! ## Single-Token Design (usdOku)
//!
//! The PSM operates on a single token: **usdOku**, a Token-2022 mint with
//! the `ScaledUiAmount` extension. The multiplier that converts between
//! raw token amounts and dollar-display values is stored on the mint
//! itself via `ScaledUiAmountConfig`.
//!
//! ### Token Amounts
//!
//! | Name | Decimals | Description |
//! |------|----------|-------------|
//! | `raw_amount` | 6 | Raw usdOku token count (on-chain) |
//! | `usdc_amount` | 6 | USDC amount |
//!
//! ## Key Formulas
//!
//! The `multiplier` is read from the usdOku mint's `ScaledUiAmountConfig`
//! extension at the time of the operation.
//!
//! ```text
//! USDC -> usdOku:  raw_amount  = (usdc_amount * PRECISION) / multiplier
//! usdOku -> USDC:  usdc_amount = (raw_amount * multiplier) / PRECISION
//! ```
//!
//! ## EVM ↔ SVM Decimal Mapping
//!
//! | Type | EVM (decimals) | SVM (decimals) |
//! |------|----------------|----------------|
//! | USDC | 6 | 6 |
//! | usdOku | 18 | 6 |
//! | Multipliers | 18 (1e18 = $1) | 9 (1e9 = $1) |

// ---------------------------------------------------------------------------
// Re-exports from the shared workspace crate
// ---------------------------------------------------------------------------

pub use oku_shared::{BASIS_POINTS, MAX_MULTIPLIER, PRECISION};
