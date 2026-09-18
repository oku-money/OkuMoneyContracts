//! Protocol-wide numeric constants.
//!
//! Anything declared here MUST also appear in `EVM/src/lib/Constants.sol`
//! (or be a documented divergence in `SVM/README.md` § "EVM vs SVM —
//! divergence catalogue").
//!
//! ## Why 1e18 (and why it used to be 1e9)
//!
//! This crate previously used `PRECISION = 1e9` on the grounds that it
//! kept the canonical `u64 × u64 / divisor → u64` pattern safe. That was
//! sound for a *static* multiplier that an operator bumped in discrete
//! ticks, but it is fatal for the streaming per-second rate schedule this
//! crate now implements:
//!
//! ```text
//!   one ulp of a per-second rate at 1e9  = 3.20385 % APY
//!   one ulp of a per-second rate at 1e18 = 0.00000000315 % APY
//! ```
//!
//! At 1e9 the *smallest expressible* non-zero yield rate is over 3% APY.
//! The rate schedule is simply inexpressible at that scale, so `PRECISION`
//! is now 1e18 — identical to EVM, which additionally buys bit-for-bit
//! cross-chain multiplier agreement (see `rate::compute_multiplier`).
//!
//! The consequence is that every multiplier-bearing value is now `u128`
//! rather than `u64`, and all multiplier math routes through [`crate::wad`],
//! which carries a full 256-bit intermediate. Token *amounts* remain `u64`
//! (SPL Token-2022 has no wider representation).

// ---------------------------------------------------------------------------
// Precision / basis points
// ---------------------------------------------------------------------------

/// Fixed-point scale for multipliers and per-second rates (1e18 = 1.0).
///
/// Byte-identical to EVM `Constants.PRECISION`. This equality is what makes
/// a schedule broadcast to every chain produce the same multiplier at the
/// same wall-clock second with no cross-chain messaging.
///
/// EVM mirror: `EVM/src/lib/Constants.sol:37`.
pub const PRECISION: u128 = 1_000_000_000_000_000_000;

/// Maximum per-second rate the schedule will accept (`PRECISION + 1e11`,
/// ≈ 2242 % APY).
///
/// This is a sanity bound on `rpow` inputs, not an economic policy limit.
/// Note it does NOT by itself prevent `rpow` from overflowing — at
/// `MAX_RATE` the intermediate blows past 256 bits somewhere around the
/// 30-year mark. The bounded rate window is what keeps the reachable
/// domain small; see `rate::rpow`.
///
/// EVM mirror: `EVM/src/lib/Constants.sol:45`.
pub const MAX_RATE: u128 = PRECISION + 100_000_000_000;

/// Maximum length of a single rate window, in seconds. **90 days.**
///
/// The comment on `MAX_RATE` above says the bounded rate window "is what keeps
/// the reachable domain small" — but nothing actually enforced a bound;
/// `validate_rate_window` only checked `end_timestamp > now_ts`. This makes
/// that documented invariant real.
///
/// `compound_for` clamps its OUTPUT to `MAX_MULTIPLIER`, which cannot prevent
/// `rpow` failing internally on a huge `elapsed`. Measured empirically against
/// this crate, `compound_for` first returns `None` at `MAX_RATE` after
/// ~472,763,099 s (~15 years). Once that happens there is no recovery: every
/// instruction that could rewrite the schedule re-anchors through
/// `multiplier::at` and so fails too, including the `set_okum_multiplier`
/// emergency override. 90 days keeps ~60x margin while comfortably exceeding
/// the 30-day production epoch.
///
/// EVM mirror: `Constants.MAX_RATE_WINDOW` in `EVM/src/lib/Constants.sol`.
/// These MUST agree or the two stacks accept different schedules.
pub const MAX_RATE_WINDOW_SECONDS: i64 = 90 * 24 * 60 * 60;

/// Basis-points denominator (10_000 = 100%). Mirrors EVM
/// `Constants.BASIS_POINTS`.
///
/// Retained for EVM constant parity. The SVM PSM is currently fee-free,
/// so no on-chain instruction consumes this value; it is kept so the
/// SVM ↔ EVM constant set stays 1:1 and so a future fee path (should one
/// be added) has the denominator already defined and audited.
pub const BASIS_POINTS: u64 = 10_000;

