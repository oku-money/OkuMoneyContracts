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

    /// @notice Maximum yield rate: PRECISION + 1e11 ≈ 3700% APY safety cap.
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

    /// @notice Seconds in a 365-day year. Used to annualize an epoch's implied APR.
    uint256 public constant SECONDS_PER_YEAR = 365 days;

    // ============ OkuMoney Yield Epochs ============

    /// @notice Upper bound on the annualized yield rate a single OkuMoney epoch may imply.
    /// @dev `2000` bps = 20% APR, computed as
    ///      `(deltaMultiplier / startMultiplier) * (SECONDS_PER_YEAR / duration)`.
    ///
    ///      This is the primary on-chain defence against a mispriced or malicious
    ///      epoch. Because the multiplier is strictly monotonic, yield that has
    ///      ALREADY accrued cannot be clawed back — `cancelPendingEpoch` and
    ///      `haltAccrual` only stop future accrual. The cap therefore bounds the
    ///      damage a bad rate can do between publication and detection.
    ///
    ///      Sizing: 4x headroom over a ~5% T-Bill trajectory. Chosen so that a
    ///      catch-up distribution (e.g. two periods' realized yield streamed over
    ///      one period) still passes — at 5% APR that implies ~1000 bps, which a
    ///      tighter 1000 bps cap would reject on a knife edge. It simultaneously
    ///      rejects the degenerate "stream a month's yield over an hour" case,
    ///      which implies ~360000 bps and is arithmetically a discrete step —
    ///      precisely the shape continuous accrual exists to eliminate. A single
    ///      cap thus enforces both bounds without a separate minimum-duration rule.
    uint256 public constant MAX_IMPLIED_APR_BPS = 2000;

    /// @notice Shortest permitted epoch duration.
    /// @dev Defence-in-depth alongside `MAX_IMPLIED_APR_BPS`. A very short epoch
    ///      approximates an instantaneous step even when the implied APR is within
    ///      bounds (a tiny yield amount over one second passes the APR check but
    ///      still lands as a jump). One hour keeps the per-second rate meaningful
    ///      relative to block times on every supported chain.
    uint256 public constant MIN_EPOCH_DURATION = 1 hours;

    /// @notice Longest permitted epoch duration.
    /// @dev Bounds how far ahead the operator can commit yield, and keeps
    ///      `rate * duration` far inside the overflow-safe region. Yield is
    ///      rear-facing and realized off-chain, so committing beyond a year is
    ///      never operationally required.
    uint256 public constant MAX_EPOCH_DURATION = 365 days;

    // ============ ERC-8056 Interface IDs ============
    // Pinned literals from the published draft (created 2025-10-20):
    // https://eips.ethereum.org/EIPS/eip-8056
    // Asserted against `type(I...).interfaceId` in the test suite, so a spec
    // revision surfaces as a test failure rather than silent non-conformance.

    /// @notice ERC-165 ID of the core `IScaledUIAmount` interface.
    bytes4 public constant IID_SCALED_UI_AMOUNT = 0xa60bf13d;

    /// @notice ERC-165 ID of the required `IScaledUIAmountNewUIMultiplier` extension.
    bytes4 public constant IID_SCALED_UI_NEW_MULTIPLIER = 0x4bd27648;

    /// @notice ERC-165 ID of the optional `IScaledUIAmountConversion` extension.
    bytes4 public constant IID_SCALED_UI_CONVERSION = 0x57854fc3;

    /// @notice ERC-165 ID of the optional `IScaledUIAmountBalances` extension.
    bytes4 public constant IID_SCALED_UI_BALANCES = 0xd890fd71;

    // ============ Vault / Collateralization ============

    /// @notice Hard floor for OkuDollar minimum collateral ratio (90% of PRECISION).
    /// @dev Mirrors the SVM-side floor so cross-chain accounting stays consistent.
    uint256 public constant MIN_COLLATERAL_RATIO_FLOOR = 9e17;

    /// @notice Maximum supported USDC decimal count.
    /// @dev USDC implementations on EVM chains use 6 decimals; allowing up to 18 keeps
    ///      the protocol forward-compatible with non-Circle stablecoin variants while
    ///      preventing misconfiguration with absurd values.
    uint8 public constant MAX_USDC_DECIMALS = 18;
}
