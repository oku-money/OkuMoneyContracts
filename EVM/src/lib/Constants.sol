// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Constants
 * @notice Shared constants for all OkuMoney contracts.
 *
 * ============ TERMINOLOGY LEGEND ============
 *
 * NAMING:
 *   - OkuMoney  / OkuM   : Non-rebasing base token (program/contract name + ticker)
 *   - OkuDollar / UsdOku : Rebasing $1-pegged stablecoin (program/contract name + ticker)
 *
 * MULTIPLIERS (Dollar Value Per Token):
 *   - okuMMultiplier: Dollar value of 1 OkuM (starts at 1e18 = $1.00, grows with yield)
 *   - usdMultiplier:  Dollar value of 1 UsdOku share (starts at 1e18 = $1.00, grows with yield)
 *
 * TOKEN AMOUNTS:
 *   - okuMAmount: Raw OkuM token count (18 decimals, non-rebasing)
 *   - usdAmount:  UsdOku amount in dollar terms (18 decimals, rebasing via usdMultiplier)
 *   - usdcAmount: USDC amount in its native decimals (per-deployment via IERC20Metadata.decimals())
 *
 * INTERNAL ACCOUNTING:
 *   - shares:  Internal accounting units for the rebasing OkuDollar (usdShares)
 *   - dollars: 18-decimal dollar-denominated value (intermediate calculation unit)
 *
 * KEY FORMULAS:
 *   USDC -> OkuM:           okuMAmount = (usdcAmount * decimalMultiplier) * PRECISION / okuMMultiplier
 *   OkuM -> USDC:           usdcAmount = (okuMAmount * okuMMultiplier / PRECISION) / decimalMultiplier
 *   OkuM -> UsdOku shares:  shares     = okuMAmount * okuMMultiplier / usdMultiplier
 *   UsdOku -> OkuM:         okuMAmount = usdAmount * PRECISION / okuMMultiplier
 *
 * ============================================
 */
library Constants {
    /// @notice Standard precision for price and multiplier calculations (1e18 = $1.00)
    uint256 public constant PRECISION = 1e18;

    /// @notice Maximum yield rate: PRECISION + 1e11 ≈ 2242% APY safety cap.
    /// @dev Far above any plausible T-Bill rate; bounds the per-second compounding
    ///      input to {MathLib.rpow} away from overflow regions. NOTE: this caps
    ///      the *per-second compounding rate*, NOT the cumulative multiplier
    ///      value reached after many seconds of compounding — use
    ///      `MAX_MULTIPLIER` for that.
    uint256 public constant MAX_RATE = PRECISION + 1e11;

    /// @notice Absolute ceiling for any cumulative multiplier (OkuMoney's
    ///         `okuMMultiplier` and OkuDollar's `usdMultiplier`).
    /// @dev `1e24` = $1,000,000 of dollar value per token (since
    ///      `PRECISION = 1e18` represents $1.00). Far above any realistic
    ///      yield trajectory and keeps downstream `uint256 * uint256`
    ///      multiplications away from the overflow region. Mirrors the SVM
    ///      `MAX_MULTIPLIER` guard (`oku-shared::constants::MAX_MULTIPLIER`,
    ///      scaled for SVM's 1e9 precision) — math sanity bound that bounds
    ///      the rpow / mulDiv input space, not a constraint on the trusted
    ///      operator. Note SVM's `lite-psm` has no separate OkuDollar-equivalent
    ///      vault program, so this constant governs only the OkuM-side price cap.
    uint256 public constant MAX_MULTIPLIER = 1e24;

    /// @notice Basis points denominator (10000 = 100%)
    uint256 public constant BASIS_POINTS = 10_000;

    // REMOVED (single-multiplier refactor): MIN_COLLATERAL_RATIO_FLOOR —
    // collateralization is exactly 1.0 by construction, so there is no
    // minCollateralRatio to floor.

    /// @notice Maximum supported USDC decimal count.
    /// @dev USDC implementations on EVM chains use 6 decimals; allowing up to 18 keeps
    ///      the protocol forward-compatible with non-Circle stablecoin variants while
    ///      preventing misconfiguration with absurd values.
    uint8 public constant MAX_USDC_DECIMALS = 18;
}
