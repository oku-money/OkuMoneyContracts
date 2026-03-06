// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuNoteHandler} from "../handlers/OkuNoteHandler.sol";

/**
 * @title MinterAllowanceInvariantsTest
 * @notice Invariant tests for minter allowance monotonic decrease
 */
contract MinterAllowanceInvariantsTest is BaseTest {
    OkuNoteHandler public handler;
    uint256 public initialAllowance;

    function setUp() public override {
        super.setUp();
        handler = new OkuNoteHandler(okuNote, minter, rebaser, allowanceManager);

        // Record initial allowance
        initialAllowance = okuNote.minterAllowance(minter);

        targetContract(address(handler));

        excludeContract(address(okuNote));
        excludeContract(address(okuUsd));
        excludeContract(address(litePsm));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
    }

    /**
     * @notice Minter allowance only decreases unless admin resets
     */
    function invariant_AllowanceMonotonicDecrease() public view {
        uint256 currentAllowance = okuNote.minterAllowance(minter);

        if (!handler.wasAllowanceReset()) {
            assertLe(currentAllowance, initialAllowance, "Allowance increased without admin reset");
        }
    }

    /**
     * @notice Burns do NOT restore minter allowance
     */
    function invariant_BurnDoesNotRestoreAllowance() public view {
        uint256 currentAllowance = okuNote.minterAllowance(minter);
        uint256 mintedTotal = handler.ghostMintedTotal();

        if (!handler.wasAllowanceReset()) {
            uint256 allowanceConsumed = initialAllowance - currentAllowance;

            assertLe(
                allowanceConsumed,
                mintedTotal + 1,
                "Allowance consumed exceeds minted amount unexpectedly"
            );
        }
    }

    /**
     * @notice Minter allowance is bounded by maxSupply
     */
    function invariant_AllowanceBounded() public view {
        uint256 allowance = okuNote.minterAllowance(minter);
        assertLe(allowance, okuNote.maxSupply(), "Allowance exceeds maxSupply");
    }
}
