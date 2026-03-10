// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IBridgeAdapter
 * @notice Interface for third-party bridge adapters (Wormhole NTT, LayerZero OFT, CCIP, etc.)
 * @dev Adapters are message-only shims. OkuBridgeRouter pre-burns OkuMoney before calling
 *      bridge(), so adapters are responsible only for cross-chain message delivery.
 *      The third-party protocol handles destination-side minting natively.
 */
interface IBridgeAdapter {
    /**
     * @notice Send a cross-chain message after OkuMoney has already been burned
     * @param token Token address that was burned (for validation)
     * @param amount Amount that was burned
     * @param destinationChain Destination chain ID
     * @param recipient Recipient address on destination chain
     */
    function bridge(
        address token,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    )
        external
        payable;

    /**
     * @notice Receive bridged tokens from another chain
     * @param token Token address to receive
     * @param amount Amount to receive
     * @param recipient Recipient address
     */
    function receiveBridge(address token, uint256 amount, address recipient) external;
}
