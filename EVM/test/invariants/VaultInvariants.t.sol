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

    /// @notice Fixed rounding tolerance. Deliberately not scaled by call count, which
    ///         would grow faster than any plausible deficit and make the check vacuous.
    uint256 public constant ROUNDING_TOLERANCE = 100; // wei (in dollar terms)

    function setUp() public override {
        super.setUp();
        handler = new OkuDollarHandler(okuMoney, okuDollar, minter, rateManager);

        // Grant roles required by the handler surface. The handler drives the shared
        // multiplier by pranking `rateManager` (OKUM_RATE_MANAGER, granted in BaseTest).
        vm.startPrank(admin);
        okuDollar.grantRole(DEFAULT_ADMIN_ROLE, address(handler));
        vm.stopPrank();

        // The handler mints OkuMoney via `vm.prank(minter)`, so no extra grant is needed.

        targetContract(address(handler));

        excludeContract(address(okuMoney));
        excludeContract(address(okuDollar));
        excludeContract(address(litePsm));
        excludeContract(address(usdc));
    }

    /// @notice Reserves exactly cover obligations — collateralization is 1.0.
    /// @dev Shares track raw OkuM 1:1, so `totalUsdShares` is the OkuM required to
    ///      honour every share. Pins that no code path (notably `rescueDonation`) can
    ///      transfer out OkuM that backs live shares.
    function invariant_VaultBacked() public view {
        uint256 reserves = okuMoney.balanceOf(address(okuDollar));
        uint256 shareBacking = okuDollar.totalUsdShares();

        assertGe(
            reserves, shareBacking, "Vault OkuM reserves must cover outstanding share backing 1:1"
        );

        // Dollar-denominated restatement: reserves valued at the shared multiplier
        // must cover obligations. Exact by construction, hence assertGe with a small
        // tolerance is kept only to absorb the two independent floor() operations.
        uint256 price = okuMoney.okuMMultiplier();
        uint256 reservesDollarValue = (reserves * price) / 1e18;
        assertGe(
            reservesDollarValue + ROUNDING_TOLERANCE,
            okuDollar.totalSupply(),
            "Reserves' dollar value must cover obligations"
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
