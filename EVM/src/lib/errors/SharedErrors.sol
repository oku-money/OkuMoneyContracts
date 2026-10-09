// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title SharedErrors
 * @notice Protocol-wide generic errors, mostly raised by more than one contract
 *         (`InsufficientBalance` is OkuDollar-only and `MultiplierCannotDecrease`
 *         OkuMoney-only, kept here as generic names). A library, so each contract's ABI
 *         lists only the ones it actually raises. Contract-specific errors live in
 *         `<Contract>Errors.sol`.
 * @dev Not named `Errors`: OpenZeppelin v5 ships a `library Errors`, and the name clash
 *      stops Slither from building IR for every function that references it.
 */
library SharedErrors {
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
    /// @notice The acting address is blacklisted: the sender of a transfer, the minter or
    ///         burner, the wrap caller or unwrap owner, a permit owner, or the spender in
    ///         `transferFrom` / ERC-4626 `withdraw` / `redeem`.
    error SenderBlacklisted();
    /// @notice The receiving address is blacklisted: a transfer, mint, wrap or unwrap
    ///         recipient, or the spender being approved in `approve` / `permit`.
    error RecipientBlacklisted();
    /// @notice `blacklist` was called for an address already on the list.
    error AlreadyBlacklisted();
    /// @notice `unblacklist` was called for an address not on the list.
    error NotBlacklisted();
}
