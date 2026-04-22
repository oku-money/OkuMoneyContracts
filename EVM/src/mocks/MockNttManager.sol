// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INttManager} from "../bridge/adapters/INttManager.sol";

interface IOkuMoneyMintable {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockNttManager
 * @notice Mock Wormhole NTT Manager used by both Foundry and Hardhat tests.
 * @dev Records transfers and exposes `completeBridge()` to simulate destination chain
 *      mints. Must be granted OKUM_MINTER on OkuMoney (with minter allowance configured)
 *      for `completeBridge*` to succeed.
 *
 *      Real NTT burns tokens inside `transfer()`. In the OkuMoney architecture, the
 *      router burns tokens BEFORE calling the adapter, so this mock never pulls tokens.
 *
 *      No cheatcodes / forge-std dependencies — compiles under Hardhat and Foundry alike.
 */
contract MockNttManager is INttManager {
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

    IOkuMoneyMintable public okuMoney;

    /// @notice Fee required for `transfer()` (defaults to 0). Settable via `setMessageFee`.
    uint256 public messageFee;

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
    error CannotForgeGuardianSignatures();

    constructor(address _okuMoney) {
        okuMoney = IOkuMoneyMintable(_okuMoney);
    }

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
        if (msg.value < messageFee) revert InsufficientFee(messageFee, msg.value);

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

    /// @notice Real NTT validates guardian signatures here. Tests can't forge those, so
    ///         this always reverts. Use `completeBridge()` to simulate a mint.
    function receiveMessage(bytes memory vaa) external override {
        emit MessageReceived(vaa);
        revert CannotForgeGuardianSignatures();
    }

    // ============ Test Helpers ============

    function completeBridge(uint256 index) external {
        if (index >= pendingTransfers.length) revert InvalidTransferIndex();
        PendingTransfer storage p = pendingTransfers[index];
        if (p.completed) revert TransferAlreadyCompleted();
        p.completed = true;

        address recipient = address(uint160(uint256(p.recipient)));
        okuMoney.mint(recipient, p.amount);
        emit TransferCompleted(index, recipient, p.amount);
    }

    function completeBridgeTo(uint256 index, address to) external {
        if (index >= pendingTransfers.length) revert InvalidTransferIndex();
        PendingTransfer storage p = pendingTransfers[index];
        if (p.completed) revert TransferAlreadyCompleted();
        p.completed = true;

        okuMoney.mint(to, p.amount);
        emit TransferCompleted(index, to, p.amount);
    }

    function setMessageFee(uint256 _fee) external {
        messageFee = _fee;
    }

    // ============ Views ============

    function getPendingTransfer(uint256 index) external view returns (PendingTransfer memory) {
        if (index >= pendingTransfers.length) revert InvalidTransferIndex();
        return pendingTransfers[index];
    }

    function getLastTransfer() external view returns (PendingTransfer memory) {
        if (pendingTransfers.length == 0) revert InvalidTransferIndex();
        return pendingTransfers[pendingTransfers.length - 1];
    }

    function pendingTransfersCount() external view returns (uint256) {
        return pendingTransfers.length;
    }
}
