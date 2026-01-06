// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";

/**
 * @title RedemptionQueueTest
 * @notice Unit tests for RedemptionQueue
 * @dev KNOWN BUG: Queue stores okuUSDAmount (tokens) instead of shares.
 *      Per CLAUDE.md spec, users should earn yield while waiting.
 *      Current implementation does NOT provide yield to queued users.
 */
contract RedemptionQueueTest is BaseTest {
    // ============ Events ============

    event RedemptionQueued(address indexed user, uint256 okuUSDAmount, uint256 position);
    event RedemptionProcessed(address indexed user, uint256 okuUSDAmount, uint256 usdcAmount);

    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Setup: grant PSM_ROLE to a test address for direct testing
        vm.prank(admin);
        redemptionQueue.grantRole(PSM_ROLE, address(this));

        // Mint OkuUSD to users
        _mintOkuUSD(user1, 1000e18);
        _mintOkuUSD(user2, 1000e18);
        _mintOkuUSD(user3, 1000e18);
    }

    // ============ Enqueue Tests ============

    function test_Enqueue_OnlyPSMRole() public {
        _approveOkuUSD(user1, address(redemptionQueue), 100e18);

        vm.prank(user1);
        vm.expectRevert();
        redemptionQueue.enqueue(user1, 100e18);
    }

    function test_Enqueue_TransfersOkuUSD() public {
        uint256 amount = 100e18;
        _approveOkuUSD(user1, address(redemptionQueue), amount);

        uint256 user1BalanceBefore = okuUSD.balanceOf(user1);
        uint256 queueBalanceBefore = okuUSD.balanceOf(address(redemptionQueue));

        redemptionQueue.enqueue(user1, amount);

        assertEq(okuUSD.balanceOf(user1), user1BalanceBefore - amount);
        assertEq(okuUSD.balanceOf(address(redemptionQueue)), queueBalanceBefore + amount);
    }

    function test_Enqueue_StoresEntry() public {
        uint256 amount = 100e18;
        _approveOkuUSD(user1, address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(0);
        assertEq(entry.user, user1);
        assertEq(entry.okuUSDAmount, amount);
        assertGt(entry.timestamp, 0);
    }

    function test_Enqueue_IncrementsQueueLength() public {
        assertEq(redemptionQueue.queueLength(), 0);

        _approveOkuUSD(user1, address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);

        assertEq(redemptionQueue.queueLength(), 1);

        _approveOkuUSD(user2, address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueLength(), 2);
    }

    function test_Enqueue_EmitsEvent() public {
        uint256 amount = 100e18;
        _approveOkuUSD(user1, address(redemptionQueue), amount);

        vm.expectEmit(true, false, false, true);
        emit RedemptionQueued(user1, amount, 0);

        redemptionQueue.enqueue(user1, amount);
    }

    function test_Enqueue_MultipleEntries() public {
        _approveOkuUSD(user1, address(redemptionQueue), 100e18);
        _approveOkuUSD(user2, address(redemptionQueue), 200e18);
        _approveOkuUSD(user3, address(redemptionQueue), 300e18);

        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 200e18);
        redemptionQueue.enqueue(user3, 300e18);

        assertEq(redemptionQueue.queueLength(), 3);

        // Verify order
        assertEq(redemptionQueue.getQueueEntry(0).user, user1);
        assertEq(redemptionQueue.getQueueEntry(1).user, user2);
        assertEq(redemptionQueue.getQueueEntry(2).user, user3);
    }

    // ============ ProcessQueue Tests ============

    function test_ProcessQueue_OnlyPSMRole() public {
        vm.prank(user1);
        vm.expectRevert();
        redemptionQueue.processQueue(10, address(usdc), address(okuUSD));
    }

    function test_ProcessQueue_BurnsOkuUSD() public {
        uint256 amount = 100e18;
        _approveOkuUSD(user1, address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        uint256 queueBalanceBefore = okuUSD.balanceOf(address(redemptionQueue));

        // Setup: give queue minter role to burn
        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));

        // Setup: approve USDC for transfer
        _mintUSDC(address(this), amount);
        _approveUSDC(address(this), address(redemptionQueue), amount);

        redemptionQueue.processQueue(10, address(usdc), address(okuUSD));

        assertEq(okuUSD.balanceOf(address(redemptionQueue)), queueBalanceBefore - amount);
    }

    function test_ProcessQueue_TransfersUSDC() public {
        uint256 amount = 100e18;
        _approveOkuUSD(user1, address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        // Setup
        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));

        _mintUSDC(address(this), amount);
        _approveUSDC(address(this), address(redemptionQueue), amount);

        uint256 user1USDCBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(10, address(usdc), address(okuUSD));

        assertEq(usdc.balanceOf(user1), user1USDCBefore + amount);
    }

    function test_ProcessQueue_AdvancesQueueHead() public {
        _approveOkuUSD(user1, address(redemptionQueue), 100e18);
        _approveOkuUSD(user2, address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueLength(), 2);

        // Setup
        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));

        _mintUSDC(address(this), 100e18);
        _approveUSDC(address(this), address(redemptionQueue), 100e18);

        // Process only 1 entry
        redemptionQueue.processQueue(1, address(usdc), address(okuUSD));

        // Queue head should advance, length decreases
        assertEq(redemptionQueue.queueLength(), 1);

        // First entry should now be invalid
        vm.expectRevert("Invalid index");
        redemptionQueue.getQueueEntry(0);
    }

    function test_ProcessQueue_RespectsMaxEntries() public {
        _approveOkuUSD(user1, address(redemptionQueue), 100e18);
        _approveOkuUSD(user2, address(redemptionQueue), 100e18);
        _approveOkuUSD(user3, address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);
        redemptionQueue.enqueue(user3, 100e18);

        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));

        _mintUSDC(address(this), 300e18);
        _approveUSDC(address(this), address(redemptionQueue), 300e18);

        // Process only 2 entries
        redemptionQueue.processQueue(2, address(usdc), address(okuUSD));

        // Should have 1 entry left
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_ProcessQueue_StopsWhenBufferDepleted() public {
        _approveOkuUSD(user1, address(redemptionQueue), 100e18);
        _approveOkuUSD(user2, address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));

        // Only provide enough USDC for 1 entry
        _mintUSDC(address(this), 100e18);
        _approveUSDC(address(this), address(redemptionQueue), 100e18);

        redemptionQueue.processQueue(10, address(usdc), address(okuUSD));

        // Should have processed only 1
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_ProcessQueue_EmitsEvent() public {
        uint256 amount = 100e18;
        _approveOkuUSD(user1, address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));

        _mintUSDC(address(this), amount);
        _approveUSDC(address(this), address(redemptionQueue), amount);

        vm.expectEmit(true, false, false, true);
        emit RedemptionProcessed(user1, amount, amount);

        redemptionQueue.processQueue(10, address(usdc), address(okuUSD));
    }

    function test_ProcessQueue_FIFO_Order() public {
        // Enqueue in order: user1, user2, user3
        _approveOkuUSD(user1, address(redemptionQueue), 100e18);
        _approveOkuUSD(user2, address(redemptionQueue), 200e18);
        _approveOkuUSD(user3, address(redemptionQueue), 300e18);

        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 200e18);
        redemptionQueue.enqueue(user3, 300e18);

        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));

        // Only provide enough for first entry
        _mintUSDC(address(this), 100e18);
        _approveUSDC(address(this), address(redemptionQueue), 100e18);

        uint256 user1USDCBefore = usdc.balanceOf(user1);
        uint256 user2USDCBefore = usdc.balanceOf(user2);

        redemptionQueue.processQueue(10, address(usdc), address(okuUSD));

        // Only user1 (first in queue) should receive USDC
        assertEq(usdc.balanceOf(user1), user1USDCBefore + 100e18);
        assertEq(usdc.balanceOf(user2), user2USDCBefore); // Unchanged
    }

    // ============ View Function Tests ============

    function test_QueueLength_ReturnsUnprocessed() public {
        _approveOkuUSD(user1, address(redemptionQueue), 100e18);
        _approveOkuUSD(user2, address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueLength(), 2);

        // Process one
        vm.prank(admin);
        okuUSD.grantRole(MINTER_ROLE, address(redemptionQueue));
        _mintUSDC(address(this), 100e18);
        _approveUSDC(address(this), address(redemptionQueue), 100e18);
        redemptionQueue.processQueue(1, address(usdc), address(okuUSD));

        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_GetQueueEntry_RevertsInvalidIndex() public {
        vm.expectRevert("Invalid index");
        redemptionQueue.getQueueEntry(0);
    }

    // ============ KNOWN BUG DOCUMENTATION TEST ============

    /**
     * @notice Documents that current implementation stores tokens, not shares
     * @dev Per CLAUDE.md spec, queue should store SHARES so users earn yield while waiting.
     *      Current implementation stores okuUSDAmount (tokens), meaning users do NOT
     *      earn yield on queued redemptions.
     *
     * Expected behavior (per spec):
     *   - Queue entry stores shares, not token amount
     *   - When processing, payout = lockedShares × currentMultiplier
     *   - User earns yield while waiting in queue
     *
     * Actual behavior (current implementation):
     *   - Queue entry stores okuUSDAmount (tokens)
     *   - When processing, payout = stored okuUSDAmount (1:1)
     *   - User does NOT earn yield while in queue
     */
    function test_BUG_QueueStoresTokensNotShares() public {
        uint256 amount = 100e18;
        _approveOkuUSD(user1, address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        // Get the stored entry
        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(0);

        // BUG: Entry stores okuUSDAmount, not shares
        // This field is called "okuUSDAmount" which is TOKEN amount, not shares
        assertEq(entry.okuUSDAmount, amount);

        // Now if we rebase, the queued user should earn yield (per spec)
        // But they won't because we stored tokens not shares

        vm.prank(admin);
        okuUSD.updateRewardMultiplier(PRECISION * 2); // 2x rebase

        // The entry still shows the same token amount (doesn't reflect rebase)
        RedemptionQueue.QueueEntry memory entryAfterRebase = redemptionQueue.getQueueEntry(0);
        assertEq(entryAfterRebase.okuUSDAmount, amount); // Still 100e18, not 200e18

        // This is a BUG - per spec, users should earn yield while queued
        // To fix: store shares and convert to tokens at processing time
    }
}
