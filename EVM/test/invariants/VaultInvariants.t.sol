// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuUSDHandler} from "../handlers/OkuUSDHandler.sol";

/**
 * @title VaultInvariantsTest
 * @notice Invariant tests for OkuUSD vault backing
 */
contract VaultInvariantsTest is BaseTest {
    OkuUSDHandler public handler;

    function setUp() public override {
        super.setUp();
        handler = new OkuUSDHandler(okuNote, okuUsd, minter, rebaser);

        // Target the handler for invariant testing
        targetContract(address(handler));

        // Exclude other contracts from being called directly
        excludeContract(address(okuNote));
        excludeContract(address(okuUsd));
        excludeContract(address(litePsm));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
    }

    /**
     * @notice OkuUSD vault is backed by OkuNote reserves (within rounding tolerance)
     * @dev Each wrap operation can introduce up to 1 wei of rounding deficit
     *      (wrap rounds DOWN shares, but usdMinted = noteAmount, so totalSupply can
     *      fractionally exceed reserves). Tolerance = total wrap calls.
     */
    function invariant_VaultBacked() public view {
        uint256 reserves = okuNote.balanceOf(address(okuUsd));
        uint256 obligations = okuUsd.totalSupply();
        uint256 tolerance = handler.ghostWrapCallCount() + 1;

        assertGe(
            reserves + tolerance,
            obligations,
            "Vault must be backed by note reserves (within rounding tolerance)"
        );
    }

    /**
     * @notice Collateralization ratio stays approximately >= 100%
     * @dev Same rounding tolerance as invariant_VaultBacked
     */
    function invariant_CollateralizationRatio() public view {
        uint256 obligations = okuUsd.totalSupply();
        if (obligations > 0) {
            uint256 reserves = okuNote.balanceOf(address(okuUsd));
            uint256 tolerance = handler.ghostWrapCallCount() + 1;
            assertGe(
                reserves + tolerance,
                obligations,
                "Collateralization should be approximately >= 100%"
            );
        }
    }

    /**
     * @notice Sum of all user OkuUSD balances should not exceed total supply
     */
    function invariant_UserBalancesSumDoesNotExceedTotal() public view {
        address[] memory actors = handler.getActors();
        uint256 sumOfBalances = 0;

        for (uint256 i = 0; i < actors.length; i++) {
            sumOfBalances += okuUsd.balanceOf(actors[i]);
        }

        uint256 totalSupply = okuUsd.totalSupply();

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
