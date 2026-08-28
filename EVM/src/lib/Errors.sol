// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Errors
 * @notice Shared error declarations used across multiple contracts in the suite.
 * @dev Centralizing common errors keeps revert reasons consistent and avoids
 *      drift between contracts that reject the same class of bad input.
 *      Contract-specific errors (e.g. `StepAboveMaximum`, `SolvencyGapExceeded`)
 *      live with their owning contract since their bound is contract-specific.
 */
library Errors {
    /// @notice An address parameter was the zero address.
    error ZeroAddress();
    /// @notice An amount parameter was zero where a positive value was required.
    error ZeroAmount();
    /// @notice The caller's balance is below the requested amount.
    error InsufficientBalance();
    /// @notice A monotonic multiplier/index value did not strictly increase.
    /// @dev Shared by `OkuM.setOkuMultiplier` and `USDOku.setUsdOkuRate` — both
    ///      multipliers are monotone; neither has a downward path on-chain.
    error MultiplierCannotDecrease();
    /// @notice A multiplier/index write would exceed `Constants.MAX_MULTIPLIER`.
    /// @dev Shared ceiling check on both `M_oku` (direct write) and `M_usd`
    ///      (projected value at `rateEnd`).
    error MultiplierAboveMaximum();
}
