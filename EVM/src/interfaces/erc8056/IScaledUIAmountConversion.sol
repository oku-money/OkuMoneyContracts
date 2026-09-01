// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmountConversion
 * @notice Optional ERC-8056 extension exposing on-chain raw <-> UI conversion helpers.
 * @dev Interface ID `0x57854fc3`, pinned in `Constants.IID_SCALED_UI_CONVERSION`.
 *
 *      Both directions floor, so `fromUIAmount(toUIAmount(x))` can be `x - 1`.
 *      A max-send MUST be computed from the raw `balanceOf`, never by
 *      round-tripping through this pair.
 */
interface IScaledUIAmountConversion {
    /// @notice Converts a raw token amount to its UI (dollar) amount.
    function toUIAmount(uint256 rawAmount) external view returns (uint256);

    /// @notice Converts a UI (dollar) amount back to a raw token amount.
    function fromUIAmount(uint256 uiAmount) external view returns (uint256);
}
