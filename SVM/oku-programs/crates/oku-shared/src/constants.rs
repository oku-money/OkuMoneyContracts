//! Protocol-wide numeric constants.
//!
//! Anything declared here MUST also appear in `EVM/src/lib/Constants.sol`
//! (or be a documented divergence in `SVM/README.md` § "EVM vs SVM —
//! divergence catalogue").
//!
//! ## Why 1e9 on SVM vs 1e18 on EVM
//!
//! Cycle 4 (constants doc fix): the previous comment claimed SVM
//! used 1e9 "because SVM tokens are 6-decimal vs EVM's 18-decimal".
//! That doesn't actually follow — token decimals and multiplier
//! precision are independent. The real reason is structural:
//!
//!   * EVM has 256-bit native integers, so 1e18 fits comfortably and
//!     matches Solidity's ERC-20 18-decimal convention.
//!   * SVM uses `u64` for token amounts and BPF natively widens to
//!     `u128` for intermediates. `1e9 × u64` peaks around `1.8e28`,
//!     well within `u128::MAX (≈ 3.4e38)`. A 1e18 precision would
//!     require either `u128` token amounts (no SPL Token-2022 support)
//!     or aggressive precision loss on every operation.
//!
//! In other words: 1e9 is the largest decimal-power scale that keeps
//! the canonical `u64 × u64 / divisor → u64` math pattern safe for
//! all realistic supply / multiplier combinations. The decimal-count
//! coincidence (both EVM's MathLib and SVM's mul_div_floor use 9
//! decimal digits less than the token's stated precision) is just
//! that — a coincidence.

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
/// `SVM/README.md § Authority Model` and `contracts/TRACKER.md`).
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

// Cycle 4 (C-16): pin the alias relationship at compile time. If
// anyone bumps `MAX_OKU_M_PRICE` or `MAX_USD_MULTIPLIER` independently
// (e.g. as part of a future "vault and PSM can have different ceilings"
// refactor), this assertion fires and the workspace fails to compile.
// Cheap, structural, audit-friendly.
const _: () = {
    assert!(MAX_OKU_M_PRICE == MAX_MULTIPLIER);
    assert!(MAX_USD_MULTIPLIER == MAX_MULTIPLIER);
};

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
