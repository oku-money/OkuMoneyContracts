// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title Constants
 * @notice Shared constants for all OkuMoney contracts
 *
 * ============ TERMINOLOGY LEGEND ============
 *
 * MULTIPLIERS (Dollar Value Per Token):
 *   - okuMMultiplier: Dollar value of 1 OkuMoney token (starts at 1e18 = $1.00, grows with yield)
 *   - usdMultiplier:  Dollar value of 1 OkuDollar share (starts at 1e18 = $1.00, grows with yield)
 *
 * TOKEN AMOUNTS:
 *   - okuMAmount:   Raw OkuMoney token count (18 decimals, non-rebasing)
 *   - usdAmount:    OkuDollar amount in dollar terms (18 decimals, rebasing via usdMultiplier)
 *   - usdcAmount:   USDC amount (typically 6 decimals, but per-deployment via IERC20Metadata.decimals())
 *
 * INTERNAL ACCOUNTING:
 *   - shares:       Internal accounting units for rebasing tokens (OkuDollar uses usdShares)
 *   - dollars:      18-decimal dollar-denominated value (intermediate calculation unit)
 *
 * CONVERSION CONSTANTS:
 *   - PRECISION (1e18):                 Base unit for multiplier math (1e18 = $1.00)
 *   - DEFAULT_USDC_DECIMAL_MULTIPLIER:  10**(18 - 6) = 1e12. Default for Circle USDC (6 dec).
 *                                       LitePSM / RedemptionQueue compute the actual multiplier
 *                                       at init time from IERC20Metadata(usdc).decimals(); this
 *                                       constant is kept only for documentation and as the
 *                                       canonical default for chains running stock Circle USDC.
 *
 * KEY FORMULAS:
 *   USDC -> OkuMoney:  okuMAmount = (usdcAmount * decimalMultiplier) * PRECISION / okuMMultiplier
 *   OkuMoney -> USDC:  usdcAmount = (okuMAmount * okuMMultiplier / PRECISION) / decimalMultiplier
 *   OkuMoney -> OkuDollar shares: shares = okuMAmount * okuMMultiplier / usdMultiplier
 *   OkuDollar -> OkuMoney: okuMAmount = usdAmount * PRECISION / okuMMultiplier
 *
 * ============================================
 */
library Constants {
    /// @notice Standard precision for price and multiplier calculations (1e18 = $1.00)
    uint256 public constant PRECISION = 1e18;

    /// @notice Default decimal conversion multiplier for the canonical Circle USDC layout
    ///         (USDC 6 decimals -> OkuMoney 18 decimals).
    /// @dev Per-contract decimal multipliers are stored on LitePSM / RedemptionQueue at
    ///      init time via IERC20Metadata.decimals() so the protocol can run on chains
    ///      that ship a non-6-decimal USDC variant. This value remains the documented
    ///      default for Circle-issued USDC across major EVM chains.
    uint256 public constant DEFAULT_USDC_DECIMAL_MULTIPLIER = 1e12;

    /// @notice Maximum yield rate: ~3700% APY safety cap (well beyond any T-Bill rate)
    uint256 public constant MAX_RATE = PRECISION + 1e11;

    /// @notice Basis points denominator (10000 = 100%)
    uint256 public constant BASIS_POINTS = 10_000;

    // ============ Vault / Collateralization ============

    /// @notice Hard floor for OkuDollar minimum collateral ratio (90% of PRECISION).
    /// @dev Mirrors the SVM-side floor so cross-chain accounting stays consistent.
    uint256 public constant MIN_COLLATERAL_RATIO_FLOOR = 9e17;

    // ============ Oracle Bounds ============

    /// @notice Minimum allowed staleness threshold for the LitePSM PoR oracle (seconds).
    /// @dev 60s is below any realistic Chainlink update interval. Configuring a value
    ///      lower than this would cause every oracle read to revert.
    uint256 public constant ORACLE_MIN_STALENESS = 60;

    /// @notice Maximum allowed staleness threshold for the LitePSM PoR oracle (seconds).
    /// @dev 7 days catches operator misconfiguration where the oracle would effectively
    ///      never be considered stale.
    uint256 public constant ORACLE_MAX_STALENESS = 7 days;

    /// @notice Maximum supported USDC decimal count.
    /// @dev USDC implementations on EVM chains use 6 decimals; allowing up to 18 keeps
    ///      the protocol forward-compatible with non-Circle stablecoin variants while
    ///      preventing misconfiguration with absurd values.
    uint8 public constant MAX_USDC_DECIMALS = 18;
}
