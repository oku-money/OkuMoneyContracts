// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuMoneyHandler} from "../handlers/OkuMoneyHandler.sol";

/**
 * @title MinterAllowanceInvariantsTest
 * @notice Invariant tests for the minter allowance, which meters net outstanding issuance:
 *         mints draw it down, burns restore it up to the last configured limit.
 */
contract MinterAllowanceInvariantsTest is BaseTest {
    OkuMoneyHandler public handler;
    uint256 public initialAllowance;

    function setUp() public override {
        super.setUp();
        handler = new OkuMoneyHandler(okuMoney, minter, rateManager, allowanceManager);

        // Record initial allowance
        initialAllowance = okuMoney.minterAllowance(minter);

        targetContract(address(handler));

        excludeContract(address(okuMoney));
        excludeContract(address(okuDollar));
        excludeContract(address(litePsm));
        excludeContract(address(usdc));
    }

    /**
     * @notice Minter allowance never rises above the configured value without an admin reset
     */
    function invariant_AllowanceMonotonicDecrease() public view {
        uint256 currentAllowance = okuMoney.minterAllowance(minter);

        if (!handler.wasAllowanceReset()) {
            assertLe(currentAllowance, initialAllowance, "Allowance increased without admin reset");
        }
    }

    /**
     * @notice Burns never restore the allowance above the last configured limit
     */
    function invariant_AllowanceNeverExceedsLimit() public view {
        assertLe(
            okuMoney.minterAllowance(minter),
            okuMoney.minterAllowanceLimit(minter),
            "Allowance exceeds configured limit"
        );
    }

    /**
     * @notice Consumed allowance equals net outstanding issuance (minted - burned).
     * @dev Handler actors only receive OkuM from the handler's mint, so every burn is of
     *      OkuM minted since the last configure and restoration is never clamped.
     */
    function invariant_AllowanceTracksNetIssuance() public view {
        if (!handler.wasAllowanceReset()) {
            uint256 allowanceConsumed = initialAllowance - okuMoney.minterAllowance(minter);
            assertEq(
                allowanceConsumed,
                handler.ghostMintedTotal() - handler.ghostBurnedTotal(),
                "Allowance consumed != net issuance"
            );
        }
    }

    /**
     * @notice Minter allowance is bounded by maxSupply
     */
    function invariant_AllowanceBounded() public view {
        uint256 allowance = okuMoney.minterAllowance(minter);
        assertLe(allowance, okuMoney.maxSupply(), "Allowance exceeds maxSupply");
    }
}
