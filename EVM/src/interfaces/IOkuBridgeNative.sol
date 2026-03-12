// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOkuBridgeNative
 * @notice Interface for the native OkuBridge contract
 */
interface IOkuBridgeNative {
    function bridgeBurn(
        uint256 destChainId,
        bytes32 recipient,
        uint256 amount
    )
        external
        returns (bytes32 requestId);

    /// @notice Bridge fee in basis points (e.g. 10 = 0.1%)
    function bridgeFee() external view returns (uint256);
}
