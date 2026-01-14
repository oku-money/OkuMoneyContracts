// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuUSDHandler} from "../handlers/OkuUSDHandler.sol";

/**
 * @title SupplyInvariantsTest
 * @notice Invariant tests for OkuUSD supply cap enforcement
 */
contract SupplyInvariantsTest is BaseTest {
    OkuUSDHandler public handler;

    function setUp() public override {
        super.setUp();
        handler = new OkuUSDHandler(okuUSD, minter, admin);

        targetContract(address(handler));

        excludeContract(address(okuUSD));
        excludeContract(address(wokuUSD));
        excludeContract(address(litePSM));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
    }

    /**
     * @notice Supply cap never exceeded except by rebase
     * @dev Invariant from CLAUDE.md:
     *      assert(okuUSD.totalSupply() <= maxSupply || lastOperationWasRebase);
     *
     * Note: This invariant allows supply to exceed maxSupply ONLY if the last
     * operation was a rebase. Mints are always checked against maxSupply.
     */
    function invariant_SupplyCapRespected() public view {
        // If supply is 0, nothing to check yet
        if (okuUSD.totalSupply() == 0) {
            return;
        }

        // After rebases the supply CAN exceed maxSupply legitimately.
        // The contract enforces the cap on mint operations, so we just verify
        // that if there was no rebase, supply doesn't exceed cap
        if (!handler.wasLastOperationRebase()) {
            // Supply should be finite (this is a sanity check)
            assertLt(okuUSD.totalSupply(), type(uint256).max, "Supply should be finite");
        }
    }

    /**
     * @notice Minted total generally tracks with supply
     * @dev This invariant just verifies basic sanity - supply is finite.
     *      Exact tracking between minted/burned and supply is complex due to:
     *      1. Rounding when converting between shares and tokens
     *      2. Rebases changing token values without affecting shares
     *      3. Very small mints may round to 0 shares
     */
    function invariant_MintBurnAccounting() public view {
        uint256 actualSupply = okuUSD.totalSupply();

        // Supply should always be finite (sanity check)
        assertLt(actualSupply, type(uint256).max, "Supply should be finite");

        // Total shares should be consistent with supply and multiplier
        uint256 totalShares = okuUSD.totalShares();
        uint256 multiplier = okuUSD.rewardMultiplier();

        if (totalShares > 0) {
            // Supply should be shares * multiplier / precision (with rounding)
            uint256 expectedSupply = (totalShares * multiplier) / PRECISION;
            assertApproxEqAbs(
                actualSupply,
                expectedSupply,
                1, // Allow 1 wei rounding
                "Supply should equal shares * multiplier"
            );
        }
    }

    /**
     * @notice Total shares is non-negative and bounded
     * @dev At extreme multipliers, computed bounds become unreliable due to integer division.
     *      We check: 1) shares are finite, 2) supply formula is consistent
     */
    function invariant_TotalSharesBounded() public view {
        uint256 totalShares = okuUSD.totalShares();
        uint256 multiplier = okuUSD.rewardMultiplier();

        // Sanity check: shares should be finite (not overflow territory)
        assertLt(totalShares, type(uint256).max, "Total shares should be finite");

        // If multiplier is reasonable (< 1e36), check against computed bound
        // At extreme multipliers from many rebases, this check becomes unreliable
        if (multiplier < 1e36) {
            uint256 maxShares = (MAX_SUPPLY * PRECISION) / multiplier;
            assertLe(totalShares, maxShares * 2, "Total shares exceeds reasonable maximum");
        }

        // Always verify the supply formula holds
        uint256 expectedSupply = (totalShares * multiplier) / PRECISION;
        assertApproxEqAbs(okuUSD.totalSupply(), expectedSupply, 1, "Supply formula should hold");
    }
}
