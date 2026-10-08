// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuMoneyHandler} from "../handlers/OkuMoneyHandler.sol";

/**
 * @title MinterAllowanceInvariantsTest
 * @notice Invariant tests for minter allowance monotonic decrease
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
     * @notice Minter allowance only decreases unless admin resets
     */
    function invariant_AllowanceMonotonicDecrease() public view {
        uint256 currentAllowance = okuMoney.minterAllowance(minter);

        if (!handler.wasAllowanceReset()) {
            assertLe(currentAllowance, initialAllowance, "Allowance increased without admin reset");
        }
    }

    /**
     * @notice Burns do NOT restore minter allowance
     */
    function invariant_BurnDoesNotRestoreAllowance() public view {
        uint256 currentAllowance = okuMoney.minterAllowance(minter);
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
        uint256 allowance = okuMoney.minterAllowance(minter);
        assertLe(allowance, okuMoney.maxSupply(), "Allowance exceeds maxSupply");
    }
}
