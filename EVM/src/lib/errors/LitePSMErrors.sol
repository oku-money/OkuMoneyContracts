// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title LitePSMErrors
 * @notice Errors specific to LitePSM; shared ones live in {SharedErrors}, and
 *         `OverrideInProgress` comes from {OverrideBlockGuard}.
 */
abstract contract LitePSMErrors {
    /// @notice The PSM's USDC buffer cannot cover a redemption or withdrawal.
    /// @param available USDC held by the PSM
    /// @param required  USDC the call needs
    error InsufficientBuffer(uint256 available, uint256 required);
    /// @notice The configured USDC reports more than 18 decimals.
    error UsdcDecimalsTooLarge(uint8 reported);
    /// @dev `_okuDollar` must wrap `_okuMoney`; all pricing assumes one shared multiplier.
    error AssetMismatch();
    /// @notice The caller is on OkuMoney's blacklist (checked by the PSM up front on
    ///         `redeemOkuM`, `mintUsdOku` and `redeemUsdOku`).
    error UserBlacklisted(address user);
}
