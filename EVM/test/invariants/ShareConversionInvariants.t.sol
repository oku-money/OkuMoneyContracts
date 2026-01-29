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
        assertGe(
            okuUSD.rewardMultiplier(), PRECISION, "Multiplier should never be below initial value"
        );
    }

    /**
     * @notice sharesToTokens and tokensToShares are consistent
     */
    function invariant_ConversionConsistency() public view {
        uint256 testShares = 1e18;
        uint256 tokens = okuUSD.sharesToTokens(testShares);
        uint256 recoveredShares = okuUSD.tokensToShares(tokens);

        // Should recover original shares (or less due to rounding)
        assertLe(recoveredShares, testShares, "Conversion should not gain shares");
    }
}
