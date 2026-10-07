//! Protocol-wide numeric constants. Each must match `EVM/src/lib/Constants.sol`
//! (enforced by `evm_parity_constants`) or be a documented divergence.
//! Multiplier-bearing values are `u128` at 1e18 and route through
//! [`crate::wad`]; token amounts are `u64`.

/// Fixed-point scale for multipliers and per-second rates (1e18 = 1.0).
/// Must equal EVM `Constants.PRECISION` for cross-chain multiplier agreement.
pub const PRECISION: u128 = 1_000_000_000_000_000_000;

/// Maximum per-second rate (`PRECISION + 1e11`, about 2242 % APY). A sanity
/// bound on `rpow` inputs, not an economic limit; it does not by itself stop
/// `rpow` failing (at `MAX_RATE` a quotient exceeds `u128` after about
/// 472,763,099 s), which is what [`MAX_RATE_WINDOW_SECONDS`] guards.
/// EVM: `Constants.MAX_RATE`.
pub const MAX_RATE: u128 = PRECISION + 100_000_000_000;

/// Maximum length of one rate window: 90 days. About 60x margin below the
/// `rpow` failure point above; past it every schedule write (including the
/// emergency override) would fail because each re-anchors via the multiplier.
/// EVM: `Constants.MAX_RATE_WINDOW`; the stacks must agree.
pub const MAX_RATE_WINDOW_SECONDS: i64 = 90 * 24 * 60 * 60;

/// Maximum OkuM multiplier (`1e24` = $1,000,000 per whole token).
/// `compound_for` clamps at it; the explicit override rejects above it.
/// EVM: `Constants.MAX_MULTIPLIER`.
pub const MAX_MULTIPLIER: u128 = 1_000_000_000_000_000_000_000_000;

/// OkuM token decimals on SVM (EVM uses 18; the orchestrator rescales).
/// Unrelated to [`PRECISION`], which scales multipliers.
pub const TOKEN_DECIMALS: u8 = 6;

/// USDC decimals on SVM. Tied to [`TOKEN_DECIMALS`] so the two cannot drift.
pub const USDC_DECIMALS: u8 = TOKEN_DECIMALS;

#[cfg(test)]
mod tests {
    use super::*;

    /// Compares against the values declared in `EVM/src/lib/Constants.sol`.
    /// Fails (not skips) if the file cannot be found.
    #[test]
    fn evm_parity_constants() {
        use std::path::PathBuf;

        let sol_path: PathBuf =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../../EVM/src/lib/Constants.sol");
        let src = std::fs::read_to_string(&sol_path).unwrap_or_else(|e| {
            panic!(
                "cannot read EVM constants at {}: {e}; repoint this test if the layout moved",
                sol_path.display()
            )
        });

        /// Pull `<name> = <expr>;` out of a `uint256 public constant` line.
        fn decl<'a>(src: &'a str, name: &str) -> &'a str {
            let needle = format!("constant {name} = ");
            let start = src
                .find(&needle)
                .unwrap_or_else(|| panic!("EVM Constants.sol no longer declares {name}"))
                + needle.len();
            let end = start
                + src[start..]
                    .find(';')
                    .unwrap_or_else(|| panic!("unterminated declaration for {name}"));
            src[start..end].trim()
        }

        assert_eq!(decl(&src, "PRECISION"), "1e18", "EVM Constants.PRECISION");
        assert_eq!(PRECISION, 10u128.pow(18));

        assert_eq!(
            decl(&src, "MAX_RATE"),
            "PRECISION + 1e11",
            "EVM Constants.MAX_RATE"
        );
        assert_eq!(MAX_RATE, PRECISION + 10u128.pow(11));

        assert_eq!(
            decl(&src, "MAX_MULTIPLIER"),
            "1e24",
            "EVM Constants.MAX_MULTIPLIER"
        );
        assert_eq!(MAX_MULTIPLIER, 10u128.pow(24));

        assert_eq!(
            decl(&src, "MAX_RATE_WINDOW"),
            "90 days",
            "EVM Constants.MAX_RATE_WINDOW"
        );
        assert_eq!(MAX_RATE_WINDOW_SECONDS, 90 * 24 * 60 * 60);
    }

    /// The window bound sits well inside `compound_for`'s real failure point.
    #[test]
    fn max_rate_window_leaves_large_margin_below_rpow_failure() {
        use crate::rate::compound_for;

        let fifty_windows = (MAX_RATE_WINDOW_SECONDS * 50) as u64;
        assert!(
            compound_for(PRECISION, MAX_RATE, fifty_windows).is_some(),
            "compound_for failed at 50x the window bound ({fifty_windows}s) — \
             the margin this constant relies on has eroded"
        );

        assert!(
            compound_for(PRECISION, MAX_RATE, (MAX_RATE_WINDOW_SECONDS * 55) as u64).is_some(),
            "margin is thinner than 55 windows"
        );
        // A whole number of plausible epochs fits in one window.
        for epoch_secs in [60 * 60, 6 * 60 * 60, 12 * 60 * 60, 24 * 60 * 60] {
            assert_eq!(
                MAX_RATE_WINDOW_SECONDS % epoch_secs,
                0,
                "window does not divide evenly by a {}s epoch",
                epoch_secs
            );
        }
    }

    /// Why 1e18: at 1e9 one rate ulp is a >3% APY step; at 1e18 it is negligible.
    #[test]
    fn one_ulp_of_rate_is_economically_meaningful() {
        let ulp_1e9 = (1.0_f64 + 1e-9_f64).powi(31_536_000) - 1.0;
        let ulp_1e18 = (1.0_f64 + 1e-18_f64).powi(31_536_000) - 1.0;
        assert!(ulp_1e9 > 0.03, "1e9 ulp should be >3% APY, got {ulp_1e9}");
        assert!(
            ulp_1e18 < 1e-9,
            "1e18 ulp should be negligible, got {ulp_1e18}"
        );
    }
}
