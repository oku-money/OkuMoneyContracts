// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title Constants
 * @notice Shared constants for all OkuMoney contracts
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
