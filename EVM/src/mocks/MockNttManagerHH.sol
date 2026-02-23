// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INttManager} from "../bridge/adapters/INttManager.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IOkuUSDMintable {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockNttManagerHH
 * @notice Hardhat-compatible mock for Wormhole NTT Manager
 * @dev Unlike the Foundry version, this doesn't use vm.prank.
 *      Instead, grant MINTER to this contract for completeBridge() to work.
 *
 * Real NTT flow:
 * 1. Source: transfer() locks/burns tokens, emits Wormhole message
 * 2. Guardians: Sign VAA
 * 3. Destination: receiveMessage() validates VAA, mints tokens
 *
 * Mock flow:
 * 1. transfer() records pending transfer (tokens already burned by router)
 * 2. Test calls completeBridge() to simulate destination mint
 *
 * Note: This mock does NOT pull tokens because in the OkuUSD architecture,
 * the OkuBridgeRouter burns tokens BEFORE calling the adapter.
 */
contract MockNttManagerHH is INttManager {
    struct PendingTransfer {
        address sender;
        uint256 amount;
        uint16 recipientChain;
        bytes32 recipient;
        uint64 sequence;
        uint256 timestamp;
        bool completed;
    }

    PendingTransfer[] public pendingTransfers;
    uint64 private nextSequence;

    IERC20 public token;
    IOkuUSDMintable public okuUsd;

    // Fee configuration
    uint256 public messageFee;

    // Events for testing
    event TransferInitiated(
        address indexed sender,
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient,
        uint64 sequence
    );
    event TransferCompleted(uint256 index, address recipient, uint256 amount);
    event MessageReceived(bytes vaa);

    error InsufficientFee(uint256 required, uint256 provided);
    error InvalidTransferIndex();
    error TransferAlreadyCompleted();

    constructor(address _token, address _okuUsd) {
        token = IERC20(_token);
        okuUsd = IOkuUSDMintable(_okuUsd);
    }

    /**
     * @notice Initiate cross-chain transfer via NTT
     * @param amount Amount to transfer
     * @param recipientChain Wormhole chain ID
     * @param recipient Recipient address (bytes32 format)
     * @return messageSequence Wormhole message sequence number
     */
    function transfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient
    )
        external
        payable
        override
        returns (uint64 messageSequence)
    {
        // Check fee
        if (msg.value < messageFee) {
            revert InsufficientFee(messageFee, msg.value);
        }

        // Note: We don't pull tokens here because in the OkuUSD architecture,
        // the OkuBridgeRouter burns tokens BEFORE calling the adapter.
        // The adapter just emits the cross-chain message.

        // Record pending transfer
        messageSequence = nextSequence++;
        pendingTransfers.push(
            PendingTransfer({
                sender: msg.sender,
                amount: amount,
                recipientChain: recipientChain,
                recipient: recipient,
                sequence: messageSequence,
                timestamp: block.timestamp,
                completed: false
            })
        );

        emit TransferInitiated(msg.sender, amount, recipientChain, recipient, messageSequence);
    }

    /**
     * @notice Receive cross-chain transfer (validates VAA)
     * @dev In real NTT, this validates guardian signatures. Here we just revert.
     */
    function receiveMessage(bytes memory vaa) external override {
        // Cannot simulate real VAA validation in tests
        // Use completeBridge() instead for testing
        emit MessageReceived(vaa);
        revert("Use completeBridge() for testing - cannot forge guardian signatures");
    }

    // ============ Test Helper Functions ============

    /**
     * @notice Simulate destination chain mint
     * @dev This contract must have MINTER on OkuUSD for this to work
     * @param index Index of pending transfer to complete
     */
    function completeBridge(uint256 index) external {
        if (index >= pendingTransfers.length) revert InvalidTransferIndex();
        PendingTransfer storage p = pendingTransfers[index];
        if (p.completed) revert TransferAlreadyCompleted();

        p.completed = true;

        // Convert bytes32 back to address
        address recipient = address(uint160(uint256(p.recipient)));

        // Mint OkuUSD on destination
        // NOTE: This contract must have MINTER granted
        okuUsd.mint(recipient, p.amount);

        emit TransferCompleted(index, recipient, p.amount);
    }

    /**
     * @notice Simulate destination chain mint to different recipient
     * @param index Index of pending transfer
     * @param to Override recipient address
     */
    function completeBridgeTo(uint256 index, address to) external {
        if (index >= pendingTransfers.length) revert InvalidTransferIndex();
        PendingTransfer storage p = pendingTransfers[index];
        if (p.completed) revert TransferAlreadyCompleted();

        p.completed = true;

        okuUsd.mint(to, p.amount);

        emit TransferCompleted(index, to, p.amount);
    }

    /**
     * @notice Set message fee for testing fee handling
     */
    function setMessageFee(uint256 _fee) external {
        messageFee = _fee;
    }

    // ============ View Functions ============

    function getPendingTransfer(uint256 index) external view returns (PendingTransfer memory) {
        if (index >= pendingTransfers.length) revert InvalidTransferIndex();
        return pendingTransfers[index];
    }

    function pendingTransfersCount() external view returns (uint256) {
        return pendingTransfers.length;
    }

    function getLastTransfer() external view returns (PendingTransfer memory) {
        require(pendingTransfers.length > 0, "No pending transfers");
        return pendingTransfers[pendingTransfers.length - 1];
    }

    /**
     * @notice Convert bytes32 recipient to address for testing
     */
    function recipientToAddress(bytes32 recipient) external pure returns (address) {
        return address(uint160(uint256(recipient)));
    }

    /**
     * @notice Convert address to bytes32 for testing
     */
    function addressToRecipient(address addr) external pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}
