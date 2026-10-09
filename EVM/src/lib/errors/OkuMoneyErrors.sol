// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title OkuMoneyErrors
 * @notice Errors of OkuMoney and its rate schedule, plus the ones OkuDollar and LitePSM
 *         share with it (zero address/amount, rounding, blacklist). OkuDollar and LitePSM
 *         reference these as `OkuMoneyErrors.X`; their own errors live in
 *         `lib/errors/<Contract>Errors.sol`.
 */
abstract contract OkuMoneyErrors {
    /// @notice A mint would push `totalSupply` above `maxSupply`.
    error ExceedsSupplyCap();
    /// @notice `setMaxSupply` was given a value below the current `totalSupply`.
    error BelowCurrentSupply();
    /// @notice A mint exceeds the calling minter's remaining allowance.
    error ExceedsAllowance();
    /// @dev Above `Constants.MAX_MULTIPLIER` ($1,000,000); keeps downstream math overflow-safe.
    error MultiplierTooHigh();
    /// @dev Below `PRECISION` would shrink the multiplier; `PRECISION` itself means no yield.
    error InvalidRate();
    /// @dev Above `Constants.MAX_RATE` (~2242% APY), the rpow input bound.
    error RateTooHigh();
    /// @dev Halting (`newRate == PRECISION`) requires `endTimestamp == 0`.
    error EndTimestampNotAllowed();
    /// @dev A yielding rate's `endTimestamp` must be strictly in the future.
    error EndTimestampInPast();
    /// @dev A rate window may not exceed `Constants.MAX_RATE_WINDOW`.
    error RateWindowTooLong();
    /// @dev `pendingEndTimestamp` must be strictly after the active `okuMRateEnd`.
    error PendingEndNotAfterRateEnd();
    /// @dev Staging a successor requires a bounded active window.
    error NoRateEndSet();
    /// @dev A successor staged after expiry would snapshot unearned yield; use `setOkuMYieldRate`.
    error RateAlreadyExpired();

    // ============ Shared with OkuDollar and LitePSM ============

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
    /// @notice The acting address is blacklisted: the sender of a transfer, the minter's
    ///         recipient, a permit owner, or the spender in `transferFrom`.
    error SenderBlacklisted();
    /// @notice The receiving address is blacklisted: a transfer recipient, or the spender
    ///         being approved in `approve` / `permit`.
    error RecipientBlacklisted();
    /// @notice `blacklist` was called for an address already on the list.
    error AlreadyBlacklisted();
    /// @notice `unblacklist` was called for an address not on the list.
    error NotBlacklisted();
}
