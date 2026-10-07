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

    /// @notice Minimum acceptable handler success rate (40%).
    /// @dev Tighter than the original 30% but loose enough to accommodate the
    ///      expanded admin surface (e.g. setNextOkuMYieldRate before any bounded
    ///      window is armed; rebase rejected as non-increasing; etc). A real handler
    ///      bug shows up as a success rate well below this floor.
    uint256 public constant MIN_SUCCESS_RATE = 40;

    /// @notice Minimum calls before checking success rate. Increased from 10 to
    ///         100 so the rate isn't dominated by a handful of early reverts in
    ///         a tiny sample.
    uint256 public constant MIN_CALLS_THRESHOLD = 100;

    function setUp() public override {
        super.setUp();

        okuMoneyHandler = new OkuMoneyHandler(okuMoney, minter, rebaser, allowanceManager);
        okuDollarHandler = new OkuDollarHandler(okuMoney, okuDollar, minter, rebaser);

        // Target both handlers
        targetContract(address(okuMoneyHandler));
        targetContract(address(okuDollarHandler));

        // Exclude all non-handler contracts
        excludeContract(address(okuMoney));
        excludeContract(address(okuDollar));
        excludeContract(address(litePsm));
        excludeContract(address(usdc));
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
