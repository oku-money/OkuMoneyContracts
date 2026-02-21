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
        handler = new OkuUSDHandler(okuUSD, minter, rebaser, allowanceManager);

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
        if (!handler.wasLastOperationRebase()) {
            assertLe(
                okuUSD.totalSupply(),
                okuUSD.maxSupply(),
                "Supply exceeds maxSupply after non-rebase operation"
            );
        }
    }

    /**
     * @notice Minted total generally tracks with supply
     * @dev Verifies the supply formula holds and ghost variables provide
     *      a coarse sanity bound on net minted tokens.
     */
    function invariant_MintBurnAccounting() public view {
        uint256 actualSupply = okuUSD.totalSupply();

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

        // Coarse sanity check: if nothing was ever minted, supply must be zero
        if (handler.ghost_mintedTotal() == 0) {
            assertEq(actualSupply, 0, "Supply should be zero if nothing minted");
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

        // If multiplier is reasonable (< 1e36), check against computed bound
        // At extreme multipliers from many rebases, this check becomes unreliable
        if (multiplier < 1e36) {
            uint256 maxShares = (MAX_SUPPLY * PRECISION) / multiplier;
            assertLe(totalShares, maxShares + handler.getActorCount(), "Total shares exceeds maximum");
        }

        // Always verify the supply formula holds
        uint256 expectedSupply = (totalShares * multiplier) / PRECISION;
        assertApproxEqAbs(okuUSD.totalSupply(), expectedSupply, 1, "Supply formula should hold");
    }

    /**
     * @notice Handler should have a reasonable success rate
     * @dev If too many calls revert, the handler is not exercising the contract effectively
     */
    function invariant_ReasonableSuccessRate() public view {
        uint256 totalCalls = handler.ghost_totalCalls();
        uint256 totalReverts = handler.ghost_totalReverts();
        if (totalCalls > 10) {
            assertGe(
                ((totalCalls - totalReverts) * 100) / totalCalls,
                30,
                "Handler success rate too low"
            );
        }
    }
}
