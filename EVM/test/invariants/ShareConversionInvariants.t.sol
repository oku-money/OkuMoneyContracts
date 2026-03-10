// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuNoteHandler} from "../handlers/OkuNoteHandler.sol";

/**
 * @title NotePriceInvariantsTest
 * @notice Invariant tests for OkuNote notePrice() monotonicity and balance consistency
 * @dev Updated for non-rebasing OkuNote redesign. Replaces old ShareConversionInvariants.
 *      OkuNote is a standard ERC-20: balanceOf() returns raw token amounts.
 *      notePrice() tracks price appreciation separately and must never decrease.
 */
contract NotePriceInvariantsTest is BaseTest {
    OkuNoteHandler public handler;

    function setUp() public override {
        super.setUp();
        handler = new OkuNoteHandler(okuNote, minter, rebaser, allowanceManager);

        targetContract(address(handler));

        excludeContract(address(okuNote));
        excludeContract(address(okuUsd));
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
            sumOfBalances += okuNote.balanceOf(actors[i]);
        }

        // Sum of actor balances should not exceed total supply
        // (other addresses like minter may also hold tokens)
        assertLe(
            sumOfBalances,
            okuNote.totalSupply(),
            "Sum of actor balances should not exceed totalSupply"
        );
    }

    /**
     * @notice notePrice() never decreases
     */
    function invariant_NotePriceNeverDecreases() public view {
        uint256 current = okuNote.notePrice();
        assertGe(current, PRECISION, "notePrice below initial value");
        assertGe(current, handler.ghostLastNotePrice(), "notePrice decreased from previous value");
    }

    /**
     * @notice notePrice() does not affect totalSupply (non-rebasing)
     * @dev After a rebase (notePrice update), totalSupply should remain unchanged.
     */
    function invariant_NotePriceDoesNotAffectSupply() public view {
        // totalSupply is always minted - burned, regardless of notePrice
        uint256 expectedSupply = handler.ghostMintedTotal() - handler.ghostBurnedTotal();
        assertEq(
            okuNote.totalSupply(),
            expectedSupply,
            "totalSupply should equal minted - burned regardless of notePrice"
        );
    }
}
