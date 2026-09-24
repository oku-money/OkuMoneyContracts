// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Errors
 * @notice Shared error declarations used across multiple OkuMoney contracts.
 * @dev Centralizing common errors keeps revert reasons consistent across contracts that
 *      all reject (e.g.) zero addresses or zero amounts. Contract-specific errors live
 *      with their owning contract.
 */
library Errors {
    /// @notice An address parameter was the zero address.
    error ZeroAddress();
    /// @notice An amount parameter was zero where a positive value was required.
    error ZeroAmount();
    /// @notice The caller's balance is below the requested amount.
    error InsufficientBalance();
    /// @notice A monotonic multiplier value did not strictly increase.
    /// @dev Reverts on backward moves AND no-op (equal-value) updates, so a no-op cannot
    ///      stamp the sandwich-lock block. See {OkuMoney.setOkuMMultiplier}.
    error MultiplierCannotDecrease();
}
