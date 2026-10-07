// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOkuMoney} from "../interfaces/IOkuMoney.sol";

/**
 * @title OverrideBlockGuard
 * @notice Blocks OkuDollar/LitePSM mint and redeem paths in the block where
 *         `OkuMoney.setOkuMMultiplier()` (the discrete emergency override) executes.
 * @dev Forward-only guard: the stamp is written inside `setOkuMMultiplier`, so same-block
 *      txs ordered before the override, and a mint-before/redeem-after across blocks, are
 *      not blocked. See README § Accepted Risks (discrete-tick MEV).
 */
abstract contract OverrideBlockGuard {
    error OverrideInProgress();

    modifier whenNoOverrideThisBlock() {
        if (block.number == _overrideBlockOkuMoney().lastYieldDistributionBlock()) {
            revert OverrideInProgress();
        }
        _;
    }

    /// @notice Hook overridden by inheriting contracts to provide the OkuMoney instance
    ///         whose distribution block is being tracked.
    function _overrideBlockOkuMoney() internal view virtual returns (IOkuMoney);
}
