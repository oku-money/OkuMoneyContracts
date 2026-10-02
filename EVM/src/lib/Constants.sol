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

    /// @notice Maximum yield rate: PRECISION + 1e11 ≈ 2242% APY safety cap.
    /// @dev Bounds the per-second compounding input to {MathLib.rpow} away from the
    ///      overflow region. Caps the PER-SECOND rate, NOT the cumulative multiplier
    ///      reached after many seconds of compounding — use {MAX_MULTIPLIER} for that.
    uint256 public constant MAX_RATE = PRECISION + 1e11;

    /// @notice Maximum length of a single rate window: 90 days.
    /// @dev {MathLib.compoundFor} clamps its OUTPUT to `MAX_MULTIPLIER`, but that clamp
    ///      runs AFTER `rpow`, so it cannot stop `rpow` overflowing internally on a huge
    ///      `elapsed`. At `MAX_RATE`, `rpow` overflows at roughly 15 years (empirically
    ///      472,763,099 seconds). The consequence if it fired is unrecoverable without an
    ///      upgrade: once `okuMMultiplier()` reverts, EVERY recovery path reverts with it,
    ///      including `setOkuMYieldRate` and the `setOkuMMultiplier` emergency override,
    ///      because both read the current multiplier to re-anchor. 90 days keeps ~60x
    ///      margin against that bound while comfortably exceeding any plausible epoch
    ///      length, so a schedule never needs to span more than one window.
    ///
    ///      Must equal SVM's `MAX_RATE_WINDOW_SECONDS` in `oku-shared/src/constants.rs`
    ///      or the differential harness diverges.
    uint256 public constant MAX_RATE_WINDOW = 90 days;

    /// @notice Absolute ceiling for any cumulative multiplier (OkuMoney's
    ///         `okuMMultiplier` and OkuDollar's `usdMultiplier`).
    /// @dev `1e24` = $1,000,000 of dollar value per token (`PRECISION = 1e18` is $1.00).
    ///      A math sanity bound that keeps downstream `uint256 * uint256` multiplications
    ///      and the rpow / mulDiv input space away from overflow — not a constraint on the
    ///      trusted operator. Mirrors SVM's `oku-shared::constants::MAX_MULTIPLIER` (scaled
    ///      for SVM's 1e9 precision); SVM's `lite-psm` has no OkuDollar-equivalent vault
    ///      program, so there it governs only the OkuM-side price cap.
    uint256 public constant MAX_MULTIPLIER = 1e24;

    /// @notice Basis points denominator (10000 = 100%). Present for SVM constant
    ///         parity; unused by any contract in this repo.
    uint256 public constant BASIS_POINTS = 10_000;

    /// @notice Decimal count of OkuM itself.
    /// @dev Supplies the exponent in `10 ** (OKU_M_DECIMALS - usdcDecimals)` used by
    ///      LitePSM and RedemptionQueue to convert USDC amounts into OkuM units. Distinct
    ///      from {MAX_USDC_DECIMALS}, a tunable validation bound on the collateral token;
    ///      this is a property of OkuM and cannot change without re-denominating it.
    uint8 public constant OKU_M_DECIMALS = 18;

    /// @notice Maximum supported USDC decimal count.
    /// @dev USDC uses 6. Cannot exceed {OKU_M_DECIMALS} or the conversion exponent
    ///      underflows; allowing up to that bound supports other stablecoin variants.
    uint8 public constant MAX_USDC_DECIMALS = 18;
}
