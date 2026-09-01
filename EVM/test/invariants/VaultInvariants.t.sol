// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuDollarHandler} from "../handlers/OkuDollarHandler.sol";

/**
 * @title VaultInvariantsTest
 * @notice Stateful invariant tests for the OkuDollar vault.
 */
contract VaultInvariantsTest is BaseTest {
    OkuDollarHandler public handler;

    /// @notice Cap the per-call rounding tolerance at a small constant. The previous
    ///         linear-in-call-count formula trivially passed because tolerance grew
    ///         faster than any plausible deficit.
    uint256 public constant ROUNDING_TOLERANCE = 100; // wei (in dollar terms)

    function setUp() public override {
        super.setUp();
        handler = new OkuDollarHandler(okuMoney, okuDollar, minter, rebaser);

        // Grant roles required by the expanded handler surface.
        vm.startPrank(admin);
        okuDollar.grantRole(VAULT_REBASER, address(handler));
        okuDollar.grantRole(VAULT_RESERVE_MANAGER, address(handler));
        okuDollar.grantRole(DEFAULT_ADMIN_ROLE, address(handler));
        vm.stopPrank();

        // Handler also needs to be able to mint OkuMoney via `vm.prank(minter)`. The
        // handler still uses minter for that path, so no extra grant needed.

        targetContract(address(handler));

        excludeContract(address(okuMoney));
        excludeContract(address(okuDollar));
        excludeContract(address(litePsm));
        excludeContract(address(usdc));
    }

    /// @notice OkuDollar vault is collateralized by OkuMoney reserves (within a fixed
    ///         small rounding tolerance, NOT a tolerance that grows with call count).
    function invariant_VaultBacked() public view {
        uint256 reserves = okuMoney.balanceOf(address(okuDollar));
        uint256 obligations = okuDollar.totalSupply();
        uint256 price = okuMoney.okuMMultiplier();
        uint256 reservesDollarValue = (reserves * price) / 1e18;

        assertGe(
            reservesDollarValue + ROUNDING_TOLERANCE,
            obligations,
            "Vault must be backed by OkuMoney reserves (within 100 wei rounding)"
        );
    }

    /// @notice Collateralization ratio stays at-or-above 100% (within rounding).
    function invariant_CollateralizationRatio() public view {
        uint256 obligations = okuDollar.totalSupply();
        if (obligations == 0) return;

        uint256 reserves = okuMoney.balanceOf(address(okuDollar));
        uint256 price = okuMoney.okuMMultiplier();
        uint256 reservesDollarValue = (reserves * price) / 1e18;
        assertGe(
            reservesDollarValue + ROUNDING_TOLERANCE,
            obligations,
            "Collateralization should be >= 100% within rounding tolerance"
        );
    }

    /// @notice Sum of all user OkuDollar balances should not exceed total supply
    ///         (within a small per-actor rounding allowance).
    function invariant_UserBalancesSumDoesNotExceedTotal() public view {
        address[] memory actors = handler.getActors();
        uint256 sumOfBalances = 0;
        for (uint256 i = 0; i < actors.length; i++) {
            sumOfBalances += okuDollar.balanceOf(actors[i]);
        }
        uint256 totalSupply = okuDollar.totalSupply();
        assertLe(
            sumOfBalances,
            totalSupply + actors.length, // up to 1 wei rounding per actor
            "Sum of user balances should not exceed total supply"
        );
    }
}
