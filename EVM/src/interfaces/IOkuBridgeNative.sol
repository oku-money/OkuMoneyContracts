// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOkuBridgeNative
 * @notice Interface for the native OkuBridge contract used by OkuBridgeRouter.
 * @dev Exposes only the methods the router needs: `bridgeBurn` and `quoteFee`.
 *      `quoteFee` is the single source of truth for fee accounting on auxiliary
 *      router events; OkuBridge.bridgeBurn uses it internally too.
 */
interface IOkuBridgeNative {
    function bridgeBurn(
        uint256 destChainId,
        bytes32 recipient,
        uint256 amount
    )
        external
        returns (bytes32 requestId);

    /// @notice Quote the fee + net amount for a bridge of `amount` tokens.
    function quoteFee(uint256 amount) external view returns (uint256 fee, uint256 net);
}
