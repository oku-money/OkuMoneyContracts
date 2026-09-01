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

    /// @notice OkuDollar minimum collateral ratio floor (re-exported for tests)
    uint256 public constant MIN_COLLATERAL_RATIO_FLOOR = SrcConstants.MIN_COLLATERAL_RATIO_FLOOR;

    /// @notice Absolute ceiling on any cumulative multiplier.
    uint256 public constant MAX_MULTIPLIER = SrcConstants.MAX_MULTIPLIER;

    // ============ Yield Epoch Bounds (re-exported) ============

    /// @notice Cap on a single epoch's annualized implied rate (2000 bps = 20% APR).
    uint256 public constant MAX_IMPLIED_APR_BPS = SrcConstants.MAX_IMPLIED_APR_BPS;

    /// @notice Shortest permitted epoch duration (1 hour).
    uint256 public constant MIN_EPOCH_DURATION = SrcConstants.MIN_EPOCH_DURATION;

    /// @notice Longest permitted epoch duration (365 days).
    uint256 public constant MAX_EPOCH_DURATION = SrcConstants.MAX_EPOCH_DURATION;

    /// @notice Seconds in a 365-day year (annualization basis).
    uint256 public constant SECONDS_PER_YEAR = SrcConstants.SECONDS_PER_YEAR;

    // ============ ERC-8056 Interface IDs (re-exported) ============

    bytes4 public constant IID_SCALED_UI_AMOUNT = SrcConstants.IID_SCALED_UI_AMOUNT;
    bytes4 public constant IID_SCALED_UI_NEW_MULTIPLIER = SrcConstants.IID_SCALED_UI_NEW_MULTIPLIER;
    bytes4 public constant IID_SCALED_UI_CONVERSION = SrcConstants.IID_SCALED_UI_CONVERSION;
    bytes4 public constant IID_SCALED_UI_BALANCES = SrcConstants.IID_SCALED_UI_BALANCES;

    // ============ Test-Only Constants ============

    /// @notice Default max supply for test deployments (1 billion tokens)
    uint256 public constant MAX_SUPPLY = 1_000_000_000e18;

    /// @notice Default min collateral ratio for OkuDollar vault (95%)
    uint256 public constant MIN_COLLATERAL_RATIO = 95e16;

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
