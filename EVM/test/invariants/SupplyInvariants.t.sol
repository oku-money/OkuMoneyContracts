// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuNoteHandler} from "../handlers/OkuNoteHandler.sol";

/**
 * @title SupplyInvariantsTest
 * @notice Invariant tests for OkuNote supply cap enforcement
 * @dev Updated for non-rebasing OkuNote redesign. totalSupply() is standard ERC-20;
 *      notePrice() tracks price appreciation separately.
 */
contract SupplyInvariantsTest is BaseTest {
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
     * @notice Supply cap never exceeded
     * @dev OkuNote is non-rebasing: totalSupply() is raw token count,
     *      notePrice() updates do not change totalSupply().
     */
    function invariant_SupplyCapRespected() public view {
        assertLe(okuNote.totalSupply(), okuNote.maxSupply(), "Supply exceeds maxSupply");
    }

    /**
     * @notice Minted total tracks with supply (minted - burned = totalSupply)
     */
    function invariant_MintBurnAccounting() public view {
        uint256 actualSupply = okuNote.totalSupply();

        if (handler.ghostMintedTotal() == 0) {
            assertEq(actualSupply, 0, "Supply should be zero if nothing minted");
        }

        // totalSupply = minted - burned
        uint256 expectedSupply = handler.ghostMintedTotal() - handler.ghostBurnedTotal();
        assertEq(actualSupply, expectedSupply, "Supply should equal minted - burned");
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
