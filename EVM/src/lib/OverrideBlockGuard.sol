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
    /// @notice The call landed in the same block as an emergency multiplier override.
    ///         Retry in a later block.
    error OverrideInProgress();

    /// @dev Reverts if `setOkuMMultiplier` ran earlier in this block. Reads OkuMoney's
    ///      `lastOverrideBlock` (an external call on every guarded path).
    modifier whenNoOverrideThisBlock() {
        if (block.number == _overrideBlockOkuMoney().lastOverrideBlock()) {
            revert OverrideInProgress();
        }
        _;
    }

    /// @notice Hook overridden by inheriting contracts to provide the OkuMoney instance
    ///         whose `lastOverrideBlock` stamp is checked.
    function _overrideBlockOkuMoney() internal view virtual returns (IOkuMoney);
}
