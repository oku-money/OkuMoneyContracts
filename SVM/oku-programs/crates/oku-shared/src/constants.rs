//! Protocol-wide numeric constants.
//!
//! Anything declared here MUST also appear in `EVM/src/lib/Constants.sol`
//! (or be a documented divergence in `SVM/EVM_VS_SVM.md`). Scaling is the
//! one deliberate exception: EVM uses `1e18`, SVM uses `1e9`, because
//! SVM tokens are 6-decimal vs EVM's 18-decimal.

// ---------------------------------------------------------------------------
// Precision / basis points
// ---------------------------------------------------------------------------

/// Standard precision for multipliers and prices (1e9 = $1.00).
///
/// SVM equivalent of EVM's `Constants.PRECISION = 1e18`. Used by every
/// multiplier-based conversion in both `lite-psm` (`oku_m_price`) and
/// `oku-dollar` (`usd_multiplier`).
pub const PRECISION: u64 = 1_000_000_000;

/// Basis-points denominator (10_000 = 100%). Mirrors EVM
/// `Constants.BASIS_POINTS`.
pub const BASIS_POINTS: u64 = 10_000;

// ---------------------------------------------------------------------------
// Collateralization
// ---------------------------------------------------------------------------

/// Hard floor for the OkuDollar `min_collateral_ratio` config field
/// (90% of `PRECISION`). Configuring a value below this would let the vault
/// run perpetually under-collateralised, so the setter rejects it.
///
/// Mirrors EVM `Constants.MIN_COLLATERAL_RATIO_FLOOR = 9e17`.
pub const MIN_COLLATERAL_RATIO_FLOOR: u64 = 900_000_000;

// ---------------------------------------------------------------------------
// Multiplier ceilings
// ---------------------------------------------------------------------------

/// Absolute maximum allowed value for ANY multiplier in the protocol —
/// `oku_m_price` (lite-psm) and `usd_multiplier` (oku-dollar) both honour
/// this ceiling.
///
/// Set to `1e15` (≈ $1,000,000.00 per token), which is far above any
/// realistic yield trajectory and keeps subsequent `u64 * u64 -> u128`
/// multiplications away from the overflow region.
///
/// Math-sanity bound that keeps the rpow / mul-div input space finite.
/// Not a guard against a compromised rebaser key — operator-compromise
/// is out of scope per the centralized trust model (see
/// `SVM/README.md § Authority Model` and `SVM/TRACKER.md`).
///
/// EVM mirror: `Constants.MAX_MULTIPLIER = 1e24`. EVM also relies on
/// `Constants.MAX_RATE` for the per-second rate cap; SVM uses discrete
/// multiplier writes and so only needs the cumulative bound.
pub const MAX_MULTIPLIER: u64 = 1_000_000_000_000_000;

/// Alias of `MAX_MULTIPLIER` used by lite-psm call-sites that refer to
/// the OkuMoney price specifically.
pub const MAX_OKU_M_PRICE: u64 = MAX_MULTIPLIER;

/// Alias of `MAX_MULTIPLIER` used by oku-dollar call-sites that refer to
/// the USD multiplier specifically.
pub const MAX_USD_MULTIPLIER: u64 = MAX_MULTIPLIER;

// ---------------------------------------------------------------------------
// Oracle relay bounds (USDC peg circuit-breaker)
// ---------------------------------------------------------------------------

/// Lower bound on the configurable Pyth-oracle staleness threshold
/// (seconds). Below this, freshness is so tight that benign network jitter
/// will force every peg check to revert.
///
/// Mirrors EVM `Constants.ORACLE_MIN_STALENESS = 60`.
pub const ORACLE_MIN_STALENESS_SECS: i64 = 60;

/// Upper bound on the configurable Pyth-oracle staleness threshold
/// (seconds). Above this, the oracle is essentially always "fresh" and
/// provides no protection — caught at setter time to flag operator
/// misconfiguration.
///
/// Mirrors EVM `Constants.ORACLE_MAX_STALENESS = 7 days`.
pub const ORACLE_MAX_STALENESS_SECS: i64 = 7 * 24 * 60 * 60;

/// Hard floor for the USDC peg band enforced by `set_oracle_relay_band`.
/// `0.95e9` = $0.95 (1e9 precision). Configuring a band below this would
/// silently accept catastrophic depeg events. Defense-in-depth bound on
/// operator setters; mirrors EVM `Constants.ORACLE_USDC_PRICE_FLOOR = 0.95e18`
/// scaled to 1e9.
pub const ORACLE_USDC_PRICE_FLOOR: u64 = 950_000_000;

/// Hard ceiling for the USDC peg band enforced by `set_oracle_relay_band`.
/// `1.05e9` = $1.05 (1e9 precision). Symmetric to `ORACLE_USDC_PRICE_FLOOR`;
/// USDC trading above this band is almost certainly an oracle malfunction
/// rather than a legitimate market price; reject either way. Mirrors EVM
/// `Constants.ORACLE_USDC_PRICE_CEILING = 1.05e18` scaled to 1e9.
pub const ORACLE_USDC_PRICE_CEILING: u64 = 1_050_000_000;

/// Maximum absolute magnitude of the Pyth aggregator `expo` field accepted
/// by the relay. Pyth feeds publish `(price: i64, expo: i32)` where the
/// real value is `price * 10^expo`. USDC/USD feeds use `expo` around `-8`;
/// the relay normalizes that to 1e9 precision. Anything with `|expo| > 18`
/// would force pathological scaling math and is rejected at admin time.
///
/// EVM analogue: `MAX_FEED_DECIMALS = 18` (Chainlink reports `decimals()`
/// rather than a signed exponent; conceptually identical clamp).
pub const MAX_FEED_EXPO_MAGNITUDE: u32 = 18;

// ---------------------------------------------------------------------------
// Token decimals
// ---------------------------------------------------------------------------

/// Both OkuMoney and OkuDollar use 6 decimals on SVM (matching USDC's
/// representation on Solana). EVM uses 18 decimals; the off-chain
/// orchestrator handles the cross-chain scale conversion in v1.
///
/// Asserted at `lite-psm::initialize` for the USDC mint via the
/// `usdc_mint.decimals == 6` constraint.
pub const TOKEN_DECIMALS: u8 = 6;
