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

        // Grant roles required by the handler surface.
        // REMOVED (single-multiplier refactor): VAULT_REBASER / VAULT_RESERVE_MANAGER
        // grants — those roles no longer exist. The handler drives the shared
        // multiplier by pranking `rebaser` (OKUM_REBASER on OkuMoney), granted in
        // BaseTest._setupRoles.
        vm.startPrank(admin);
        okuDollar.grantRole(DEFAULT_ADMIN_ROLE, address(handler));
        vm.stopPrank();

        // Handler also needs to be able to mint OkuMoney via `vm.prank(minter)`. The
        // handler still uses minter for that path, so no extra grant needed.

        targetContract(address(handler));

        excludeContract(address(okuMoney));
        excludeContract(address(okuDollar));
        excludeContract(address(litePsm));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
    }

    /// @notice Reserves exactly cover obligations — collateralization is 1.0.
    /// @dev Restated from the old `>= 100% within tolerance` form. Under the
    ///      single-multiplier design shares track raw OkuM 1:1, so
    ///      `totalUsdShares == ` the OkuM required to honour every share, and both
    ///      sides are floored through the same multiplier. The remaining content of
    ///      this invariant is that the vault holds AT LEAST its share backing — i.e.
    ///      that no code path can transfer out OkuM that backs live shares
    ///      (`rescueDonation` being the one path that touches reserves directly).
    ///
    ///      REMOVED: the separate `invariant_CollateralizationRatio` — it asserted
    ///      the identical inequality on the identical quantities and was a duplicate
    ///      even before the refactor.
    function invariant_VaultBacked() public view {
        uint256 reserves = okuMoney.balanceOf(address(okuDollar));
        uint256 shareBacking = okuDollar.totalUsdShares();

        assertGe(
            reserves,
            shareBacking,
            "Vault OkuM reserves must cover outstanding share backing 1:1"
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
