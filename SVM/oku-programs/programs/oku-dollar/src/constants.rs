//! # OkuDollar vault constants
//!
//! Protocol-wide constants (`PRECISION`, `BASIS_POINTS`,
//! `MIN_COLLATERAL_RATIO_FLOOR`, `MAX_USD_MULTIPLIER`) live in the
//! workspace crate `oku-shared` and are re-exported here for
//! ergonomics — call sites continue to write `use crate::constants::*`.
//!
//! Vault-specific constants (`MINIMUM_LIQUIDITY` for inflation-attack
//! defence) stay in this module because they have no lite-psm
//! counterpart.

// ---------------------------------------------------------------------------
// Re-exports from the shared workspace crate
// ---------------------------------------------------------------------------

pub use oku_shared::{MAX_USD_MULTIPLIER, MIN_COLLATERAL_RATIO_FLOOR, PRECISION};

// ---------------------------------------------------------------------------
// Vault-specific constants (no lite-psm counterpart)
// ---------------------------------------------------------------------------

/// Dead shares permanently locked in an ATA owned by the System Program.
/// Nobody holds the System Program's private key, so the tokens are
/// unrecoverable. This prevents the first-depositor inflation attack on
/// vault shares.
///
/// Pattern adapted from Uniswap V2 `_mint(address(0), MINIMUM_LIQUIDITY)`.
/// Taken from https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol
pub const MINIMUM_LIQUIDITY: u64 = 1_000_000; // 10^6 = 1 usdOku (6 decimals)
