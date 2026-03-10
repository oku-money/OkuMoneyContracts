// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuMoneyHandler} from "../handlers/OkuMoneyHandler.sol";

/**
 * @title OkuMPriceInvariantsTest
 * @notice Invariant tests for OkuMoney okuMPrice() monotonicity and balance consistency
 * @dev Updated for non-rebasing OkuMoney redesign. Replaces old ShareConversionInvariants.
 *      OkuMoney is a standard ERC-20: balanceOf() returns raw token amounts.
 *      okuMPrice() tracks price appreciation separately and must never decrease.
 */
contract OkuMPriceInvariantsTest is BaseTest {
    OkuMoneyHandler public handler;

    function setUp() public override {
        super.setUp();
        handler = new OkuMoneyHandler(okuMoney, minter, rebaser, allowanceManager);

        targetContract(address(handler));

        excludeContract(address(okuMoney));
        excludeContract(address(usdOku));
        excludeContract(address(litePsm));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
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
     * @notice okuMPrice() never decreases
     */
    function invariant_OkuMPriceNeverDecreases() public view {
        uint256 current = okuMoney.okuMPrice();
        assertGe(current, PRECISION, "okuMPrice below initial value");
        assertGe(current, handler.ghostLastOkuMPrice(), "okuMPrice decreased from previous value");
    }

    /**
     * @notice okuMPrice() does not affect totalSupply (non-rebasing)
     * @dev After a price update, totalSupply should remain unchanged.
     */
    function invariant_OkuMPriceDoesNotAffectSupply() public view {
        // totalSupply is always minted - burned, regardless of okuMPrice
        uint256 expectedSupply = handler.ghostMintedTotal() - handler.ghostBurnedTotal();
        assertEq(
            okuMoney.totalSupply(),
            expectedSupply,
            "totalSupply should equal minted - burned regardless of okuMPrice"
        );
    }
}
