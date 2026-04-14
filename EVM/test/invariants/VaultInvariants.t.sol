// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuDollarHandler} from "../handlers/OkuDollarHandler.sol";

/**
 * @title VaultInvariantsTest
 * @notice Invariant tests for OkuDollar vault backing
 */
contract VaultInvariantsTest is BaseTest {
    OkuDollarHandler public handler;

    function setUp() public override {
        super.setUp();
        handler = new OkuDollarHandler(okuMoney, usdOku, minter, rebaser);

        // Target the handler for invariant testing
        targetContract(address(handler));

        // Exclude other contracts from being called directly
        excludeContract(address(okuMoney));
        excludeContract(address(usdOku));
        excludeContract(address(litePsm));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
    }

    /**
     * @notice OkuDollar vault is backed by OkuMoney reserves (within rounding tolerance)
     * @dev Price-aware: reserves are valued at okuMMultiplier(). Each wrap can introduce
     *      up to ~1 wei of rounding deficit in dollar terms.
     *      reservesDollarValue = reserves × okuMMultiplier / PRECISION
     *      obligations = totalSupply (already in dollar terms)
     */
    function invariant_VaultBacked() public view {
        uint256 reserves = okuMoney.balanceOf(address(usdOku));
        uint256 obligations = usdOku.totalSupply();
        uint256 price = okuMoney.okuMMultiplier();
        uint256 reservesDollarValue = (reserves * price) / 1e18;
        // Each wrap introduces up to 1 wei rounding in dollar terms
        uint256 tolerance = handler.ghostWrapCallCount() + 1;

        assertGe(
            reservesDollarValue + tolerance,
            obligations,
            "Vault must be backed by OkuMoney reserves in dollar terms (within rounding tolerance)"
        );
    }

    /**
     * @notice Collateralization ratio stays approximately >= 100%
     * @dev Price-aware: same dollar-value comparison as invariant_VaultBacked
     */
    function invariant_CollateralizationRatio() public view {
        uint256 obligations = usdOku.totalSupply();
        if (obligations > 0) {
            uint256 reserves = okuMoney.balanceOf(address(usdOku));
            uint256 price = okuMoney.okuMMultiplier();
            uint256 reservesDollarValue = (reserves * price) / 1e18;
            uint256 tolerance = handler.ghostWrapCallCount() + 1;
            assertGe(
                reservesDollarValue + tolerance,
                obligations,
                "Collateralization should be approximately >= 100% in dollar terms"
            );
        }
    }

    /**
     * @notice Sum of all user OkuDollar balances should not exceed total supply
     */
    function invariant_UserBalancesSumDoesNotExceedTotal() public view {
        address[] memory actors = handler.getActors();
        uint256 sumOfBalances = 0;

        for (uint256 i = 0; i < actors.length; i++) {
            sumOfBalances += usdOku.balanceOf(actors[i]);
        }

        uint256 totalSupply = usdOku.totalSupply();

        assertLe(
            sumOfBalances,
            totalSupply + handler.getActorCount(),
            "Sum of user balances should not exceed total supply"
        );
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
