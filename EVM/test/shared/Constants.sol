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

    /// @notice Decimal conversion multiplier for Circle-style USDC (6 decimals -> 18).
    /// @dev The PSM / Queue resolve their own multipliers at init time from
    ///      `IERC20Metadata.decimals()`. Tests pin to 1e12 because MockUSDC reports 6 decimals.
    uint256 public constant DECIMAL_MULTIPLIER = 1e12;

    /// @notice Maximum yield rate: ~3700% APY safety cap
    uint256 public constant MAX_RATE = SrcConstants.MAX_RATE;

    /// @notice Basis points denominator (10000 = 100%)
    uint256 public constant BASIS_POINTS = SrcConstants.BASIS_POINTS;

    /// @notice Minimum allowed PoR oracle staleness (re-exported for tests)
    uint256 public constant ORACLE_MIN_STALENESS = SrcConstants.ORACLE_MIN_STALENESS;

    /// @notice Maximum allowed PoR oracle staleness (re-exported for tests)
    uint256 public constant ORACLE_MAX_STALENESS = SrcConstants.ORACLE_MAX_STALENESS;

    /// @notice OkuDollar minimum collateral ratio floor (re-exported for tests)
    uint256 public constant MIN_COLLATERAL_RATIO_FLOOR = SrcConstants.MIN_COLLATERAL_RATIO_FLOOR;

    // ============ Test-Only Constants ============

    /// @notice Default max supply for test deployments (1 billion tokens)
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;

    /// @notice Default min collateral ratio for OkuDollar vault (95%)
    uint256 public constant MIN_COLLATERAL_RATIO = 95e16;

    /// @notice Default PSM oracle staleness threshold for tests (1 hour)
    uint256 public constant DEFAULT_STALENESS_THRESHOLD = 1 hours;

    // ============ Fuzz Bounds ============

    /// @notice Maximum multiplier increase per fuzz step (2x current, was 10x)
    uint256 public constant MAX_MULTIPLIER_FACTOR = 2;

    /// @notice Maximum price cap for fuzz testing (5x precision, was 1e24)
    uint256 public constant MAX_FUZZ_PRICE = PRECISION * 5;

    /// @notice Minimum fuzz amount for token operations
    uint256 public constant MIN_FUZZ_AMOUNT = 1e18;

    /// @notice Maximum fuzz amount for token operations
    uint256 public constant MAX_FUZZ_AMOUNT = 100_000_000e18;

    // ============ Token Names / Symbols ============

    string public constant OKUMONEY_NAME = "OkuMoney";
    string public constant OKUMONEY_SYMBOL = "OkuM";
    string public constant OKUDOLLAR_NAME = "OkuDollar";
    string public constant OKUDOLLAR_SYMBOL = "usdOku";

    // ============ Default PSM Configuration ============

    /// @notice Default USDC buffer seeded into LitePSM during setup (5,000 USDC, 6 decimals).
    uint256 public constant DEFAULT_PSM_BUFFER = 5000e6;
}
