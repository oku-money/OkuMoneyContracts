// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @title RedemptionQueueTest
 * @notice Unit tests for RedemptionQueue
 * @dev Queue stores shares so users earn yield while waiting (per CLAUDE.md spec).
 *      enqueue() is record-only; the PSM transfers tokens into the queue before calling it.
 *      Tests simulate this by calling _mintOkuUsd(address(redemptionQueue), amount) first.
 */
contract RedemptionQueueTest is BaseTest {
    // Decimal conversion constant
    uint256 private constant DECIMAL_MULTIPLIER = 10 ** 12; // OkuUSD (18) - USDC (6) = 12

    // ============ Events ============

    event RedemptionQueued(
        address indexed user, uint256 shares, uint256 okuUsdAmount, uint256 position
    );
    event RedemptionProcessed(
        address indexed user, uint256 shares, uint256 okuUsdAmount, uint256 usdcAmount
    );

    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Setup: grant PSM to a test address for direct testing
        vm.prank(admin);
        redemptionQueue.grantRole(PSM, address(this));

        // Mint OkuUSD to users
        _mintOkuUsd(user1, 1000e18);
        _mintOkuUsd(user2, 1000e18);
        _mintOkuUsd(user3, 1000e18);
    }

    // ============ Enqueue Tests ============

    function test_Enqueue_OnlyPSMRole() public {
        // No pre-funding needed — test reverts on RBAC before any token ops
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM));
        redemptionQueue.enqueue(user1, 100e18);
    }

    function test_Enqueue_TransfersOkuUSD() public {
        uint256 amount = 100e18;
        // Pre-fund queue (simulating PSM already moved tokens there)
        _mintOkuUsd(address(redemptionQueue), amount);

        uint256 user1BalanceBefore = okuUsd.balanceOf(user1);
        uint256 queueBalanceBefore = okuUsd.balanceOf(address(redemptionQueue));

        // enqueue is now record-only — tokens already in queue
        redemptionQueue.enqueue(user1, amount);

        // user1 balance unchanged (no transfer from user)
        assertEq(okuUsd.balanceOf(user1), user1BalanceBefore);
        // queue balance unchanged (tokens were pre-funded, enqueue doesn't move them)
        assertEq(okuUsd.balanceOf(address(redemptionQueue)), queueBalanceBefore);
    }

    function test_Enqueue_DoesNotTransferFromUser() public {
        uint256 amount = 100e18;
        uint256 user1BalanceBefore = okuUsd.balanceOf(user1);

        // Call enqueue without pre-funding — record-only, no transferFrom
        redemptionQueue.enqueue(user1, amount);

        // user1 balance completely unchanged
        assertEq(okuUsd.balanceOf(user1), user1BalanceBefore);
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_Enqueue_StoresEntry() public {
        uint256 amount = 100e18;
        _mintOkuUsd(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(0);
        assertEq(entry.user, user1);
        // At 1x multiplier, shares == tokens
        assertEq(entry.shares, _tokensToShares(amount));
        assertEq(entry.timestamp, block.timestamp);
    }

    function test_Enqueue_IncrementsQueueLength() public {
        assertEq(redemptionQueue.queueLength(), 0);

        _mintOkuUsd(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);

        assertEq(redemptionQueue.queueLength(), 1);

        _mintOkuUsd(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueLength(), 2);
    }

    function test_Enqueue_EmitsEvent() public {
        uint256 amount = 100e18;
        _mintOkuUsd(address(redemptionQueue), amount);

        // At 1x multiplier, shares == tokens
        uint256 expectedShares = _tokensToShares(amount);

        vm.expectEmit(true, false, false, true);
        emit RedemptionQueued(user1, expectedShares, amount, 0);

        redemptionQueue.enqueue(user1, amount);
    }

    function test_Enqueue_MultipleEntries() public {
        _mintOkuUsd(address(redemptionQueue), 100e18);
        _mintOkuUsd(address(redemptionQueue), 200e18);
        _mintOkuUsd(address(redemptionQueue), 300e18);

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
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM));
        redemptionQueue.processQueue(10, address(usdc), address(okuUsd));
    }

    function test_ProcessQueue_BurnsOkuUSD() public {
        uint256 amount = 100e18;
        _mintOkuUsd(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        uint256 queueBalanceBefore = okuUsd.balanceOf(address(redemptionQueue));

        // Setup: give queue minter role to burn
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        // Setup: approve USDC for transfer (convert 18-decimal OkuUSD amount to 6-decimal USDC)
        uint256 usdcAmount = amount / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        redemptionQueue.processQueue(10, address(usdc), address(okuUsd));

        assertEq(okuUsd.balanceOf(address(redemptionQueue)), queueBalanceBefore - amount);
    }

    function test_ProcessQueue_TransfersUSDC() public {
        uint256 okuUsdAmount = 100e18; // 100 OkuUSD
        uint256 usdcAmount = 100e6; // 100 USDC (6 decimals)

        _mintOkuUsd(address(redemptionQueue), okuUsdAmount);
        redemptionQueue.enqueue(user1, okuUsdAmount);

        // Setup
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(10, address(usdc), address(okuUsd));

        // User should receive USDC (6 decimals), not OkuUSD amount (18 decimals)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + usdcAmount);
    }

    function test_ProcessQueue_AdvancesQueueHead() public {
        _mintOkuUsd(address(redemptionQueue), 100e18);
        _mintOkuUsd(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueLength(), 2);

        // Setup
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        // Process only 1 entry
        redemptionQueue.processQueue(1, address(usdc), address(okuUsd));

        // Queue head should advance, length decreases
        assertEq(redemptionQueue.queueLength(), 1);

        // First entry should now be invalid
        vm.expectRevert("Invalid index");
        redemptionQueue.getQueueEntry(0);
    }

    function test_ProcessQueue_RespectsMaxEntries() public {
        _mintOkuUsd(address(redemptionQueue), 100e18);
        _mintOkuUsd(address(redemptionQueue), 100e18);
        _mintOkuUsd(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);
        redemptionQueue.enqueue(user3, 100e18);

        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), 300e6); // 300 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 300e6);

        // Process only 2 entries
        redemptionQueue.processQueue(2, address(usdc), address(okuUsd));

        // Should have 1 entry left
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_ProcessQueue_StopsWhenBufferDepleted() public {
        _mintOkuUsd(address(redemptionQueue), 100e18);
        _mintOkuUsd(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        // Only provide enough USDC for 1 entry
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        redemptionQueue.processQueue(10, address(usdc), address(okuUsd));

        // Should have processed only 1
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_ProcessQueue_EmitsEvent() public {
        uint256 okuUsdAmount = 100e18; // 100 OkuUSD
        uint256 usdcAmount = 100e6; // 100 USDC

        _mintOkuUsd(address(redemptionQueue), okuUsdAmount);
        redemptionQueue.enqueue(user1, okuUsdAmount);

        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        // At 1x multiplier, shares == tokens
        uint256 expectedShares = _tokensToShares(okuUsdAmount);

        vm.expectEmit(true, false, false, true);
        emit RedemptionProcessed(user1, expectedShares, okuUsdAmount, usdcAmount);

        redemptionQueue.processQueue(10, address(usdc), address(okuUsd));
    }

    function test_ProcessQueue_FIFO_Order() public {
        // Enqueue in order: user1, user2, user3
        _mintOkuUsd(address(redemptionQueue), 100e18);
        _mintOkuUsd(address(redemptionQueue), 200e18);
        _mintOkuUsd(address(redemptionQueue), 300e18);

        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 200e18);
        redemptionQueue.enqueue(user3, 300e18);

        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        // Only provide enough for first entry
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 user2UsdcBefore = usdc.balanceOf(user2);

        redemptionQueue.processQueue(10, address(usdc), address(okuUsd));

        // Only user1 (first in queue) should receive 100 USDC (6 decimals)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 100e6);
        assertEq(usdc.balanceOf(user2), user2UsdcBefore); // Unchanged
    }

    // ============ View Function Tests ============

    function test_QueueLength_ReturnsUnprocessed() public {
        _mintOkuUsd(address(redemptionQueue), 100e18);
        _mintOkuUsd(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueLength(), 2);

        // Process one
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);
        redemptionQueue.processQueue(1, address(usdc), address(okuUsd));

        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_GetQueueEntry_RevertsInvalidIndex() public {
        vm.expectRevert("Invalid index");
        redemptionQueue.getQueueEntry(0);
    }

    // ============ Yield Accrual Tests ============

    /**
     * @notice Verifies that users earn yield while waiting in queue
     * @dev Per CLAUDE.md spec: queue stores shares so users earn yield while waiting
     */
    function test_QueueStoresShares_YieldAccrues() public {
        uint256 amount = 100e18;
        _mintOkuUsd(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        // Get the stored entry - should store shares
        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(0);

        // At 1x multiplier, shares == tokens
        assertEq(entry.shares, amount);

        // Now rebase - user should earn yield
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2); // 2x rebase

        // The stored shares remain the same
        RedemptionQueue.QueueEntry memory entryAfterRebase = redemptionQueue.getQueueEntry(0);
        assertEq(entryAfterRebase.shares, amount); // Still 100e18 shares

        // But the VALUE has doubled via getQueueEntryValue()
        uint256 currentValue = redemptionQueue.getQueueEntryValue(0);
        assertEq(currentValue, amount * 2); // 200e18 tokens

        // Process queue and verify user receives the increased amount
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        // Need 200 USDC (6 decimals) now to match 200 OkuUSD value
        _mintUsdc(address(this), 200e6); // 200 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 200e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(10, address(usdc), address(okuUsd));

        // User should receive 200 USDC (6 decimals) - earned 100% yield
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 200e6);
    }

    /**
     * @notice Verifies yield accrual with multiple users in queue
     */
    function test_QueueYieldAccrual_MultipleUsers() public {
        // User1 and User2 both queue 100e18
        _mintOkuUsd(address(redemptionQueue), 100e18);
        _mintOkuUsd(address(redemptionQueue), 100e18);

        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        // Rebase 50%
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 3 / 2); // 1.5x

        // Both should now be worth 150e18
        assertEq(redemptionQueue.getQueueEntryValue(0), 150e18);
        assertEq(redemptionQueue.getQueueEntryValue(1), 150e18);

        // Setup for processing
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), 300e6); // 300 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 300e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 user2UsdcBefore = usdc.balanceOf(user2);

        redemptionQueue.processQueue(10, address(usdc), address(okuUsd));

        // Both users receive 150 USDC (6 decimals)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 150e6);
        assertEq(usdc.balanceOf(user2), user2UsdcBefore + 150e6);
    }

    /**
     * @notice Verifies that getQueueEntryValue returns correct current value
     */
    function test_GetQueueEntryValue_ReflectsCurrentMultiplier() public {
        uint256 amount = 100e18;
        _mintOkuUsd(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        // Initially value equals original amount
        assertEq(redemptionQueue.getQueueEntryValue(0), amount);

        // After 2x rebase
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 2);
        assertEq(redemptionQueue.getQueueEntryValue(0), amount * 2);

        // After another 1.5x rebase (total 3x)
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(PRECISION * 3);
        assertEq(redemptionQueue.getQueueEntryValue(0), amount * 3);
    }

    // ============ Fuzz Tests for Yield Accrual ============

    /**
     * @notice Fuzz test: User earns correct yield while queued
     */
    function testFuzz_QueueYieldAccrual(uint256 amount, uint256 multiplierIncrease) public {
        // Bound inputs to reasonable ranges
        amount = bound(amount, 1e18, 1_000_000e18);
        multiplierIncrease = bound(multiplierIncrease, 0, PRECISION * 9); // Up to 10x total

        _mintOkuUsd(user1, amount);
        _mintOkuUsd(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        // Record initial shares
        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(0);
        uint256 initialShares = entry.shares;

        // Rebase
        uint256 newMultiplier = PRECISION + multiplierIncrease;
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // Verify shares unchanged
        RedemptionQueue.QueueEntry memory entryAfter = redemptionQueue.getQueueEntry(0);
        assertEq(entryAfter.shares, initialShares, "Shares should not change after rebase");

        // Verify value increased correctly
        uint256 expectedValue = (initialShares * newMultiplier) / PRECISION;
        uint256 actualValue = redemptionQueue.getQueueEntryValue(0);
        assertEq(actualValue, expectedValue, "Value should reflect new multiplier");
    }

    /**
     * @notice Fuzz test: User receives correct USDC payout after yield
     */
    function testFuzz_QueuePayoutAfterYield(uint256 amount, uint256 multiplierIncrease) public {
        // Bound inputs
        amount = bound(amount, 1e18, 100_000e18);
        multiplierIncrease = bound(multiplierIncrease, PRECISION / 100, PRECISION * 4); // 1% to 5x

        _mintOkuUsd(user1, amount);
        _mintOkuUsd(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        // Rebase
        uint256 newMultiplier = PRECISION + multiplierIncrease;
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // Calculate expected payout (in OkuUSD - 18 decimals)
        uint256 expectedPayoutOkuUsd = redemptionQueue.getQueueEntryValue(0);
        // Convert to USDC (6 decimals)
        uint256 expectedPayoutUsdc = expectedPayoutOkuUsd / DECIMAL_MULTIPLIER;

        // Setup for processing
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), expectedPayoutUsdc);
        _approveUsdc(address(this), address(redemptionQueue), expectedPayoutUsdc);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(10, address(usdc), address(okuUsd));

        // User should receive exact expected payout (in USDC - 6 decimals)
        assertEq(
            usdc.balanceOf(user1),
            user1UsdcBefore + expectedPayoutUsdc,
            "User should receive full yield"
        );
        assertEq(redemptionQueue.queueLength(), 0, "Queue should be empty");
    }

    /**
     * @notice Fuzz test: Multiple rebases compound correctly
     */
    function testFuzz_MultipleRebasesCompound(
        uint256 amount,
        uint256 rebase1,
        uint256 rebase2
    )
        public
    {
        amount = bound(amount, 1e18, 100_000e18);
        rebase1 = bound(rebase1, PRECISION / 100, PRECISION); // 1% to 100% increase
        rebase2 = bound(rebase2, PRECISION / 100, PRECISION); // 1% to 100% increase

        _mintOkuUsd(user1, amount);
        _mintOkuUsd(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        uint256 initialShares = redemptionQueue.getQueueEntry(0).shares;

        // First rebase
        uint256 multiplier1 = PRECISION + rebase1;
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(multiplier1);

        // Second rebase
        uint256 multiplier2 = multiplier1 + rebase2;
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(multiplier2);

        // Final value should be shares * finalMultiplier / PRECISION
        uint256 expectedValue = (initialShares * multiplier2) / PRECISION;
        uint256 actualValue = redemptionQueue.getQueueEntryValue(0);

        assertEq(actualValue, expectedValue, "Multiple rebases should compound correctly");
    }

    // ============ FIFO Ordering Fuzz Tests ============

    /**
     * @notice Fuzz test: Multiple users processed in FIFO order
     * @dev Creates dynamic array of users, queues them, processes all, verifies order
     */
    function testFuzz_FIFO_MultipleUsers(uint256 numUsers, uint256 baseSeed) public {
        numUsers = bound(numUsers, 2, 20); // 2-20 users

        // Create dynamic user array
        address[] memory users = new address[](numUsers);
        uint256[] memory amounts = new uint256[](numUsers);
        uint256[] memory initialBalances = new uint256[](numUsers);
        uint256 totalNeeded = 0;

        for (uint256 i = 0; i < numUsers; i++) {
            users[i] = makeAddr(string(abi.encodePacked("queueUser", i)));
            // Each user gets a different amount based on seed
            amounts[i] = bound(uint256(keccak256(abi.encode(baseSeed, i))), 1e18, 10_000e18);

            // Pre-fund queue (simulating PSM moving tokens before enqueue)
            _mintOkuUsd(address(redemptionQueue), amounts[i]);

            // Enqueue
            redemptionQueue.enqueue(users[i], amounts[i]);

            initialBalances[i] = usdc.balanceOf(users[i]);
            totalNeeded += amounts[i];
        }

        // Verify queue length
        assertEq(redemptionQueue.queueLength(), numUsers, "Queue should have all users");

        // Setup for processing - convert OkuUSD amounts to USDC
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        uint256 totalNeededUsdc = totalNeeded / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), totalNeededUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalNeededUsdc);

        // Process all
        redemptionQueue.processQueue(numUsers, address(usdc), address(okuUsd));

        // Verify all processed in order (each received their amount in USDC)
        assertEq(redemptionQueue.queueLength(), 0, "Queue should be empty");

        for (uint256 i = 0; i < numUsers; i++) {
            uint256 expectedUsdc = amounts[i] / DECIMAL_MULTIPLIER;
            assertEq(
                usdc.balanceOf(users[i]),
                initialBalances[i] + expectedUsdc,
                string(abi.encodePacked("User ", i, " should receive correct amount"))
            );
        }
    }

    /**
     * @notice Fuzz test: Partial processing respects FIFO order
     * @dev Queues multiple users, processes only a subset, verifies first N get paid
     */
    function testFuzz_FIFO_PartialProcessing(
        uint256 numUsers,
        uint256 numToProcess,
        uint256 baseSeed
    )
        public
    {
        numUsers = bound(numUsers, 3, 15);
        numToProcess = bound(numToProcess, 1, numUsers - 1); // Process less than all

        address[] memory users = new address[](numUsers);
        uint256[] memory amounts = new uint256[](numUsers);
        uint256[] memory initialBalances = new uint256[](numUsers);
        uint256 totalForProcessed = 0;

        for (uint256 i = 0; i < numUsers; i++) {
            users[i] = makeAddr(string(abi.encodePacked("partialUser", i)));
            amounts[i] = bound(uint256(keccak256(abi.encode(baseSeed, i))), 1e18, 5000e18);

            _mintOkuUsd(address(redemptionQueue), amounts[i]);
            redemptionQueue.enqueue(users[i], amounts[i]);

            initialBalances[i] = usdc.balanceOf(users[i]);

            if (i < numToProcess) {
                totalForProcessed += amounts[i];
            }
        }

        // Setup - only provide enough USDC for the ones we'll process
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        uint256 totalForProcessedUsdc = totalForProcessed / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), totalForProcessedUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalForProcessedUsdc);

        // Process only numToProcess
        redemptionQueue.processQueue(numToProcess, address(usdc), address(okuUsd));

        // Verify: first numToProcess users got paid, rest didn't
        assertEq(
            redemptionQueue.queueLength(),
            numUsers - numToProcess,
            "Remaining queue length incorrect"
        );

        for (uint256 i = 0; i < numUsers; i++) {
            if (i < numToProcess) {
                // Should have received payment (in USDC - 6 decimals)
                uint256 expectedUsdc = amounts[i] / DECIMAL_MULTIPLIER;
                assertEq(
                    usdc.balanceOf(users[i]),
                    initialBalances[i] + expectedUsdc,
                    "Processed user should receive payment"
                );
            } else {
                // Should NOT have received payment
                assertEq(
                    usdc.balanceOf(users[i]),
                    initialBalances[i],
                    "Unprocessed user should not receive payment"
                );
            }
        }
    }

    /**
     * @notice Fuzz test: FIFO with rebase - each user gets correct yield-adjusted amount
     */
    function testFuzz_FIFO_WithRebase(
        uint256 numUsers,
        uint256 multiplierIncrease,
        uint256 baseSeed
    )
        public
    {
        numUsers = bound(numUsers, 2, 10);
        multiplierIncrease = bound(multiplierIncrease, PRECISION / 100, PRECISION * 2); // 1% to 200%

        address[] memory users = new address[](numUsers);
        uint256[] memory amounts = new uint256[](numUsers);
        uint256[] memory shares = new uint256[](numUsers);
        uint256[] memory initialBalances = new uint256[](numUsers);

        for (uint256 i = 0; i < numUsers; i++) {
            users[i] = makeAddr(string(abi.encodePacked("rebaseUser", i)));
            amounts[i] = bound(uint256(keccak256(abi.encode(baseSeed, i))), 1e18, 10_000e18);

            _mintOkuUsd(address(redemptionQueue), amounts[i]);
            redemptionQueue.enqueue(users[i], amounts[i]);

            // Record shares (at 1x multiplier, shares == tokens)
            shares[i] = redemptionQueue.getQueueEntry(i).shares;
            initialBalances[i] = usdc.balanceOf(users[i]);
        }

        // Rebase
        uint256 newMultiplier = PRECISION + multiplierIncrease;
        vm.prank(rebaser);
        okuUsd.updateRewardMultiplier(newMultiplier);

        // Calculate total needed after rebase
        uint256 totalNeededOkuUsd = 0;
        uint256[] memory expectedPayoutsOkuUsd = new uint256[](numUsers);
        uint256[] memory expectedPayoutsUsdc = new uint256[](numUsers);
        for (uint256 i = 0; i < numUsers; i++) {
            expectedPayoutsOkuUsd[i] = (shares[i] * newMultiplier) / PRECISION;
            expectedPayoutsUsdc[i] = expectedPayoutsOkuUsd[i] / DECIMAL_MULTIPLIER;
            totalNeededOkuUsd += expectedPayoutsOkuUsd[i];
        }

        // Convert total to USDC
        uint256 totalNeededUsdc = totalNeededOkuUsd / DECIMAL_MULTIPLIER;

        // Setup for processing
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), totalNeededUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalNeededUsdc);

        // Process all
        redemptionQueue.processQueue(numUsers, address(usdc), address(okuUsd));

        // Verify each user got their yield-adjusted amount in FIFO order
        assertEq(redemptionQueue.queueLength(), 0, "Queue should be empty");

        for (uint256 i = 0; i < numUsers; i++) {
            assertEq(
                usdc.balanceOf(users[i]),
                initialBalances[i] + expectedPayoutsUsdc[i],
                string(abi.encodePacked("User ", i, " should receive yield-adjusted amount"))
            );
        }
    }

    /**
     * @notice Fuzz test: Buffer depletion stops processing correctly mid-queue
     * @dev Uses uniform amounts to ensure predictable FIFO behavior
     */
    function testFuzz_FIFO_BufferDepletion(
        uint256 numUsers,
        uint256 amountPerUser,
        uint256 numToPay
    )
        public
    {
        numUsers = bound(numUsers, 3, 10);
        amountPerUser = bound(amountPerUser, 1e18, 1000e18);
        numToPay = bound(numToPay, 1, numUsers - 1); // Pay some but not all

        address[] memory users = new address[](numUsers);
        uint256[] memory initialBalances = new uint256[](numUsers);

        for (uint256 i = 0; i < numUsers; i++) {
            users[i] = makeAddr(string(abi.encodePacked("bufferUser", i)));

            _mintOkuUsd(address(redemptionQueue), amountPerUser);
            redemptionQueue.enqueue(users[i], amountPerUser);

            initialBalances[i] = usdc.balanceOf(users[i]);
        }

        // Setup - provide exactly enough for numToPay users
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        uint256 bufferAmountOkuUsd = amountPerUser * numToPay;
        uint256 bufferAmountUsdc = bufferAmountOkuUsd / DECIMAL_MULTIPLIER;
        uint256 amountPerUserUsdc = amountPerUser / DECIMAL_MULTIPLIER;

        _mintUsdc(address(this), bufferAmountUsdc);
        _approveUsdc(address(this), address(redemptionQueue), bufferAmountUsdc);

        // Try to process all - will stop after numToPay
        redemptionQueue.processQueue(numUsers, address(usdc), address(okuUsd));

        // Verify: first numToPay users got paid, rest didn't (FIFO)
        for (uint256 i = 0; i < numUsers; i++) {
            if (i < numToPay) {
                assertEq(
                    usdc.balanceOf(users[i]),
                    initialBalances[i] + amountPerUserUsdc,
                    "User within buffer should be paid"
                );
            } else {
                assertEq(
                    usdc.balanceOf(users[i]),
                    initialBalances[i],
                    "User beyond buffer should not be paid"
                );
            }
        }

        // Verify queue length
        assertEq(
            redemptionQueue.queueLength(),
            numUsers - numToPay,
            "Queue length should match unprocessed"
        );
    }

    /**
     * @notice Fuzz test: Variable amounts with buffer depletion
     * @dev Tests that processing stops at the right point with different amounts
     */
    function testFuzz_FIFO_VariableAmountsBufferDepletion(
        uint256 numUsers,
        uint256 baseSeed
    )
        public
    {
        numUsers = bound(numUsers, 3, 8);

        address[] memory users = new address[](numUsers);
        uint256[] memory amounts = new uint256[](numUsers);
        uint256[] memory initialBalances = new uint256[](numUsers);
        uint256 totalQueued = 0;

        for (uint256 i = 0; i < numUsers; i++) {
            users[i] = makeAddr(string(abi.encodePacked("varUser", i)));
            // Use smaller amounts to ensure some always fit
            amounts[i] = bound(uint256(keccak256(abi.encode(baseSeed, i))), 100e18, 500e18);

            _mintOkuUsd(address(redemptionQueue), amounts[i]);
            redemptionQueue.enqueue(users[i], amounts[i]);

            initialBalances[i] = usdc.balanceOf(users[i]);
            totalQueued += amounts[i];
        }

        // Setup - provide enough for roughly half
        vm.prank(admin);
        okuUsd.grantRole(MINTER, address(redemptionQueue));

        // Convert to USDC amount inline
        uint256 bufferUsdc = (totalQueued / 2) / DECIMAL_MULTIPLIER;

        _mintUsdc(address(this), bufferUsdc);
        _approveUsdc(address(this), address(redemptionQueue), bufferUsdc);

        uint256 queueLengthBefore = redemptionQueue.queueLength();

        // Process
        redemptionQueue.processQueue(numUsers, address(usdc), address(okuUsd));

        uint256 processed = queueLengthBefore - redemptionQueue.queueLength();

        // Verify FIFO: simulate what should have happened
        uint256 simBuffer = bufferUsdc;
        uint256 expectedProcessed = 0;
        for (uint256 i = 0; i < numUsers; i++) {
            uint256 usdcAmount = amounts[i] / DECIMAL_MULTIPLIER;
            if (simBuffer >= usdcAmount) {
                // Should be paid
                assertEq(
                    usdc.balanceOf(users[i]),
                    initialBalances[i] + usdcAmount,
                    "Paid user should receive correct amount"
                );
                simBuffer -= usdcAmount;
                expectedProcessed++;
            } else {
                // Should NOT be paid - and all subsequent shouldn't be paid either
                for (uint256 j = i; j < numUsers; j++) {
                    assertEq(
                        usdc.balanceOf(users[j]),
                        initialBalances[j],
                        "Unpaid user should have unchanged balance"
                    );
                }
                break;
            }
        }

        assertEq(processed, expectedProcessed, "Processed count should match expected");
    }
}
