// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Constants as SrcConstants} from "../../src/lib/Constants.sol";

/**
 * @title TestConstants
 * @notice Re-exports source constants plus test-only fixtures.
 * @dev Single source of truth for numeric constants in tests. Import from here
 *      rather than duplicating values.
 */
library TestConstants {
    // ============ Re-exported from src/lib/Constants.sol ============

    uint256 internal constant PRECISION = SrcConstants.PRECISION;
    uint256 internal constant BASIS_POINTS = SrcConstants.BASIS_POINTS;
    uint256 internal constant SECONDS_PER_YEAR = SrcConstants.SECONDS_PER_YEAR;
    uint256 internal constant MAX_IMPLIED_APR = SrcConstants.MAX_IMPLIED_APR;
    uint256 internal constant MAX_RATE_DURATION = SrcConstants.MAX_RATE_DURATION;
    uint256 internal constant MAX_MULTIPLIER = SrcConstants.MAX_MULTIPLIER;
    uint256 internal constant MAX_TOTAL_SUPPLY = SrcConstants.MAX_TOTAL_SUPPLY;

    /// @notice Decimal multiplier for Circle-style 6-decimal USDC.
    /// @dev The token resolves this at init from `IERC20Metadata.decimals()`; the
    ///      PSM and queue cross-assert against the token. Tests pin to 1e12
    ///      because `MockUSDC` reports 6 decimals.
    uint256 internal constant DECIMAL_MULTIPLIER = 1e12;

    // ============ Test-only ============

    /// @notice Default max supply for test deployments (1 billion tokens).
    uint256 internal constant MAX_SUPPLY = 1_000_000_000e18;

    // ============ Fuzz bounds ============

    uint256 internal constant MIN_FUZZ_AMOUNT = 1e18;
    uint256 internal constant MAX_FUZZ_AMOUNT = 100_000_000e18;
    /// @notice Upper bound for fuzzed multipliers. Well above any realistic
    ///         trajectory but far below `MAX_MULTIPLIER`, so `mulDiv` paths stay
    ///         in the reachable envelope.
    uint256 internal constant MAX_FUZZ_MULTIPLIER = PRECISION * 1000;

    // ============ Token identity ============

    string internal constant TOKEN_NAME = "Oku Dollar";
    string internal constant TOKEN_SYMBOL = "rUSDOku";

    // ============ PSM ============

    /// @notice Default USDC buffer seeded into LitePSM during setup (5,000 USDC).
    uint256 internal constant DEFAULT_PSM_BUFFER = 5000e6;
}
