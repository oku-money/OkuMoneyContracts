// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title OkuBridgeEvents
 * @notice Event declarations for the OkuBridge contract.
 * @dev Inherited by OkuBridge; see OkuMoneyEvents for the rationale.
 */
abstract contract OkuBridgeEvents {
    /// @notice Emitted when tokens are burned to initiate a bridge transfer
    event BridgeBurn(
        bytes32 indexed requestId,
        address indexed sender,
        bytes32 recipient,
        uint256 sourceChainId,
        uint256 destChainId,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 feeAmount,
        uint256 nonce,
        uint256 deadline
    );

    /// @notice Emitted when tokens are minted on destination chain
    event BridgeMint(
        bytes32 indexed requestId,
        bytes32 indexed recipient,
        uint256 sourceChainId,
        uint256 destChainId,
        uint256 amount
    );

    event SignerUpdated(address indexed oldSigner, address indexed newSigner);
    event FeeUpdated(uint256 oldFee, uint256 newFee);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event ChainAdded(uint256 indexed chainId);
    event ChainRemoved(uint256 indexed chainId);

    /// @notice Emitted when bridge limits are updated
    event LimitsUpdated(
        uint128 oldMinAmount, uint128 oldMaxAmount, uint128 newMinAmount, uint128 newMaxAmount
    );

    event NonceSkipped(uint256 indexed destChainId, uint256 skippedNonce);
    event DustSwept(address indexed recipient, uint256 amount);
    event DeadlineUpdated(uint256 oldDeadline, uint256 newDeadline);

    /// @notice Emitted when a refund is initiated (step 1 of 2)
    event RefundInitiated(
        bytes32 indexed requestId, address indexed initiator, address sender, uint256 amount
    );
    event RefundConfirmed(bytes32 indexed requestId, address indexed sender, uint256 amount);
    event RefundCancelled(
        bytes32 indexed requestId, address indexed initiator, address indexed cancelledBy
    );
}
