// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/**
 * @title INttManager
 * @notice Interface for Wormhole Native Token Transfer (NTT) Manager
 * @dev Minimal subset of the upstream Wormhole NTT Manager interface — only the
 *      methods used by NttAdapter are declared here.
 *      Taken from https://github.com/wormhole-foundation/native-token-transfers/blob/main/evm/src/interfaces/INttManager.sol
 */
interface INttManager {
    /**
     * @notice Transfer tokens to another chain via Wormhole NTT
     * @param amount Amount to transfer
     * @param recipientChain Target chain ID (Wormhole chain ID)
     * @param recipient Recipient address (32 bytes, Wormhole format)
     * @return messageSequence Wormhole message sequence number
     */
    function transfer(
        uint256 amount,
        uint16 recipientChain,
        bytes32 recipient
    )
        external
        payable
        returns (uint64 messageSequence);

    /**
     * @notice Receive tokens from another chain
     * @param vaa Verified Action Approval (VAA) from Wormhole
     */
    function receiveMessage(bytes memory vaa) external;
}
