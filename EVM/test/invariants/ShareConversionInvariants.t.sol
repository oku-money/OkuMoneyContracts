// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuNoteHandler} from "../handlers/OkuNoteHandler.sol";

/**
 * @title ShareConversionInvariantsTest
 * @notice Invariant tests for OkuNote share/token conversion formulas
 */
contract ShareConversionInvariantsTest is BaseTest {
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
     * @notice balanceOf always equals shares * multiplier / PRECISION
     */
    function invariant_BalanceOfFormula() public view {
        address[] memory actors = handler.getActors();

        for (uint256 i = 0; i < actors.length; i++) {
            address user = actors[i];
            uint256 shares = okuNote.sharesOf(user);
            uint256 expectedBalance = (shares * okuNote.rewardMultiplier()) / PRECISION;

            assertEq(okuNote.balanceOf(user), expectedBalance, "balanceOf formula violated");
        }
    }

    /**
     * @notice totalSupply always equals totalShares * multiplier / PRECISION
     */
    function invariant_TotalSupplyFormula() public view {
        uint256 totalShares = okuNote.totalShares();
        uint256 expectedSupply = (totalShares * okuNote.rewardMultiplier()) / PRECISION;

        assertEq(okuNote.totalSupply(), expectedSupply, "totalSupply formula violated");
    }

    /**
     * @notice Sum of all user shares equals totalShares
     */
    function invariant_SharesSumToTotal() public view {
        address[] memory actors = handler.getActors();
        uint256 sumOfShares = 0;

        for (uint256 i = 0; i < actors.length; i++) {
            sumOfShares += okuNote.sharesOf(actors[i]);
        }

        assertLe(sumOfShares, okuNote.totalShares(), "Sum of actor shares should not exceed total");
    }

    /**
     * @notice Reward multiplier never decreases
     */
    function invariant_MultiplierNeverDecreases() public view {
        uint256 current = okuNote.rewardMultiplier();
        assertGe(current, PRECISION, "Multiplier below initial value");
        assertGe(current, handler.ghostLastMultiplier(), "Multiplier decreased from previous value");
    }

    /**
     * @notice sharesToTokens and tokensToShares are consistent
     */
    function invariant_ConversionConsistency() public view {
        uint256[3] memory testValues = [uint256(1), 1e18, 1_000_000e18];
        for (uint256 i = 0; i < 3; i++) {
            uint256 tokens = okuNote.sharesToTokens(testValues[i]);
            uint256 recovered = okuNote.tokensToShares(tokens);
            assertLe(recovered, testValues[i], "Conversion should not gain shares");
        }

        address[] memory actors = handler.getActors();
        for (uint256 i = 0; i < actors.length; i++) {
            uint256 actorShares = okuNote.sharesOf(actors[i]);
            if (actorShares > 0) {
                uint256 tokens = okuNote.sharesToTokens(actorShares);
                uint256 recovered = okuNote.tokensToShares(tokens);
                assertLe(recovered, actorShares, "Actor conversion should not gain shares");
            }
        }
    }
}
