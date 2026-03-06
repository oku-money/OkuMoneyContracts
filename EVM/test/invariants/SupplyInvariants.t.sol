// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuNoteHandler} from "../handlers/OkuNoteHandler.sol";

/**
 * @title SupplyInvariantsTest
 * @notice Invariant tests for OkuNote supply cap enforcement
 */
contract SupplyInvariantsTest is BaseTest {
    OkuNoteHandler public handler;

    function setUp() public override {
        super.setUp();
        handler = new OkuNoteHandler(okuNote, minter, rebaser, allowanceManager);

        targetContract(address(handler));

        excludeContract(address(okuNote));
        excludeContract(address(okuUsd));
        excludeContract(address(litePsm));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
    }

    /**
     * @notice Supply cap never exceeded except by rebase
     * @dev Invariant from CLAUDE.md:
     *      assert(okuNote.totalSupply() <= maxSupply || lastOperationWasRebase);
     */
    function invariant_SupplyCapRespected() public view {
        if (!handler.wasLastOperationRebase()) {
            assertLe(
                okuNote.totalSupply(),
                okuNote.maxSupply(),
                "Supply exceeds maxSupply after non-rebase operation"
            );
        }
    }

    /**
     * @notice Minted total generally tracks with supply
     */
    function invariant_MintBurnAccounting() public view {
        uint256 actualSupply = okuNote.totalSupply();

        uint256 totalShares = okuNote.totalShares();
        uint256 multiplier = okuNote.rewardMultiplier();

        if (totalShares > 0) {
            uint256 expectedSupply = (totalShares * multiplier) / PRECISION;
            assertApproxEqAbs(
                actualSupply, expectedSupply, 1, "Supply should equal shares * multiplier"
            );
        }

        if (handler.ghostMintedTotal() == 0) {
            assertEq(actualSupply, 0, "Supply should be zero if nothing minted");
        }
    }

    /**
     * @notice Total shares is non-negative and bounded
     */
    function invariant_TotalSharesBounded() public view {
        uint256 totalShares = okuNote.totalShares();
        uint256 multiplier = okuNote.rewardMultiplier();

        if (multiplier < 1e36) {
            uint256 maxShares = (MAX_SUPPLY * PRECISION) / multiplier;
            assertLe(
                totalShares, maxShares + handler.getActorCount(), "Total shares exceeds maximum"
            );
        }

        uint256 expectedSupply = (totalShares * multiplier) / PRECISION;
        assertApproxEqAbs(okuNote.totalSupply(), expectedSupply, 1, "Supply formula should hold");
    }

    /**
     * @notice Handler should have a reasonable success rate
     */
    function invariant_ReasonableSuccessRate() public view {
        uint256 totalCalls = handler.ghostTotalCalls();
        uint256 totalReverts = handler.ghostTotalReverts();
        if (totalCalls > 10) {
            assertGe(
                ((totalCalls - totalReverts) * 100) / totalCalls, 30, "Handler success rate too low"
            );
        }
    }
}
