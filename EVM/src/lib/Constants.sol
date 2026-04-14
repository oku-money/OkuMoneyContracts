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
 *   - usdcAmount:   USDC amount (6 decimals)
 *
 * INTERNAL ACCOUNTING:
 *   - shares:       Internal accounting units for rebasing tokens (OkuDollar uses usdShares)
 *   - dollars:      18-decimal dollar-denominated value (intermediate calculation unit)
 *
 * CONVERSION CONSTANTS:
 *   - PRECISION (1e18):          Base unit for multiplier math (1e18 = $1.00)
 *   - DECIMAL_MULTIPLIER (1e12): Converts USDC (6 dec) <-> dollars (18 dec)
 *
 * KEY FORMULAS:
 *   USDC -> OkuMoney:  okuMAmount = (usdcAmount * 1e12) * PRECISION / okuMMultiplier
 *   OkuMoney -> USDC:  usdcAmount = (okuMAmount * okuMMultiplier / PRECISION) / 1e12
 *   OkuMoney -> OkuDollar shares: shares = okuMAmount * okuMMultiplier / usdMultiplier
 *   OkuDollar -> OkuMoney: okuMAmount = usdAmount * PRECISION / okuMMultiplier
 *
 * ============================================
 */
library Constants {
    /// @notice Standard precision for price and multiplier calculations (1e18 = $1.00)
    uint256 public constant PRECISION = 1e18;

    /// @notice Decimal conversion multiplier (USDC 6 decimals → OkuMoney 18 decimals)
    uint256 public constant DECIMAL_MULTIPLIER = 1e12;

    /// @notice Maximum yield rate: ~3700% APY safety cap (well beyond any T-Bill rate)
    uint256 public constant MAX_RATE = PRECISION + 1e11;

    /// @notice Basis points denominator (10000 = 100%)
    uint256 public constant BASIS_POINTS = 10_000;
}
