// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Errors
 * @notice Errors shared across OkuMoney contracts; contract-specific errors live with their owner.
 */
library Errors {
    /// @notice An address parameter was the zero address.
    error ZeroAddress();
    /// @notice An amount parameter was zero where a positive value was required.
    error ZeroAmount();
    /// @notice The caller's balance is below the requested amount.
    error InsufficientBalance();
    /// @notice A monotonic multiplier value did not strictly increase.
    /// @dev Also rejects no-op updates, so they cannot burn the override-block stamp.
    error MultiplierCannotDecrease();
}
