// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Constants as SrcConstants} from "../../src/lib/Constants.sol";

/**
 * @title TestConstants
 * @notice Re-exports source constants + test-only constants
 * @dev Single source of truth for all numeric constants used in tests.
 *      Import from here instead of duplicating values.
 */
library TestConstants {
    // ============ Re-exported from src/lib/Constants.sol ============

    /// @notice Standard precision for price and multiplier calculations (1e18 = $1.00)
    uint256 public constant PRECISION = SrcConstants.PRECISION;

    /// @notice Decimal conversion multiplier (USDC 6 decimals -> OkuMoney 18 decimals)
    uint256 public constant DECIMAL_MULTIPLIER = SrcConstants.DECIMAL_MULTIPLIER;

    /// @notice Maximum yield rate: ~3700% APY safety cap
    uint256 public constant MAX_RATE = SrcConstants.MAX_RATE;

    /// @notice Basis points denominator (10000 = 100%)
    uint256 public constant BASIS_POINTS = SrcConstants.BASIS_POINTS;

    // ============ Test-Only Constants ============

    /// @notice Default max supply for test deployments (1 billion tokens)
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;

    /// @notice Default min collateral ratio for OkuDollar vault (95%)
    uint256 public constant MIN_COLLATERAL_RATIO = 95e16;

    /// @notice Default bridge fee in basis points (0.1% = 10 bps)
    uint256 public constant DEFAULT_BRIDGE_FEE = 10;

    /// @notice Default bridge deadline (1 hour)
    uint256 public constant DEFAULT_BRIDGE_DEADLINE = 1 hours;

    /// @notice Default min bridge amount
    uint256 public constant DEFAULT_MIN_BRIDGE_AMOUNT = 1e18;

    /// @notice Default max bridge amount
    uint256 public constant DEFAULT_MAX_BRIDGE_AMOUNT = 10_000_000e18;

    // ============ Chain IDs for Testing ============

    uint256 public constant OPTIMISM_CHAIN_ID = 10;
    uint256 public constant ARBITRUM_CHAIN_ID = 42_161;
    uint256 public constant BASE_CHAIN_ID = 8453;
    uint256 public constant POLYGON_CHAIN_ID = 137;

    /// @notice Solana mainnet chain ID (Wormhole format)
    uint256 public constant SOLANA_MAINNET_CHAIN_ID = 1_399_811_149;

    /// @notice Solana devnet chain ID (Wormhole format)
    uint256 public constant SOLANA_DEVNET_CHAIN_ID = 1_399_811_150;

    /// @notice Unsupported chain for negative tests
    uint256 public constant UNSUPPORTED_CHAIN_ID = 999;

    // ============ Fuzz Bounds ============

    /// @notice Maximum multiplier increase per fuzz step (2x current, was 10x)
    uint256 public constant MAX_MULTIPLIER_FACTOR = 2;

    /// @notice Maximum price cap for fuzz testing (5x precision, was 1e24)
    uint256 public constant MAX_FUZZ_PRICE = PRECISION * 5;

    /// @notice Minimum fuzz amount for token operations
    uint256 public constant MIN_FUZZ_AMOUNT = 1e18;

    /// @notice Maximum fuzz amount for token operations
    uint256 public constant MAX_FUZZ_AMOUNT = 100_000_000e18;
}
