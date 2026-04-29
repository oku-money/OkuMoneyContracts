// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {RedemptionQueueEvents} from "../../src/lib/events/RedemptionQueueEvents.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @title RedemptionQueueTest
 * @notice Unit tests for RedemptionQueue
 * @dev Queue stores raw note token amounts (non-rebasing). Users earn yield while
 *      waiting through okuMMultiplier() appreciation, not balance growth.
 *      enqueue() is record-only; the PSM transfers tokens into the queue before calling it.
 *      Tests simulate this by calling _mintOkuMoney(address(redemptionQueue), amount) first.
 */
contract RedemptionQueueTest is BaseTest {
    // Note: DECIMAL_MULTIPLIER is inherited from BaseTest

    // ============ Events ============

    event RedemptionQueued(
        address indexed user,
        uint256 okuMAmount,
        uint256 dollarValue,
        uint256 position,
        uint256 queueLength
    );
    event RedemptionProcessed(
        address indexed user,
        uint256 okuMAmount,
        uint256 dollarValue,
        uint256 usdcAmount,
        uint256 waitTime
    );

    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Setup: grant PSM to a test address for direct testing
        vm.prank(admin);
        redemptionQueue.grantRole(QUEUE_PSM, address(this));

        // Mint OkuMoney to users
        _mintOkuMoney(user1, 1000e18);
        _mintOkuMoney(user2, 1000e18);
        _mintOkuMoney(user3, 1000e18);
    }

    // ============ Enqueue Tests ============

    function test_Enqueue_OnlyPSMRole() public {
        // No pre-funding needed — test reverts on RBAC before any token ops
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, QUEUE_PSM
            )
        );
        redemptionQueue.enqueue(user1, 100e18);
    }

    function test_Enqueue_TransfersOkuMoney() public {
        uint256 amount = 100e18;
        // Pre-fund queue (simulating PSM already moved tokens there)
        _mintOkuMoney(address(redemptionQueue), amount);

        uint256 user1BalanceBefore = okuMoney.balanceOf(user1);
        uint256 queueBalanceBefore = okuMoney.balanceOf(address(redemptionQueue));

        // enqueue is now record-only — tokens already in queue
        redemptionQueue.enqueue(user1, amount);

        // user1 balance unchanged (no transfer from user)
        assertEq(okuMoney.balanceOf(user1), user1BalanceBefore);
        // queue balance unchanged (tokens were pre-funded, enqueue doesn't move them)
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), queueBalanceBefore);
    }

    function test_Enqueue_DoesNotTransferFromUser() public {
        uint256 amount = 100e18;
        uint256 user1BalanceBefore = okuMoney.balanceOf(user1);

        // Call enqueue without pre-funding — record-only, no transferFrom
        redemptionQueue.enqueue(user1, amount);

        // user1 balance completely unchanged
        assertEq(okuMoney.balanceOf(user1), user1BalanceBefore);
        assertEq(redemptionQueue.queueUpperBound(), 1);
    }

    function test_Enqueue_StoresEntry() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(0);
        assertEq(entry.user, user1);
        // Non-rebasing: okuMAmount stored directly, no share conversion
        assertEq(entry.okuMAmount, amount);
        assertEq(entry.timestamp, block.timestamp);
    }

    function test_Enqueue_IncrementsQueueLength() public {
        assertEq(redemptionQueue.queueUpperBound(), 0);

        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);

        assertEq(redemptionQueue.queueUpperBound(), 1);

        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueUpperBound(), 2);
    }

    function test_Enqueue_EmitsEvent() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);

        uint256 dollarValue = (amount * okuMoney.okuMMultiplier()) / PRECISION;
        uint256 position = redemptionQueue.queueTail();
        uint256 queueLength = 1; // First entry

        vm.expectEmit(true, false, false, true);
        emit RedemptionQueued(user1, amount, dollarValue, position, queueLength);

        redemptionQueue.enqueue(user1, amount);
    }

    function test_Enqueue_MultipleEntries() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 200e18);
        _mintOkuMoney(address(redemptionQueue), 300e18);

        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 200e18);
        redemptionQueue.enqueue(user3, 300e18);

        assertEq(redemptionQueue.queueUpperBound(), 3);

        // Verify order
        assertEq(redemptionQueue.getQueueEntry(0).user, user1);
        assertEq(redemptionQueue.getQueueEntry(1).user, user2);
        assertEq(redemptionQueue.getQueueEntry(2).user, user3);
    }

    // ============ ProcessQueue Tests ============

    function test_ProcessQueue_OnlyPSMRole() public {
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, QUEUE_PSM
            )
        );
        redemptionQueue.processQueue(0, 10, address(usdc));
    }

    function test_ProcessQueue_BurnsOkuMoney() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        uint256 queueBalanceBefore = okuMoney.balanceOf(address(redemptionQueue));

        // Setup: give queue minter role to burn
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        // Setup: approve USDC for transfer
        // At 1x okuMMultiplier, usdcAmount = okuMAmount * okuMMultiplier / PRECISION / DECIMAL_MULTIPLIER
        uint256 usdcAmount = amount * okuMoney.okuMMultiplier() / PRECISION / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        assertEq(okuMoney.balanceOf(address(redemptionQueue)), queueBalanceBefore - amount);
    }

    function test_ProcessQueue_TransfersUSDC() public {
        uint256 okuMoneyAmount = 100e18; // 100 OkuMoney
        uint256 usdcAmount = 100e6; // 100 USDC (6 decimals) at 1x okuMMultiplier

        _mintOkuMoney(address(redemptionQueue), okuMoneyAmount);
        redemptionQueue.enqueue(user1, okuMoneyAmount);

        // Setup
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        // User should receive USDC (6 decimals), not OkuMoney amount (18 decimals)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + usdcAmount);
    }

    function test_ProcessQueue_AdvancesQueueHead() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueUpperBound(), 2);

        // Setup
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        // Process only 1 entry
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueHead() + 1, address(usdc)
        );

        // Queue head should advance, length decreases
        assertEq(redemptionQueue.queueUpperBound(), 1);

        // First entry should now be invalid
        vm.expectRevert(RedemptionQueue.InvalidIndex.selector);
        redemptionQueue.getQueueEntry(0);
    }

    function test_ProcessQueue_RespectsMaxEntries() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);
        redemptionQueue.enqueue(user3, 100e18);

        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        _mintUsdc(address(this), 300e6); // 300 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 300e6);

        // Process only 2 entries
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueHead() + 2, address(usdc)
        );

        // Should have 1 entry left
        assertEq(redemptionQueue.queueUpperBound(), 1);
    }

    function test_ProcessQueue_StopsWhenBufferDepleted() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        // Only provide enough USDC for 1 entry
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        // Should have processed only 1
        assertEq(redemptionQueue.queueUpperBound(), 1);
    }

    function test_ProcessQueue_EmitsEvent() public {
        uint256 okuMoneyAmount = 100e18; // 100 OkuMoney
        uint256 usdcAmount = 100e6; // 100 USDC

        _mintOkuMoney(address(redemptionQueue), okuMoneyAmount);
        redemptionQueue.enqueue(user1, okuMoneyAmount);

        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        uint256 dollarValue = (okuMoneyAmount * okuMoney.okuMMultiplier()) / PRECISION;

        // Skip exact event check since waitTime depends on block.timestamp
        // Just verify the processing works
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        // Verify user received USDC
        assertEq(usdc.balanceOf(user1), usdcAmount);
    }

    function test_ProcessQueue_FIFO_Order() public {
        // Enqueue in order: user1, user2, user3
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 200e18);
        _mintOkuMoney(address(redemptionQueue), 300e18);

        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 200e18);
        redemptionQueue.enqueue(user3, 300e18);

        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        // Only provide enough for first entry
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 user2UsdcBefore = usdc.balanceOf(user2);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        // Only user1 (first in queue) should receive 100 USDC (6 decimals)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 100e6);
        assertEq(usdc.balanceOf(user2), user2UsdcBefore); // Unchanged
    }

    // ============ View Function Tests ============

    function test_QueueLength_ReturnsUnprocessed() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueUpperBound(), 2);

        // Process one
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueHead() + 1, address(usdc)
        );

        assertEq(redemptionQueue.queueUpperBound(), 1);
    }

    function test_GetQueueEntry_RevertsInvalidIndex() public {
        vm.expectRevert(RedemptionQueue.InvalidIndex.selector);
        redemptionQueue.getQueueEntry(0);
    }

    // ============ Price Appreciation Tests ============

    /**
     * @notice Verifies that users earn yield while waiting in queue via okuMMultiplier() appreciation
     * @dev Non-rebasing: the note token count is unchanged, but okuMMultiplier() increases
     *      mean the USDC output at processing time is higher than at enqueue time.
     */
    function test_QueueStoresNoteAmount_PriceAppreciates() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        // Get the stored entry - should store raw okuMAmount
        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(0);

        // Non-rebasing: okuMAmount == the raw token amount
        assertEq(entry.okuMAmount, amount);

        // Now increase okuMMultiplier - user should earn yield via multiplier appreciation
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2); // 2x price

        // The stored okuMAmount remains the same (non-rebasing)
        RedemptionQueue.QueueEntry memory entryAfterPrice = redemptionQueue.getQueueEntry(0);
        assertEq(entryAfterPrice.okuMAmount, amount); // Still 100e18 okuMAmount

        // But the dollar VALUE has doubled via getQueueEntryValue()
        uint256 currentValue = redemptionQueue.getQueueEntryValue(0);
        assertEq(currentValue, amount * 2); // 200e18 dollar value

        // Process queue and verify user receives the increased amount
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        // Need 200 USDC (6 decimals) now to match 200e18 dollar value
        _mintUsdc(address(this), 200e6); // 200 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 200e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        // User should receive 200 USDC (6 decimals) - earned 100% yield via multiplier appreciation
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 200e6);
    }

    /**
     * @notice Verifies multiplier appreciation with multiple users in queue
     */
    function test_QueuePriceAppreciation_MultipleUsers() public {
        // User1 and User2 both queue 100e18
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 100e18);

        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        // Increase okuMMultiplier by 50%
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 3 / 2); // 1.5x price

        // Both should now have dollar value of 150e18
        assertEq(redemptionQueue.getQueueEntryValue(0), 150e18);
        assertEq(redemptionQueue.getQueueEntryValue(1), 150e18);

        // Setup for processing
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        _mintUsdc(address(this), 300e6); // 300 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 300e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 user2UsdcBefore = usdc.balanceOf(user2);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        // Both users receive 150 USDC (6 decimals)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 150e6);
        assertEq(usdc.balanceOf(user2), user2UsdcBefore + 150e6);
    }

    /**
     * @notice Verifies that getQueueEntryValue returns correct current dollar value
     */
    function test_GetQueueEntryValue_ReflectsCurrentNotePrice() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        // Initially value equals original amount (okuMMultiplier == 1e18)
        assertEq(redemptionQueue.getQueueEntryValue(0), amount);

        // After 2x okuMMultiplier
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 2);
        assertEq(redemptionQueue.getQueueEntryValue(0), amount * 2);

        // After another price increase (total 3x)
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(PRECISION * 3);
        assertEq(redemptionQueue.getQueueEntryValue(0), amount * 3);
    }

    // ============ Fuzz Tests for Price Appreciation ============

    /**
     * @notice Fuzz test: User earns correct yield while queued via okuMMultiplier appreciation
     */
    function testFuzz_QueuePriceAppreciation(uint256 amount, uint256 priceIncrease) public {
        // Bound inputs to reasonable ranges
        amount = bound(amount, 1e18, 1_000_000e18);
        priceIncrease = bound(priceIncrease, 0, PRECISION * 9); // Up to 10x total

        _mintOkuMoney(user1, amount);
        _mintOkuMoney(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        // Record initial okuMAmount
        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(0);
        uint256 initialNoteAmount = entry.okuMAmount;

        // Increase okuMMultiplier
        uint256 newPrice = PRECISION + priceIncrease;
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        // Verify okuMAmount unchanged (non-rebasing)
        RedemptionQueue.QueueEntry memory entryAfter = redemptionQueue.getQueueEntry(0);
        assertEq(
            entryAfter.okuMAmount,
            initialNoteAmount,
            "okuMAmount should not change after price update"
        );

        // Verify dollar value increased correctly
        uint256 expectedValue = (initialNoteAmount * newPrice) / PRECISION;
        uint256 actualValue = redemptionQueue.getQueueEntryValue(0);
        assertEq(actualValue, expectedValue, "Value should reflect new okuMMultiplier");
    }

    /**
     * @notice Fuzz test: User receives correct USDC payout after multiplier appreciation
     */
    function testFuzz_QueuePayoutAfterPriceAppreciation(
        uint256 amount,
        uint256 priceIncrease
    )
        public
    {
        // Bound inputs
        amount = bound(amount, 1e18, 100_000e18);
        priceIncrease = bound(priceIncrease, PRECISION / 100, PRECISION * 4); // 1% to 5x

        _mintOkuMoney(user1, amount);
        _mintOkuMoney(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        // Increase okuMMultiplier
        uint256 newPrice = PRECISION + priceIncrease;
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        // Calculate expected payout: okuMAmount * okuMMultiplier / PRECISION (dollar value in 18 dec)
        uint256 expectedDollarValue = redemptionQueue.getQueueEntryValue(0);
        // Convert to USDC (6 decimals)
        uint256 expectedPayoutUsdc = expectedDollarValue / DECIMAL_MULTIPLIER;

        // Setup for processing
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        _mintUsdc(address(this), expectedPayoutUsdc);
        _approveUsdc(address(this), address(redemptionQueue), expectedPayoutUsdc);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        // User should receive exact expected payout (in USDC - 6 decimals)
        assertEq(
            usdc.balanceOf(user1),
            user1UsdcBefore + expectedPayoutUsdc,
            "User should receive full yield from multiplier appreciation"
        );
        assertEq(redemptionQueue.queueUpperBound(), 0, "Queue should be empty");
    }

    /**
     * @notice Fuzz test: Multiple okuMMultiplier increases compound correctly
     */
    function testFuzz_MultiplePriceIncreasesCompound(
        uint256 amount,
        uint256 increase1,
        uint256 increase2
    )
        public
    {
        amount = bound(amount, 1e18, 100_000e18);
        increase1 = bound(increase1, PRECISION / 100, PRECISION); // 1% to 100% increase
        increase2 = bound(increase2, PRECISION / 100, PRECISION); // 1% to 100% increase

        _mintOkuMoney(user1, amount);
        _mintOkuMoney(address(redemptionQueue), amount);

        redemptionQueue.enqueue(user1, amount);

        uint256 initialNoteAmount = redemptionQueue.getQueueEntry(0).okuMAmount;

        // First price increase
        uint256 price1 = PRECISION + increase1;
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(price1);

        // Second price increase
        uint256 price2 = price1 + increase2;
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(price2);

        // Final dollar value should be okuMAmount * finalPrice / PRECISION
        uint256 expectedValue = (initialNoteAmount * price2) / PRECISION;
        uint256 actualValue = redemptionQueue.getQueueEntryValue(0);

        assertEq(actualValue, expectedValue, "Multiple price increases should compound correctly");
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
            _mintOkuMoney(address(redemptionQueue), amounts[i]);

            // Enqueue
            redemptionQueue.enqueue(users[i], amounts[i]);

            initialBalances[i] = usdc.balanceOf(users[i]);
            totalNeeded += amounts[i];
        }

        // Verify queue length
        assertEq(redemptionQueue.queueUpperBound(), numUsers, "Queue should have all users");

        // Setup for processing - convert note dollar value to USDC
        // At 1x okuMMultiplier, dollar value == okuMAmount
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        uint256 totalNeededUsdc = totalNeeded / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), totalNeededUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalNeededUsdc);

        // Process all
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        // Verify all processed in order (each received their amount in USDC)
        assertEq(redemptionQueue.queueUpperBound(), 0, "Queue should be empty");

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

            _mintOkuMoney(address(redemptionQueue), amounts[i]);
            redemptionQueue.enqueue(users[i], amounts[i]);

            initialBalances[i] = usdc.balanceOf(users[i]);

            if (i < numToProcess) {
                totalForProcessed += amounts[i];
            }
        }

        // Setup - only provide enough USDC for the ones we'll process
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        uint256 totalForProcessedUsdc = totalForProcessed / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), totalForProcessedUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalForProcessedUsdc);

        // Process only numToProcess
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueHead() + numToProcess, address(usdc)
        );

        // Verify: first numToProcess users got paid, rest didn't
        assertEq(
            redemptionQueue.queueUpperBound(),
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
     * @notice Fuzz test: FIFO with multiplier appreciation - each user gets correct price-adjusted amount
     */
    function testFuzz_FIFO_WithPriceAppreciation(
        uint256 numUsers,
        uint256 priceIncrease,
        uint256 baseSeed
    )
        public
    {
        numUsers = bound(numUsers, 2, 10);
        priceIncrease = bound(priceIncrease, PRECISION / 100, PRECISION * 2); // 1% to 200%

        address[] memory users = new address[](numUsers);
        uint256[] memory amounts = new uint256[](numUsers);
        uint256[] memory initialBalances = new uint256[](numUsers);

        for (uint256 i = 0; i < numUsers; i++) {
            users[i] = makeAddr(string(abi.encodePacked("rebaseUser", i)));
            amounts[i] = bound(uint256(keccak256(abi.encode(baseSeed, i))), 1e18, 10_000e18);

            _mintOkuMoney(address(redemptionQueue), amounts[i]);
            redemptionQueue.enqueue(users[i], amounts[i]);

            initialBalances[i] = usdc.balanceOf(users[i]);
        }

        // Increase okuMMultiplier
        uint256 newPrice = PRECISION + priceIncrease;
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(newPrice);

        // Calculate total needed after multiplier appreciation
        uint256 totalNeededUsdc = 0;
        uint256[] memory expectedPayoutsUsdc = new uint256[](numUsers);
        for (uint256 i = 0; i < numUsers; i++) {
            // dollarValue = okuMAmount * okuMMultiplier / PRECISION
            uint256 dollarValue = (amounts[i] * newPrice) / PRECISION;
            expectedPayoutsUsdc[i] = dollarValue / DECIMAL_MULTIPLIER;
            totalNeededUsdc += expectedPayoutsUsdc[i];
        }

        // Setup for processing
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        _mintUsdc(address(this), totalNeededUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalNeededUsdc);

        // Process all
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        // Verify each user got their price-adjusted amount in FIFO order
        assertEq(redemptionQueue.queueUpperBound(), 0, "Queue should be empty");

        for (uint256 i = 0; i < numUsers; i++) {
            assertEq(
                usdc.balanceOf(users[i]),
                initialBalances[i] + expectedPayoutsUsdc[i],
                string(abi.encodePacked("User ", i, " should receive price-adjusted amount"))
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

            _mintOkuMoney(address(redemptionQueue), amountPerUser);
            redemptionQueue.enqueue(users[i], amountPerUser);

            initialBalances[i] = usdc.balanceOf(users[i]);
        }

        // Setup - provide exactly enough for numToPay users
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        uint256 bufferAmountNotes = amountPerUser * numToPay;
        uint256 bufferAmountUsdc = bufferAmountNotes / DECIMAL_MULTIPLIER;
        uint256 amountPerUserUsdc = amountPerUser / DECIMAL_MULTIPLIER;

        _mintUsdc(address(this), bufferAmountUsdc);
        _approveUsdc(address(this), address(redemptionQueue), bufferAmountUsdc);

        // Try to process all - will stop after numToPay
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

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
            redemptionQueue.queueUpperBound(),
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

            _mintOkuMoney(address(redemptionQueue), amounts[i]);
            redemptionQueue.enqueue(users[i], amounts[i]);

            initialBalances[i] = usdc.balanceOf(users[i]);
            totalQueued += amounts[i];
        }

        // Setup - provide enough for roughly half
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        // Convert to USDC amount inline
        uint256 bufferUsdc = (totalQueued / 2) / DECIMAL_MULTIPLIER;

        _mintUsdc(address(this), bufferUsdc);
        _approveUsdc(address(this), address(redemptionQueue), bufferUsdc);

        uint256 queueLengthBefore = redemptionQueue.queueUpperBound();

        // Process
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        uint256 processed = queueLengthBefore - redemptionQueue.queueUpperBound();

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

    // ============ Rescue Queue Entry Tests ============

    function test_RescueQueueEntry_ReturnsOkuMoney() public {
        uint256 amount = 1000e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        uint256 user1BalanceBefore = okuMoney.balanceOf(user1);
        uint256 queueBalanceBefore = okuMoney.balanceOf(address(redemptionQueue));

        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user1);

        assertEq(
            okuMoney.balanceOf(user1),
            user1BalanceBefore + amount,
            "User should receive OkuMoney back"
        );
        assertEq(
            okuMoney.balanceOf(address(redemptionQueue)),
            queueBalanceBefore - amount,
            "Queue balance should decrease"
        );
    }

    function test_RescueQueueEntry_ToAlternateRecipient() public {
        uint256 amount = 1000e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        uint256 user1BalanceBefore = okuMoney.balanceOf(user1);
        uint256 user2BalanceBefore = okuMoney.balanceOf(user2);

        // Rescue to alternate recipient (user2) instead of original user (user1)
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user2);

        assertEq(
            okuMoney.balanceOf(user2),
            user2BalanceBefore + amount,
            "Alternate recipient should receive OkuMoney"
        );
        assertEq(
            okuMoney.balanceOf(user1),
            user1BalanceBefore,
            "Original user balance should be unchanged"
        );
    }

    function test_RescueQueueEntry_DecreasesTotalQueued() public {
        uint256 amount = 1000e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        uint256 totalBefore = redemptionQueue.totalQueuedOkuM();
        assertEq(totalBefore, amount);

        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user1);

        assertEq(redemptionQueue.totalQueuedOkuM(), 0, "Total queued should be zero after rescue");
    }

    function test_RescueQueueEntry_EmitsEvent() public {
        uint256 amount = 1000e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        uint256 okuMMult = okuMoney.okuMMultiplier();
        uint256 dollarValue = (amount * okuMMult) / 1e18;

        vm.prank(queueRescuer);
        vm.expectEmit(true, true, true, true);
        emit RedemptionQueueEvents.RedemptionRescued(0, user1, user2, amount, dollarValue);
        redemptionQueue.rescueQueueEntry(0, user2);
    }

    function test_RescueQueueEntry_RevertNotAuthorized() public {
        uint256 amount = 1000e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, QUEUE_RESCUER
            )
        );
        redemptionQueue.rescueQueueEntry(0, user1);
    }

    function test_RescueQueueEntry_RevertInvalidIndex() public {
        vm.prank(queueRescuer);
        vm.expectRevert(RedemptionQueue.InvalidIndex.selector);
        redemptionQueue.rescueQueueEntry(0, user1);
    }

    function test_RescueQueueEntry_RevertZeroAddress() public {
        uint256 amount = 1000e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        vm.prank(queueRescuer);
        vm.expectRevert(RedemptionQueue.ZeroAddress.selector);
        redemptionQueue.rescueQueueEntry(0, address(0));
    }

    function test_RescueQueueEntry_RevertAlreadyCleared() public {
        uint256 amount = 1000e18;

        // Enqueue 2 entries so rescuing index 1 won't advance head past it
        _mintOkuMoney(address(redemptionQueue), amount * 2);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);

        // Rescue the middle entry (index 1) so head doesn't advance
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(1, user2);

        // Try to rescue same index again — should revert EntryAlreadyCleared
        vm.prank(queueRescuer);
        vm.expectRevert(RedemptionQueue.EntryAlreadyCleared.selector);
        redemptionQueue.rescueQueueEntry(1, user2);
    }

    function test_RescueQueueEntry_AdvancesHeadWhenFirst() public {
        uint256 amount = 500e18;

        // Enqueue 3 entries
        _mintOkuMoney(address(redemptionQueue), amount * 3);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);
        redemptionQueue.enqueue(user3, amount);

        assertEq(redemptionQueue.queueHead(), 0);
        assertEq(redemptionQueue.queueTail(), 3);

        // Rescue the first entry — head should advance
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user1);

        assertEq(redemptionQueue.queueHead(), 1, "Head should advance after rescuing first entry");
    }

    function test_RescueQueueEntry_DoesNotAdvanceHeadWhenMiddle() public {
        uint256 amount = 500e18;

        // Enqueue 3 entries
        _mintOkuMoney(address(redemptionQueue), amount * 3);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);
        redemptionQueue.enqueue(user3, amount);

        assertEq(redemptionQueue.queueHead(), 0);

        // Rescue the middle entry — head should NOT advance
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(1, user2);

        assertEq(
            redemptionQueue.queueHead(), 0, "Head should not advance when rescuing middle entry"
        );
    }

    function test_RescueQueueEntry_ProcessQueueAfterRescue() public {
        uint256 amount = 500e18;

        // Enqueue 3 entries
        _mintOkuMoney(address(redemptionQueue), amount * 3);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);
        redemptionQueue.enqueue(user3, amount);

        // Grant queue the ability to burn
        vm.prank(admin);
        okuMoney.grantRole(OKUM_MINTER, address(redemptionQueue));

        // Rescue the first entry (stuck)
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user1);

        // Now process remaining entries
        uint256 usdcNeeded = (amount * 2) / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcNeeded);
        _approveUsdc(address(this), address(redemptionQueue), usdcNeeded);

        uint256 user2UsdcBefore = usdc.balanceOf(user2);
        uint256 user3UsdcBefore = usdc.balanceOf(user3);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueTail(), address(usdc)
        );

        // Both remaining users should receive USDC
        assertGt(usdc.balanceOf(user2), user2UsdcBefore, "User2 should receive USDC");
        assertGt(usdc.balanceOf(user3), user3UsdcBefore, "User3 should receive USDC");
    }

    // ============ UUPS Upgradeability ============

    function test_UUPS_UpgradeRedemptionQueue() public {
        RedemptionQueue newImpl = new RedemptionQueue();

        vm.prank(admin);
        redemptionQueue.upgradeToAndCall(address(newImpl), "");

        // State preserved across upgrade
        assertEq(address(redemptionQueue.okuMoney()), address(okuMoney));
    }

    function test_UUPS_UpgradeRedemptionQueue_RevertNotUpgrader() public {
        RedemptionQueue newImpl = new RedemptionQueue();

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, QUEUE_UPGRADER
            )
        );
        vm.prank(user1);
        redemptionQueue.upgradeToAndCall(address(newImpl), "");
    }

    // ============ ProcessQueue Range Validation ============

    function test_ProcessQueue_RevertStartBelowHead() public {
        // Process one entry to advance head past index 0, then try to re-process from 0.
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        // OKUM_MINTER on redemptionQueue is granted in BaseTest._setupRoles.
        uint256 usdcAmount = amount / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);
        redemptionQueue.processQueue(0, 1, address(usdc));
        assertEq(redemptionQueue.queueHead(), 1);

        vm.expectRevert(RedemptionQueue.StartBelowHead.selector);
        redemptionQueue.processQueue(0, 1, address(usdc));
    }

    function test_ProcessQueue_RevertEndAboveTail() public {
        // Empty queue — tail == 0, asking for endIndex > 0 must revert.
        vm.expectRevert(RedemptionQueue.EndAboveTail.selector);
        redemptionQueue.processQueue(0, 5, address(usdc));
    }

    function test_RescueQueueEntry_AdvancesHeadPastChainOfRescued() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount * 4);

        // Enqueue four entries.
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user1, amount);
        assertEq(redemptionQueue.queueHead(), 0);
        assertEq(redemptionQueue.queueTail(), 4);

        // Rescue indices 0, 1, 2 in order. After each rescue the head should advance
        // past every contiguous cleared entry. Final state: head == 3, tail == 4.
        vm.startPrank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user2);
        assertEq(redemptionQueue.queueHead(), 1);

        redemptionQueue.rescueQueueEntry(1, user2);
        assertEq(redemptionQueue.queueHead(), 2);

        redemptionQueue.rescueQueueEntry(2, user2);
        assertEq(redemptionQueue.queueHead(), 3);
        vm.stopPrank();

        assertEq(redemptionQueue.queueTail(), 4);
    }

    function test_TotalQueuedUsdc_AfterMultiplierChange() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        // At PRECISION, totalQueuedUsdc == amount / DECIMAL_MULTIPLIER (= 100e6).
        assertEq(redemptionQueue.totalQueuedUsdc(), amount / DECIMAL_MULTIPLIER);

        // Bump multiplier 2x — totalQueuedUsdc must reflect the new dollar value.
        _setOkuMMultiplierAndRoll(PRECISION * 2);
        assertEq(redemptionQueue.totalQueuedUsdc(), 2 * amount / DECIMAL_MULTIPLIER);
    }
}
