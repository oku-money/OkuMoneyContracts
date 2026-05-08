//! # OkuDollar Vault Constants
//!
//! Numeric constants for the OkuDollar vault. Top-level module so callers can
//! reference `crate::constants::*` directly (mirrors the EVM-side
//! `src/lib/Constants.sol` and the lite-psm `src/constants.rs` layout).
//!
//! Math helpers live in `crate::helpers` so this module stays purely declarative.

/// Standard precision for multipliers (1e9 = $1.00).
/// Matches EVM's PRECISION constant.
pub const PRECISION: u64 = 1_000_000_000;

/// Dead shares permanently locked in an ATA owned by the System Program.
/// Nobody holds the System Program's private key, so the tokens are unrecoverable.
/// This prevents the first-depositor inflation attack on vault shares.
///
/// Pattern adapted from Uniswap V2 `_mint(address(0), MINIMUM_LIQUIDITY)`.
/// Taken from https://github.com/Uniswap/v2-core/blob/master/contracts/UniswapV2Pair.sol
pub const MINIMUM_LIQUIDITY: u64 = 1_000_000; // 10^6 = 1 usdOku (6 decimals)

/// Minimum collateral ratio floor (90% = 900_000_000).
/// Protocol cannot set min_collateral_ratio below this value. Mirrors EVM's
/// `MIN_COLLATERAL_RATIO_FLOOR` constant on `OkuDollar`.
pub const MIN_COLLATERAL_RATIO_FLOOR: u64 = 900_000_000;

/// Absolute maximum allowed `usd_multiplier`. Even with the `usd_rebaser`
/// key compromised, the multiplier cannot be pushed beyond this value, which
/// keeps subsequent multiplications inside the `u128` intermediate space and
/// avoids permanent DoS via overflow. Set to 1e15 = $1,000,000.00 per share,
/// far above any realistic yield trajectory. Mirrors `MAX_OKU_M_PRICE`
/// on the lite-psm side.
pub const MAX_USD_MULTIPLIER: u64 = 1_000_000_000_000_000;
