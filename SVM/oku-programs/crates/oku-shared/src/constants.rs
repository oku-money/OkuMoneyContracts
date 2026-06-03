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
/// Defence-in-depth against a compromised `rebaser` / `usd_rebaser` key:
/// even with the key, the multiplier cannot be pushed beyond this value,
/// so the protocol cannot be bricked by a single rogue tx.
///
/// EVM enforces this implicitly via the math-overflow cap on
/// `Constants.MAX_RATE`; SVM makes it an explicit per-set check.
pub const MAX_MULTIPLIER: u64 = 1_000_000_000_000_000;

/// Alias of `MAX_MULTIPLIER` used by lite-psm call-sites that refer to
/// the OkuMoney price specifically.
pub const MAX_OKU_M_PRICE: u64 = MAX_MULTIPLIER;

/// Alias of `MAX_MULTIPLIER` used by oku-dollar call-sites that refer to
/// the USD multiplier specifically.
pub const MAX_USD_MULTIPLIER: u64 = MAX_MULTIPLIER;

// ---------------------------------------------------------------------------
// Oracle bounds
// ---------------------------------------------------------------------------

/// Lower bound on the configurable Pyth-oracle staleness threshold
/// (seconds). Below this, freshness is so tight that benign network jitter
/// will force `mint_oku_m` to fall through into a hard-fail oracle path.
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
