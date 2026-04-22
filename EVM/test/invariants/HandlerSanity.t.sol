// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuMoneyHandler} from "../handlers/OkuMoneyHandler.sol";
import {OkuDollarHandler} from "../handlers/OkuDollarHandler.sol";

/**
 * @title HandlerSanityTest
 * @notice Invariant tests that verify handler behavior is reasonable
 * @dev These are meta-tests that check handler success rates. Separated from
 *      business logic invariants to keep concerns clean.
 */
contract HandlerSanityTest is BaseTest {
    OkuMoneyHandler public okuMoneyHandler;
    OkuDollarHandler public okuDollarHandler;

    /// @notice Minimum acceptable success rate (30%)
    uint256 public constant MIN_SUCCESS_RATE = 30;

    /// @notice Minimum calls before checking success rate
    uint256 public constant MIN_CALLS_THRESHOLD = 10;

    function setUp() public override {
        super.setUp();

        okuMoneyHandler = new OkuMoneyHandler(okuMoney, minter, rebaser, allowanceManager);
        okuDollarHandler = new OkuDollarHandler(okuMoney, usdOku, minter, rebaser);

        // Target both handlers
        targetContract(address(okuMoneyHandler));
        targetContract(address(okuDollarHandler));

        // Exclude all non-handler contracts
        excludeContract(address(okuMoney));
        excludeContract(address(usdOku));
        excludeContract(address(litePsm));
        excludeContract(address(redemptionQueue));
        excludeContract(address(usdc));
        excludeContract(address(oracle));
    }

    /**
     * @notice OkuMoneyHandler should have a reasonable success rate
     * @dev A low success rate indicates the handler bounds or logic need adjustment
     */
    function invariant_OkuMoneyHandlerSuccessRate() public view {
        uint256 totalCalls = okuMoneyHandler.ghostTotalCalls();
        uint256 totalReverts = okuMoneyHandler.ghostTotalReverts();

        if (totalCalls > MIN_CALLS_THRESHOLD) {
            uint256 successRate = ((totalCalls - totalReverts) * 100) / totalCalls;
            assertGe(successRate, MIN_SUCCESS_RATE, "OkuMoneyHandler success rate too low");
        }
    }

    /**
     * @notice OkuDollarHandler should have a reasonable success rate
     * @dev A low success rate indicates the handler bounds or logic need adjustment
     */
    function invariant_OkuDollarHandlerSuccessRate() public view {
        uint256 totalCalls = okuDollarHandler.ghostTotalCalls();
        uint256 totalReverts = okuDollarHandler.ghostTotalReverts();

        if (totalCalls > MIN_CALLS_THRESHOLD) {
            uint256 successRate = ((totalCalls - totalReverts) * 100) / totalCalls;
            assertGe(successRate, MIN_SUCCESS_RATE, "OkuDollarHandler success rate too low");
        }
    }

    /**
     * @notice Combined handler success rate check
     * @dev Overall system should maintain reasonable throughput
     */
    function invariant_CombinedHandlerSuccessRate() public view {
        uint256 totalCalls = okuMoneyHandler.ghostTotalCalls() + okuDollarHandler.ghostTotalCalls();
        uint256 totalReverts =
            okuMoneyHandler.ghostTotalReverts() + okuDollarHandler.ghostTotalReverts();

        if (totalCalls > MIN_CALLS_THRESHOLD * 2) {
            uint256 successRate = ((totalCalls - totalReverts) * 100) / totalCalls;
            assertGe(successRate, MIN_SUCCESS_RATE, "Combined handler success rate too low");
        }
    }
}
