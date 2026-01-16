// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INttManager} from "../adapters/INttManager.sol";

/**
 * @title IBridgeToken
 * @notice Interface for the BridgeToken contract
 */
interface IBridgeToken {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockNttManager
 * @notice Mock Wormhole NTT Manager for local testing
 * @dev Simulates cross-chain transfer flow without actual Wormhole network
 */
contract MockNttManager is INttManager {
    struct PendingTransfer {
        address sender;
        uint256 amount;
        uint16 recipientChain;
        bytes32 recipient;
        uint64 sequence;
        bool completed;
    }

    address public bridgeAdapter;
    IBridgeToken public token;
    uint256 public messageFee;

    PendingTransfer[] public pendingTransfers;
    uint64 private nextSequence;

    // Events
    event TransferInitiated(
        address indexed sender,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint64 sequence
    );
    event TransferCompleted(uint256 indexed index, address recipient, uint256 amount);

    // Errors
    error InsufficientFee(uint256 required, uint256 provided);
    error TransferAlreadyCompleted();
    error InvalidIndex();

    constructor(address _token) {
        token = IBridgeToken(_token);
        messageFee = 0.001 ether; // Default mock fee
    }

    /**
     * @notice Set the bridge adapter address for minting on completion
     */
    function setBridgeAdapter(address _adapter) external {
        bridgeAdapter = _adapter;
    }

    /**
     * @notice Set the mock message fee
     */
    function setMessageFee(uint256 _fee) external {
        messageFee = _fee;
    }

    /**
     * @notice Simulate sending a cross-chain transfer
     */
    function transfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient
    ) external payable override returns (uint64 messageSequence) {
        if (msg.value < messageFee) {
            revert InsufficientFee(messageFee, msg.value);
        }

        messageSequence = nextSequence++;

        pendingTransfers.push(PendingTransfer({
            sender: msg.sender,
            amount: amount,
            recipientChain: recipientChain,
            recipient: recipient,
            sequence: messageSequence,
            completed: false
        }));

        emit TransferInitiated(msg.sender, amount, recipientChain, recipient, messageSequence);
    }

    /**
     * @notice Simulate receiving a cross-chain message (not used in mock)
     */
    function receiveMessage(bytes memory) external pure override {
        // Not implemented in mock - use completeBridge instead
    }

    /**
     * @notice Complete a pending bridge transfer (simulate destination chain mint)
     * @dev For testing: simulates receiving VAA and minting on destination
     */
    function completeBridge(uint256 index) external {
        if (index >= pendingTransfers.length) revert InvalidIndex();

        PendingTransfer storage p = pendingTransfers[index];
        if (p.completed) revert TransferAlreadyCompleted();

        p.completed = true;
        address recipient = address(uint160(uint256(p.recipient)));

        // Mint tokens to recipient (simulating destination chain)
        token.mint(recipient, p.amount);

        emit TransferCompleted(index, recipient, p.amount);
    }

    /**
     * @notice Get the number of pending transfers
     */
    function getPendingTransferCount() external view returns (uint256) {
        return pendingTransfers.length;
    }

    /**
     * @notice Get pending transfer details
     */
    function getPendingTransfer(uint256 index) external view returns (
        address sender,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint64 sequence,
        bool completed
    ) {
        PendingTransfer storage p = pendingTransfers[index];
        return (p.sender, p.amount, p.recipientChain, p.recipient, p.sequence, p.completed);
    }

    /**
     * @notice Withdraw collected fees
     */
    function withdrawFees(address payable to) external {
        (bool success,) = to.call{value: address(this).balance}("");
        require(success, "ETH transfer failed");
    }

    receive() external payable {}
}
