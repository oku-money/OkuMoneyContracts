// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IScaledUIAmount
 * @notice ERC-8056 core interface — Scaled UI Amount Extension for ERC-20 Tokens.
 * @dev Interface ID: `0xa60bf13d` (single function, so the ID equals the
 *      `uiMultiplier()` selector).
 *
 *      ERC-8056 is a **display** extension. It makes no claim about value and
 *      specifies no redemption semantics. Standard ERC-20 functions
 *      (`balanceOf`, `transfer`, `totalSupply`, ...) MUST continue to operate on
 *      raw amounts — see ERC-8056 "Implementation Requirements" item 3.
 *
 *      Spec: https://eips.ethereum.org/EIPS/eip-8056 (Standards Track, Draft)
 */
interface IScaledUIAmount {
    /// @notice Emitted when the UI multiplier is updated.
    /// @param oldMultiplier Multiplier in effect immediately before the update.
    /// @param newMultiplier Multiplier that will be in effect at `effectiveAtTimestamp`.
    /// @param effectiveAtTimestamp Timestamp at which `newMultiplier` obtains.
    event UIMultiplierUpdated(
        uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp
    );

    /// @notice OPTIONAL per ERC-8056 — emitted on transfer with the UI-adjusted amount.
    /// @dev Events do not contribute to an ERC-165 interface ID, so declaring this
    ///      here does not affect `type(IScaledUIAmount).interfaceId`.
    event TransferWithUIAmount(
        address indexed from, address indexed to, uint256 amount, uint256 uiAmount
    );

    /// @notice The current UI multiplier, 18 decimals (`1e18` == 1.0).
    function uiMultiplier() external view returns (uint256);
}
