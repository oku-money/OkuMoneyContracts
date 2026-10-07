// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Constants
 * @notice Shared constants for all OkuMoney contracts.
 *
 * TERMINOLOGY:
 *   OkuMoney / OkuM    - non-rebasing base token (contract / ticker)
 *   OkuDollar / UsdOku - rebasing $1-pegged stablecoin (contract / ticker)
 *   okuMMultiplier     - dollar value of 1 OkuM, 1e18 = $1.00, grows with yield
 *   usdMultiplier      - dollar value of 1 UsdOku share, 1e18 = $1.00, grows with yield
 *   okuMAmount         - raw OkuM token count, 18 decimals, non-rebasing
 *   usdAmount          - UsdOku in dollar terms, 18 decimals
 *   usdcAmount         - USDC in its native decimals (per-deployment, via decimals())
 *   shares / usdShares - internal accounting unit of the rebasing OkuDollar
 *   dollars            - 18-decimal dollar-denominated value
 *
 * FORMULAS:
 *   USDC   -> OkuM    okuMAmount = (usdcAmount * decimalMultiplier) * PRECISION / okuMMultiplier
 *   OkuM   -> USDC    usdcAmount = (okuMAmount * okuMMultiplier / PRECISION) / decimalMultiplier
 *   OkuM   -> shares  shares     = okuMAmount * okuMMultiplier / usdMultiplier
 *   UsdOku -> OkuM    okuMAmount = usdAmount * PRECISION / okuMMultiplier
 */
library Constants {
    /// @notice Standard precision for price and multiplier calculations (1e18 = $1.00)
    uint256 public constant PRECISION = 1e18;

    /// @notice Maximum yield rate: PRECISION + 1e11 ≈ 2242% APY.
    /// @dev Caps the PER-SECOND rate fed to {MathLib.rpow}, not the cumulative multiplier
    ///      (see {MAX_MULTIPLIER}).
    uint256 public constant MAX_RATE = PRECISION + 1e11;

    /// @notice Maximum length of a single rate window: 90 days.
    /// @dev `rpow` overflows at ~15y at MAX_RATE, and a reverting multiplier bricks every
    ///      recovery path (all of them re-anchor off it). Mirrors SVM `MAX_RATE_WINDOW_SECONDS`.
    uint256 public constant MAX_RATE_WINDOW = 90 days;

    /// @notice Absolute ceiling for `okuMMultiplier` / `usdMultiplier`: 1e24 = $1,000,000.
    /// @dev A math sanity bound keeping downstream `uint256` products away from overflow;
    ///      mirrors oku-shared `MAX_MULTIPLIER` on SVM.
    uint256 public constant MAX_MULTIPLIER = 1e24;

    /// @notice Decimal count of OkuM itself; the exponent base for PSM USDC conversion.
    /// @dev Distinct from {MAX_USDC_DECIMALS}, which bounds the collateral token.
    uint8 public constant OKU_M_DECIMALS = 18;

    /// @notice Maximum supported USDC decimal count (must not exceed {OKU_M_DECIMALS}).
    uint8 public constant MAX_USDC_DECIMALS = 18;
}
