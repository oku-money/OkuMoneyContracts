//! Protocol-wide numeric constants.
//!
//! Anything declared here MUST also appear in `EVM/src/lib/Constants.sol`
//! (or be a documented divergence in `SVM/README.md` § "EVM vs SVM —
//! divergence catalogue").
//!
//! ## Why 1e9 on SVM vs 1e18 on EVM
//!
//! EVM has 256-bit native integers, so 1e18 fits comfortably and matches
//! Solidity's ERC-20 18-decimal convention. SVM uses `u64` for token
//! amounts and BPF natively widens to `u128` for intermediates.
//! `1e9 × u64` peaks around `1.8e28`, well within `u128::MAX (≈ 3.4e38)`.
//! A 1e18 precision would require either `u128` token amounts (no SPL
//! Token-2022 support) or aggressive precision loss on every operation.
//!
//! In other words: 1e9 is the largest decimal-power scale that keeps
//! the canonical `u64 × u64 / divisor → u64` math pattern safe for
//! all realistic supply / multiplier combinations.

// ---------------------------------------------------------------------------
// Precision / basis points
// ---------------------------------------------------------------------------

/// Standard precision for multipliers (1e9 = $1.00).
///
/// SVM equivalent of EVM's `Constants.PRECISION = 1e18`. Used by the
/// OkuM multiplier and all dollar-conversion math in `lite-psm`.
pub const PRECISION: u64 = 1_000_000_000;

/// Basis-points denominator (10_000 = 100%). Mirrors EVM
/// `Constants.BASIS_POINTS`.
pub const BASIS_POINTS: u64 = 10_000;

// ---------------------------------------------------------------------------
// Multiplier ceiling
// ---------------------------------------------------------------------------

/// Absolute maximum allowed value for the OkuM multiplier.
///
/// Set to `1e15` (≈ $1,000,000.00 per raw token), which is far above any
/// realistic yield trajectory and keeps subsequent `u64 * u64 -> u128`
/// multiplications away from the overflow region.
///
/// EVM mirror: `Constants.MAX_MULTIPLIER = 1e24`.
pub const MAX_MULTIPLIER: u64 = 1_000_000_000_000_000;

// ---------------------------------------------------------------------------
// Token decimals
// ---------------------------------------------------------------------------

/// OkuM uses 6 decimals on SVM (matching USDC's representation on
/// Solana). EVM uses 18 decimals; the off-chain orchestrator handles
/// the cross-chain scale conversion.
pub const TOKEN_DECIMALS: u8 = 6;
