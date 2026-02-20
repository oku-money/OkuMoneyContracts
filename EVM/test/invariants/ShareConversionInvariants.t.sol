// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuUSDHandler} from "../handlers/OkuUSDHandler.sol";

/**
 * @title ShareConversionInvariantsTest
 * @notice Invariant tests for OkuUSD share/token conversion formulas
 */
contract ShareConversionInvariantsTest is BaseTest {
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
     * @notice balanceOf always equals shares * multiplier / PRECISION
     * @dev Invariant from CLAUDE.md:
     *      assert(okuUSD.balanceOf(user) == shares * rewardMultiplier / PRECISION);
     */
    function invariant_BalanceOfFormula() public view {
        address[] memory actors = handler.getActors();

        for (uint256 i = 0; i < actors.length; i++) {
            address user = actors[i];
            uint256 shares = okuUSD.sharesOf(user);
            uint256 expectedBalance = (shares * okuUSD.rewardMultiplier()) / PRECISION;

            assertEq(okuUSD.balanceOf(user), expectedBalance, "balanceOf formula violated");
        }
    }

    /**
     * @notice totalSupply always equals totalShares * multiplier / PRECISION
     */
    function invariant_TotalSupplyFormula() public view {
        uint256 totalShares = okuUSD.totalShares();
        uint256 expectedSupply = (totalShares * okuUSD.rewardMultiplier()) / PRECISION;

        assertEq(okuUSD.totalSupply(), expectedSupply, "totalSupply formula violated");
    }

    /**
     * @notice Sum of all user shares equals totalShares
     */
    function invariant_SharesSumToTotal() public view {
        address[] memory actors = handler.getActors();
        uint256 sumOfShares = 0;

        for (uint256 i = 0; i < actors.length; i++) {
            sumOfShares += okuUSD.sharesOf(actors[i]);
        }

        // Total shares should be >= sum (there may be other holders)
        assertLe(sumOfShares, okuUSD.totalShares(), "Sum of actor shares should not exceed total");
    }

    /**
     * @notice Reward multiplier never decreases
     */
    function invariant_MultiplierNeverDecreases() public view {
        uint256 current = okuUSD.rewardMultiplier();
        assertGe(current, PRECISION, "Multiplier below initial value");
        assertGe(current, handler.ghost_lastMultiplier(), "Multiplier decreased from previous value");
    }

    /**
     * @notice sharesToTokens and tokensToShares are consistent
     */
    function invariant_ConversionConsistency() public view {
        // Test at multiple representative values
        uint256[3] memory testValues = [uint256(1), 1e18, 1_000_000e18];
        for (uint256 i = 0; i < 3; i++) {
            uint256 tokens = okuUSD.sharesToTokens(testValues[i]);
            uint256 recovered = okuUSD.tokensToShares(tokens);
            assertLe(recovered, testValues[i], "Conversion should not gain shares");
        }

        // Test with actual actor shares
        address[] memory actors = handler.getActors();
        for (uint256 i = 0; i < actors.length; i++) {
            uint256 actorShares = okuUSD.sharesOf(actors[i]);
            if (actorShares > 0) {
                uint256 tokens = okuUSD.sharesToTokens(actorShares);
                uint256 recovered = okuUSD.tokensToShares(tokens);
                assertLe(recovered, actorShares, "Actor conversion should not gain shares");
            }
        }
    }
}
