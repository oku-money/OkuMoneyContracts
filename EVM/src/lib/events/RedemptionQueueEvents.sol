// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title RedemptionQueueEvents
 * @notice Event declarations for the RedemptionQueue contract.
 * @dev Inherited by RedemptionQueue; see OkuMoneyEvents for the rationale.
 */
abstract contract RedemptionQueueEvents {
    /// @notice Reasons why processQueue may skip an entry instead of processing it.
    enum RedemptionSkipReason {
        AlreadyCleared, // Entry already processed or rescued
        InsufficientFunds, // Not enough USDC to process this entry
        TransferFailed // USDC transfer to recipient reverted (e.g., blacklisted ATA); use rescueQueueEntry
    }

    /// @notice Emitted when a redemption is added to the queue
    event RedemptionQueued(
        address indexed user,
        uint256 okuMAmount,
        uint256 dollarValue,
        uint256 position,
        uint256 queueLength
    );

    /// @notice Emitted when a queued redemption is processed
    event RedemptionProcessed(
        address indexed user,
        uint256 okuMAmount,
        uint256 dollarValue,
        uint256 usdcAmount,
        uint256 waitTime
    );

    /// @notice Emitted when processQueue skips a cleared/rescued entry
    event RedemptionSkipped(uint256 indexed index, RedemptionSkipReason reason);

    /// @notice Emitted when QUEUE_RESCUER returns OkuMoney for a stuck entry
    event RedemptionRescued(
        uint256 indexed index,
        address indexed originalUser,
        address indexed recipient,
        uint256 okuMAmount,
        uint256 dollarValue
    );

    /// @notice Emitted when `advanceHead` skips one or more cleared slots.
    /// @param newHead New value of `queueHead` after the advance.
    /// @param slotsAdvanced Number of cleared slots skipped in this call.
    event QueueHeadAdvanced(uint256 newHead, uint256 slotsAdvanced);
}
