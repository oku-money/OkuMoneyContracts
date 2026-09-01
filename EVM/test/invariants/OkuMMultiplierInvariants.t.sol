// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuMoneyHandler} from "../handlers/OkuMoneyHandler.sol";

/**
 * @title OkuMPriceInvariantsTest
 * @notice Invariant tests for OkuMoney okuMMultiplier() monotonicity and balance consistency
 * @dev Updated for non-rebasing OkuMoney redesign. Replaces old ShareConversionInvariants.
 *      OkuMoney is a standard ERC-20: balanceOf() returns raw token amounts.
 *      okuMMultiplier() tracks multiplier appreciation separately and must never decrease.
 */
contract OkuMPriceInvariantsTest is BaseTest {
    OkuMoneyHandler public handler;

    function setUp() public override {
        super.setUp();
        handler = new OkuMoneyHandler(okuMoney, minter, rebaser, allowanceManager);

        targetContract(address(handler));

        excludeContract(address(okuMoney));
        excludeContract(address(okuDollar));
        excludeContract(address(litePsm));
        excludeContract(address(usdc));
    }

    /**
     * @notice Sum of all user balances equals totalSupply (standard ERC-20 invariant)
     */
    function invariant_BalancesSumToTotalSupply() public view {
        address[] memory actors = handler.getActors();
        uint256 sumOfBalances = 0;

        for (uint256 i = 0; i < actors.length; i++) {
            sumOfBalances += okuMoney.balanceOf(actors[i]);
        }

        // Sum of actor balances should not exceed total supply
        // (other addresses like minter may also hold tokens)
        assertLe(
            sumOfBalances,
            okuMoney.totalSupply(),
            "Sum of actor balances should not exceed totalSupply"
        );
    }

    /**
     * @notice okuMMultiplier() never decreases between observations.
     * @dev `ghostLastOkuMMultiplier` is updated in `afterInvariant` so the
     *      observation happens regardless of whether the handler call reverted.
     */
    function invariant_OkuMPriceNeverDecreases() public view {
        uint256 current = okuMoney.okuMMultiplier();
        assertGe(current, PRECISION, "okuMMultiplier below initial value");
        assertGe(
            current,
            handler.ghostLastOkuMMultiplier(),
            "okuMMultiplier decreased between observations"
        );
    }

    function afterInvariant() public {
        handler.recordMultiplierObservation();
    }

    /**
     * @notice okuMMultiplier() does not affect totalSupply (non-rebasing)
     * @dev After a price update, totalSupply should remain unchanged.
     */
    function invariant_OkuMPriceDoesNotAffectSupply() public view {
        // totalSupply is always minted - burned, regardless of okuMMultiplier
        uint256 expectedSupply = handler.ghostMintedTotal() - handler.ghostBurnedTotal();
        assertEq(
            okuMoney.totalSupply(),
            expectedSupply,
            "totalSupply should equal minted - burned regardless of okuMMultiplier"
        );
    }
}
