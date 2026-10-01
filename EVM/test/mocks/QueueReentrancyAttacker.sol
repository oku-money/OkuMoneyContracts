// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title QueueReentrancyAttacker
/// @notice Test-only contract: a `RedemptionQueue` entry's `user`, which {MockCallbackUSDC}
///         calls back into mid-`transferFrom`. Reenters `advanceHead` to attempt stranding
///         its own (or another) entry below `queueHead` while `processQueue` has transiently
///         deleted it. See `test/psm/Reentrancy.t.sol`.
interface IAdvanceHead {
    function advanceHead(uint256 maxSlots) external returns (uint256);
}

contract QueueReentrancyAttacker {
    IAdvanceHead public immutable queue;
    uint256 public immutable maxSlots;
    bool public callbackFired;
    bool public advanceHeadSucceeded;

    constructor(address _queue, uint256 _maxSlots) {
        queue = IAdvanceHead(_queue);
        maxSlots = _maxSlots;
    }

    /// @dev Invoked by {MockCallbackUSDC} on a `transferFrom` targeting this contract.
    ///      Does not propagate failure to the caller — mirrors a real hostile token's
    ///      own unchecked low-level call into here.
    function onTransferAttempt() external {
        callbackFired = true;
        try queue.advanceHead(maxSlots) returns (uint256) {
            advanceHeadSucceeded = true;
        } catch {
            advanceHeadSucceeded = false;
        }
    }
}