// ---------------------------------------------------------------------------
// Multiplier ceiling
// ---------------------------------------------------------------------------

/// Absolute maximum allowed value for the OkuM multiplier
/// (`1e24` = $1,000,000.00 per whole token).
///
/// `compound_for` CLAMPS at this value rather than erroring, matching EVM.
/// The explicit-override path (`set_okum_multiplier`) REJECTS above it.
///
/// EVM mirror: `EVM/src/lib/Constants.sol:58`.
pub const MAX_MULTIPLIER: u128 = 1_000_000_000_000_000_000_000_000;

// ---------------------------------------------------------------------------
// Token decimals
// ---------------------------------------------------------------------------

/// OkuM uses 6 decimals on SVM (matching USDC's representation on
/// Solana). EVM uses 18 decimals; the off-chain orchestrator handles
/// the cross-chain scale conversion.
///
/// Note this is the *token amount* scale and is unrelated to [`PRECISION`],
/// which is the *multiplier* scale. They were both 1e9-adjacent before the
/// streaming refactor, which made them easy to confuse; they are now
/// unambiguously distinct.
pub const TOKEN_DECIMALS: u8 = 6;

#[cfg(test)]
mod tests {
    use super::*;

    /// The constants that MUST equal their EVM counterparts exactly.
    /// If one of these fails, cross-chain multiplier agreement is broken.
    #[test]
    fn evm_parity_constants() {
        assert_eq!(PRECISION, 10u128.pow(18), "EVM Constants.sol:37");
        assert_eq!(
            MAX_RATE,
            10u128.pow(18) + 10u128.pow(11),
            "EVM Constants.sol:45"
        );
        assert_eq!(MAX_MULTIPLIER, 10u128.pow(24), "EVM Constants.sol:58");
        // Not a multiplier-math constant, but a divergence here means the two
        // stacks ACCEPT DIFFERENT SCHEDULES — one chain would take a window the
        // other rejects, which is the same class of cross-chain inconsistency.
        assert_eq!(
            MAX_RATE_WINDOW_SECONDS,
            90 * 24 * 60 * 60,
            "EVM Constants.MAX_RATE_WINDOW (90 days)"
        );
    }

    /// The window bound must sit far enough inside `compound_for`'s actual
    /// failure point to be a meaningful safety margin rather than a
    /// coincidence. Measured empirically: at `MAX_RATE`, `compound_for` first
    /// returns `None` at ~472,763,099 s (~15 years).
    #[test]
    fn max_rate_window_leaves_large_margin_below_rpow_failure() {
        let measured_failure_secs: i64 = 472_763_099;
        let margin = measured_failure_secs / MAX_RATE_WINDOW_SECONDS;
        assert!(
            margin >= 50,
            "window bound leaves only {}x margin below the rpow failure point",
            margin
        );
        // And the bound must still comfortably exceed a production epoch.
        assert!(MAX_RATE_WINDOW_SECONDS >= 30 * 24 * 60 * 60);
    }

    /// Documents the reason PRECISION moved from 1e9 to 1e18: at 1e9 the
    /// smallest expressible per-second rate is a >3% APY step.
    #[test]
    fn one_ulp_of_rate_is_economically_meaningful() {
        // (1 + 1e-9)^31_536_000 - 1  ≈ 3.2 %   → unusable
        // (1 + 1e-18)^31_536_000 - 1 ≈ 3.2e-11 → fine
        let ulp_1e9 = (1.0_f64 + 1e-9_f64).powi(31_536_000) - 1.0;
        let ulp_1e18 = (1.0_f64 + 1e-18_f64).powi(31_536_000) - 1.0;
        assert!(ulp_1e9 > 0.03, "1e9 ulp should be >3% APY, got {ulp_1e9}");
        assert!(
            ulp_1e18 < 1e-9,
            "1e18 ulp should be negligible, got {ulp_1e18}"
        );
    }
}
