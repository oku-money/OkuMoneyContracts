// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title OkuDollarErrors
 * @notice Errors specific to OkuDollar; shared ones live in {Errors}, and
 *         `OverrideInProgress` comes from {OverrideBlockGuard}.
 */
abstract contract OkuDollarErrors {
    /// @notice `wrap` would mint fewer dollars than the caller's `minAmountOut`.
    error OutputBelowMinimum(uint256 actual, uint256 minimum);
    /// @notice The vault holds less OkuM than an unwrap must return. Unreachable while
    ///         reserves back every share; kept as a guard.
    error InsufficientReserves();
    /// @notice `rescueDonation` would dip into OkuM that backs outstanding shares.
    error NoDonationAvailable();
    /// @notice Direct `_mint` is forbidden; use `wrap()`.
    error UseWrapInstead();
    /// @notice Direct `_burn` is forbidden; use `unwrap()`.
    error UseUnwrapInstead();
    /// @notice The inherited ERC-20 `_update` path must never execute.
    error OkuDollarDoesNotUseInternalUpdate();
}
