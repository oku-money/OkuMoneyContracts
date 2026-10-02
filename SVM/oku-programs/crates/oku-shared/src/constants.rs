//! Protocol-wide numeric constants.
//!
//! Anything declared here MUST also appear in `EVM/src/lib/Constants.sol`
//! (or be a documented divergence in `SVM/README.md` § "EVM vs SVM —
//! divergence catalogue").
//!
//! Why 1e18: one ulp of a per-second rate is 3.20385 % APY at 1e9 but only
//! 0.00000000315 % APY at 1e18, so the streaming rate schedule is
//! inexpressible at 1e9. Every multiplier-bearing value is therefore `u128`
//! and routes through [`crate::wad`], which carries a full 256-bit
//! intermediate. Token *amounts* remain `u64` (SPL Token-2022 has no wider
//! representation).

// ---------------------------------------------------------------------------
// Precision / basis points
// ---------------------------------------------------------------------------

/// Fixed-point scale for multipliers and per-second rates (1e18 = 1.0).
///
/// Byte-identical to EVM `Constants.PRECISION` (`EVM/src/lib/Constants.sol`).
/// That equality is what makes a schedule broadcast to every chain produce the
/// same multiplier at the same wall-clock second with no cross-chain
/// messaging.
pub const PRECISION: u128 = 1_000_000_000_000_000_000;

/// Maximum per-second rate the schedule will accept (`PRECISION + 1e11`,
/// ≈ 2242 % APY).
///
/// This is a sanity bound on `rpow` inputs, not an economic policy limit.
/// Note it does NOT by itself prevent `rpow` from overflowing — at `MAX_RATE`
/// the intermediate blows past 256 bits after ~472,763,099 s (~15 years), see
/// [`MAX_RATE_WINDOW_SECONDS`]. The bounded rate window is what keeps the
/// reachable domain small; see `rate::rpow`.
///
/// EVM mirror: `EVM/src/lib/Constants.sol` `Constants.MAX_RATE`.
pub const MAX_RATE: u128 = PRECISION + 100_000_000_000;

/// Maximum length of a single rate window, in seconds. **90 days.**
///
/// `compound_for` clamps its OUTPUT to `MAX_MULTIPLIER`, which cannot prevent
/// `rpow` failing internally on a huge `elapsed`: measured against this crate,
/// `compound_for` first returns `None` at `MAX_RATE` after ~472,763,099 s
/// (~15 years). There is no recovery from that — every instruction that could
/// rewrite the schedule re-anchors through `multiplier::at` and so fails too,
/// including the `set_okum_multiplier` emergency override. 90 days keeps ~60x
/// margin against that bound while comfortably exceeding any plausible epoch
/// length, so a schedule never needs to span more than one window.
///
/// EVM mirror: `Constants.MAX_RATE_WINDOW`. These MUST agree or the two stacks
/// accept different schedules.
pub const MAX_RATE_WINDOW_SECONDS: i64 = 90 * 24 * 60 * 60;

/// Basis-points denominator (10_000 = 100%). Mirrors EVM
/// `Constants.BASIS_POINTS`.
///
/// The SVM PSM is fee-free, so no instruction consumes this; it is retained
/// so the SVM ↔ EVM constant set stays 1:1.
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
/// EVM mirror: `Constants.MAX_MULTIPLIER`.
pub const MAX_MULTIPLIER: u128 = 1_000_000_000_000_000_000_000_000;

// ---------------------------------------------------------------------------
// Token decimals
// ---------------------------------------------------------------------------

/// OkuM uses 6 decimals on SVM (matching USDC on Solana); EVM uses 18. The
/// off-chain orchestrator handles the cross-chain scale conversion.
///
/// Note this is the *token amount* scale and is unrelated to [`PRECISION`],
/// which is the *multiplier* scale.
pub const TOKEN_DECIMALS: u8 = 6;

#[cfg(test)]
mod tests {
    use super::*;

    /// The constants that MUST equal their EVM counterparts exactly.
    /// If one of these fails, cross-chain multiplier agreement is broken.
    #[test]
    fn evm_parity_constants() {
        assert_eq!(PRECISION, 10u128.pow(18), "EVM Constants.PRECISION");
        assert_eq!(
            MAX_RATE,
            10u128.pow(18) + 10u128.pow(11),
            "EVM Constants.MAX_RATE"
        );
        assert_eq!(
            MAX_MULTIPLIER,
            10u128.pow(24),
            "EVM Constants.MAX_MULTIPLIER"
        );
        // Not a multiplier-math constant, but a divergence here means the two
        // stacks ACCEPT DIFFERENT SCHEDULES — one chain would take a window the
        // other rejects, which is the same class of cross-chain inconsistency.
        assert_eq!(
            MAX_RATE_WINDOW_SECONDS,
            90 * 24 * 60 * 60,
            "EVM Constants.MAX_RATE_WINDOW (90 days)"
        );
    }

    /// The window bound must sit far enough inside `compound_for`'s measured
    /// failure point (~472,763,099 s at `MAX_RATE`) to be a real margin.
    #[test]
    fn max_rate_window_leaves_large_margin_below_rpow_failure() {
        let measured_failure_secs: i64 = 472_763_099;
        let margin = measured_failure_secs / MAX_RATE_WINDOW_SECONDS;
        assert!(
            margin >= 50,
            "window bound leaves only {}x margin below the rpow failure point",
            margin
        );
        // The window must divide evenly by any epoch length the orchestrator is
        // likely to run, so a whole number of epochs fits inside one window with
        // no remainder. Asserted over a range rather than against the current
        // epoch constant: pinning the exact quotient would couple this test to a
        // backend tunable it has no business naming.
        for epoch_secs in [60 * 60, 6 * 60 * 60, 12 * 60 * 60, 24 * 60 * 60] {
            assert_eq!(
                MAX_RATE_WINDOW_SECONDS % epoch_secs,
                0,
                "window does not divide evenly by a {}s epoch",
                epoch_secs
            );
        }
    }

    /// At 1e9 the smallest expressible per-second rate is a >3% APY step;
    /// at 1e18 it is negligible.
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
