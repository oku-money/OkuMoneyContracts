// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmountNewUIMultiplier
 * @notice Required extension of ERC-8056 exposing a scheduled-but-not-yet-effective
 *         pending multiplier.
 * @dev Interface ID `0x4bd27648`, pinned in `Constants.IID_SCALED_UI_NEW_MULTIPLIER`.
 *      OkuMoney maps this onto its scheduled successor epoch: `effectiveAt` is the
 *      pending epoch's `startTime`, and `newUIMultiplier` is the multiplier value at
 *      which that epoch begins accruing. When no successor is scheduled both resolve
 *      to the current epoch's terminal state, which is the value the multiplier will
 *      hold when the active epoch flatlines.
 *      See `EVM/README.md § ERC-8056 on OkuMoney`.
 */
interface IScaledUIAmountNewUIMultiplier {
    /// @notice The scheduled next multiplier value.
    function newUIMultiplier() external view returns (uint256);

    /// @notice Timestamp at which `newUIMultiplier` takes effect.
    function effectiveAt() external view returns (uint256);
}
