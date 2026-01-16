// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IOFTAdapter} from "../adapters/IOFTAdapter.sol";

/**
 * @title IBridgeToken
 * @notice Interface for the BridgeToken contract
 */
interface IBridgeToken {
    function mint(address to, uint256 amount) external;
}

/**
 * @title MockOFTAdapter
 * @notice Mock LayerZero OFT Adapter for local testing
 * @dev Simulates cross-chain transfer flow without actual LayerZero network
 */
contract MockOFTAdapter is IOFTAdapter {
    struct PendingTransfer {
        address sender;
        uint256 amount;
        uint32 dstEid;
        bytes32 recipient;
        bool completed;
    }

    address public bridgeAdapter;
    IBridgeToken public token;
    uint256 public baseFee;

    PendingTransfer[] public pendingTransfers;

    // Events
    event SendInitiated(
        address indexed sender,
        uint32 dstEid,
        bytes32 recipient,
        uint256 amount
    );
    event TransferCompleted(uint256 indexed index, address recipient, uint256 amount);

    // Errors
    error InsufficientFee(uint256 required, uint256 provided);
    error TransferAlreadyCompleted();
    error InvalidIndex();

    constructor(address _token) {
        token = IBridgeToken(_token);
        baseFee = 0.001 ether; // Default mock fee
    }

    /**
     * @notice Set the bridge adapter address for minting on completion
     */
    function setBridgeAdapter(address _adapter) external {
        bridgeAdapter = _adapter;
    }

    /**
     * @notice Set the mock base fee
     */
    function setBaseFee(uint256 _fee) external {
        baseFee = _fee;
    }

    /**
     * @notice Quote the fee for sending tokens
     */
    function quoteSend(
        SendParam calldata,
        bool
    ) external view override returns (MessagingFee memory fee) {
        return MessagingFee({
            nativeFee: baseFee,
            lzTokenFee: 0
        });
    }

    /**
     * @notice Simulate sending tokens via LayerZero
     */
    function send(
        SendParam calldata sendParam,
        MessagingFee calldata fee,
        address
    ) external payable override returns (bytes memory msgReceipt, bytes memory oftReceipt) {
        if (msg.value < baseFee) {
            revert InsufficientFee(baseFee, msg.value);
        }

        pendingTransfers.push(PendingTransfer({
            sender: msg.sender,
            amount: sendParam.amountLD,
            dstEid: sendParam.dstEid,
            recipient: sendParam.to,
            completed: false
        }));

        emit SendInitiated(msg.sender, sendParam.dstEid, sendParam.to, sendParam.amountLD);

        // Return mock receipts
        msgReceipt = abi.encode(pendingTransfers.length - 1);
        oftReceipt = abi.encode(sendParam.amountLD);
    }

    /**
     * @notice Complete a pending bridge transfer (simulate destination chain mint)
     * @dev For testing: simulates receiving LZ message and minting on destination
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
        uint32 dstEid,
        bytes32 recipient,
        bool completed
    ) {
        PendingTransfer storage p = pendingTransfers[index];
        return (p.sender, p.amount, p.dstEid, p.recipient, p.completed);
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
