// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Errors
 * @notice Errors raised by more than one contract. Contract-specific errors live in
 *         `lib/errors/<Contract>Errors.sol`.
 */
library Errors {
    /// @notice An address parameter was the zero address.
    error ZeroAddress();
    /// @notice An amount parameter was zero where a positive value was required.
    error ZeroAmount();
    /// @notice A non-zero input converts to zero output after rounding.
    error AmountTooSmall();
    /// @notice The caller's balance is below the requested amount.
    error InsufficientBalance();
    /// @notice A monotonic multiplier value did not strictly increase.
    /// @dev Also rejects no-op updates, so they cannot burn the override-block stamp.
    error MultiplierCannotDecrease();

    // Blacklist (OkuMoney and OkuDollar keep separate lists).
    error SenderBlacklisted();
    error RecipientBlacklisted();
    error AlreadyBlacklisted();
    error NotBlacklisted();
}
