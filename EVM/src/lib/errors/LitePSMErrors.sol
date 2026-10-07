// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title LitePSMErrors
 * @notice Errors specific to LitePSM; shared ones live in {Errors}, and
 *         `OverrideInProgress` comes from {OverrideBlockGuard}.
 */
abstract contract LitePSMErrors {
    error InsufficientBuffer(uint256 available, uint256 required);
    error UsdcDecimalsTooLarge(uint8 reported);
    /// @dev `_okuDollar` must wrap `_okuMoney`; all pricing assumes one shared multiplier.
    error AssetMismatch();
    error UserBlacklisted(address user);
}
