// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {INttManager} from "../../src/bridge/adapters/INttManager.sol";
import {IOkuMoney} from "../../src/interfaces/IOkuMoney.sol";

/// @title MockNttManager
/// @notice Test-only Wormhole NTT Manager mock. NOT FOR PRODUCTION DEPLOYMENT.
/// @dev Records transfers and exposes `completeBridge*` to simulate destination-chain
///      mints. Must be granted OKUM_MINTER on OkuMoney (with minter allowance configured)
///      for `completeBridge*` to succeed.
///
///      Real NTT burns tokens inside `transfer`. In OkuMoney's architecture the router
///      pre-burns, so this mock never pulls tokens. No cheatcodes / forge-std deps —
///      compiles under Hardhat and Foundry alike.
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

    IOkuMoney public okuMoney;

    /// @notice Fee required for `transfer` (defaults to 0). Settable via `setMessageFee`.
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
        okuMoney = IOkuMoney(_okuMoney);
    }

    function transfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient
    )
        external
        payable
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

    /// @dev Real NTT validates guardian signatures here — tests can't forge those, so
    ///      this always reverts. Use `completeBridge` to simulate a mint.
    function receiveMessage(bytes memory vaa) external {
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
