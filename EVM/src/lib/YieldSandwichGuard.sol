// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOkuMoney} from "../interfaces/IOkuMoney.sol";

/**
 * @title YieldSandwichGuard
 * @notice Shared guard preventing operations from running in the same block as
 *         OkuMoney.setOkuMMultiplier() — the discrete emergency override. Used by
 *         both OkuDollar and LitePSM to stop arbitrageurs from frontrunning a
 *         discrete multiplier move with wrap()/mintOkuM() and backrunning with
 *         unwrap()/redeemOkuM() to capture unearned yield. Streaming accrual
 *         (setOkuMYieldRate) creates no discrete step and needs no such guard.
 *
 * @dev Stateless — relies entirely on `IOkuMoney.lastYieldDistributionBlock()`.
 *      Inheriting contracts should expose `IOkuMoney` to `_yieldSandwichOkuMoney()`.
 */
abstract contract YieldSandwichGuard {
    error YieldDistributionInProgress();

    modifier whenYieldNotDistributing() {
        if (block.number == _yieldSandwichOkuMoney().lastYieldDistributionBlock()) {
            revert YieldDistributionInProgress();
        }
        _;
    }

    /// @notice Hook overridden by inheriting contracts to provide the OkuMoney instance
    ///         whose distribution block is being tracked.
    function _yieldSandwichOkuMoney() internal view virtual returns (IOkuMoney);
}
