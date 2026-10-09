// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title OkuMoneyErrors
 * @notice Errors specific to OkuMoney and its rate schedule; the ones several contracts
 *         raise live in {SharedErrors}.
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
}
