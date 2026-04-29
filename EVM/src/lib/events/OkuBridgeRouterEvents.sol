// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title OkuBridgeRouterEvents
 * @notice Event declarations for the OkuBridgeRouter contract.
 * @dev Inherited by OkuBridgeRouter; see OkuMoneyEvents for the rationale.
 */
abstract contract OkuBridgeRouterEvents {
    /// @notice Emitted when a bridge is initiated via the adapter path
    event BridgeInitiated(
        address indexed user,
        address indexed adapter,
        address sourceToken,
        uint256 amount,
        uint256 destinationChain,
        address recipient
    );

    /// @notice Emitted when a bridge is initiated via the native OkuBridge path
    event NativeBridgeInitiated(
        address indexed user,
        bytes32 indexed requestId,
        uint256 inputAmount,
        uint256 bridgedAmount,
        uint256 feeAmount,
        uint256 destinationChain,
        bytes32 recipient
    );

    event AdapterConfigured(address indexed adapter, bool supported);
    event OkuBridgeUpdated(address indexed oldBridge, address indexed newBridge);
    event Swept(address indexed token, address indexed to, uint256 amount);
}
