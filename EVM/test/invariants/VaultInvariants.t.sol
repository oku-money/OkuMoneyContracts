// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {wOkuUSDHandler} from "../handlers/wOkuUSDHandler.sol";

/**
 * @title VaultInvariantsTest
 * @notice Invariant tests for wOkuUSD vault backing
 */
contract VaultInvariantsTest is BaseTest {
    wOkuUSDHandler public handler;

    function setUp() public override {
        super.setUp();
        handler = new wOkuUSDHandler(okuUSD, wokuUSD, minter, rebaser);

        // Target the handler for invariant testing
        targetContract(address(handler));

        // Exclude other contracts from being called directly
        excludeContract(address(okuUSD));
        excludeContract(address(wokuUSD));
        excludeContract(address(litePSM));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
    }

    /**
     * @notice wOkuUSD is always fully backed by OkuUSD
     * @dev Invariant from CLAUDE.md:
     *      assert(okuUSD.balanceOf(address(wOkuUSD)) == wOkuUSD.totalAssets());
     */
    function invariant_VaultFullyBacked() public view {
        assertEq(
            okuUSD.balanceOf(address(wokuUSD)), wokuUSD.totalAssets(), "Vault must be fully backed"
        );
    }

    /**
     * @notice Total shares cannot extract more than total assets
     */
    function invariant_SharesDoNotExceedAssets() public view {
        uint256 totalShares = wokuUSD.totalSupply();
        uint256 totalAssets = wokuUSD.totalAssets();

        if (totalShares > 0) {
            uint256 convertedAssets = wokuUSD.convertToAssets(totalShares);
            // Allow 1 wei rounding per actor
            assertLe(
                convertedAssets,
                totalAssets + handler.getActorCount(),
                "Converted shares should not exceed assets"
            );
        }
    }

    /**
     * @notice Sum of all user assets should not exceed total assets
     * @dev Due to rounding down in convertToAssets(), sum may be less than total.
     *      The important invariant is that users can never extract more than exists.
     */
    function invariant_UserAssetsSumDoesNotExceedTotal() public view {
        address[] memory actors = handler.getActors();
        uint256 sumOfAssets = 0;

        for (uint256 i = 0; i < actors.length; i++) {
            uint256 shares = wokuUSD.balanceOf(actors[i]);
            if (shares > 0) {
                sumOfAssets += wokuUSD.convertToAssets(shares);
            }
        }

        uint256 totalAssets = wokuUSD.totalAssets();

        // Critical: sum should never exceed total (users can't extract more than exists)
        // Sum may be less due to rounding down, which is fine (favors vault)
        assertLe(
            sumOfAssets,
            totalAssets + handler.getActorCount(), // Allow 1 wei per actor for edge cases
            "Sum of user assets should not exceed total assets"
        );
    }

    /**
     * @notice Handler should have a reasonable success rate
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
