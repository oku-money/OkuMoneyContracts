// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOkuBridge
 * @notice Interface for Oku's custom bridge adapter
 */
interface IOkuBridge {
    /**
     * @notice Bridge tokens to another chain
     * @param token Token address to bridge
     * @param amount Amount to bridge
     * @param destinationChain Destination chain ID
     * @param recipient Recipient address on destination chain
     */
    function bridge(
        address token,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    )
        external;

    /**
     * @notice Receive bridged tokens from another chain
     * @param token Token address to receive
     * @param amount Amount to receive
     * @param recipient Recipient address
     */
    function receiveBridge(address token, uint256 amount, address recipient) external;
}
