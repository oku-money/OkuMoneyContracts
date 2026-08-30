// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmountNewUIMultiplier
 * @notice Required extension of ERC-8056 exposing a scheduled-but-not-yet-effective
 *         pending multiplier.
 * @dev Interface ID `0x4bd27648`, pinned in `Constants.IID_SCALED_UI_AMOUNT_NEW_MULTIPLIER`.
 *      Because `M_oku` is genuinely stepwise, this extension fits natively — steps
 *      may be scheduled ahead, which is exactly the "upcoming adjustment" UI this
 *      extension was built for. See `EVM/README.md § ERC-8056 on OkuM`.
 */
interface IScaledUIAmountNewUIMultiplier {
    /// @notice The scheduled next multiplier value.
    function newUIMultiplier() external view returns (uint256);

    /// @notice Timestamp at which `newUIMultiplier` takes effect.
    function effectiveAt() external view returns (uint256);
}
