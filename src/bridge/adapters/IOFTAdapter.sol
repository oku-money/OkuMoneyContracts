// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title IOFTAdapter
 * @notice Interface for LayerZero Omnichain Fungible Token (OFT) Adapter
 */
interface IOFTAdapter {
    struct SendParam {
        uint32 dstEid; // Destination endpoint ID
        bytes32 to; // Recipient address in bytes32 format
        uint256 amountLD; // Amount in local decimals
        uint256 minAmountLD; // Minimum amount to receive
        bytes extraOptions; // Additional options
        bytes composeMsg; // Composed message for other operations
        bytes oftCmd; // OFT command
    }

    struct MessagingFee {
        uint256 nativeFee; // Native token fee
        uint256 lzTokenFee; // LayerZero token fee
    }

    /**
     * @notice Send tokens to another chain via LayerZero
     * @param sendParam Send parameters
     * @param fee Messaging fee
     * @param refundAddress Address to receive refund
     * @return msgReceipt Message receipt
     * @return oftReceipt OFT receipt
     */
    function send(
        SendParam calldata sendParam,
        MessagingFee calldata fee,
        address refundAddress
    )
        external
        payable
        returns (bytes memory msgReceipt, bytes memory oftReceipt);

    /**
     * @notice Quote the fee for sending tokens
     * @param sendParam Send parameters
     * @param payInLzToken Whether to pay in LZ token
     * @return fee Messaging fee
     */
    function quoteSend(
        SendParam calldata sendParam,
        bool payInLzToken
    )
        external
        view
        returns (MessagingFee memory fee);
}
