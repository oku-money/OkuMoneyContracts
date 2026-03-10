// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @title RedemptionQueueTest
 * @notice Unit tests for RedemptionQueue
 * @dev Queue stores raw note token amounts (non-rebasing). Users earn yield while
 *      waiting through okuMPrice() appreciation, not balance growth.
 *      enqueue() is record-only; the PSM transfers tokens into the queue before calling it.
 *      Tests simulate this by calling _mintOkuMoney(address(redemptionQueue), amount) first.
 */
contract RedemptionQueueTest is BaseTest {
    // Decimal conversion constant
    uint256 private constant DECIMAL_MULTIPLIER = 10 ** 12; // OkuMoney (18) - USDC (6) = 12

    // ============ Events ============

    event RedemptionQueued(address indexed user, uint256 okuMAmount, uint256 position);
    event RedemptionProcessed(address indexed user, uint256 okuMAmount, uint256 usdcAmount);

    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Setup: grant PSM to a test address for direct testing
        vm.prank(admin);
        redemptionQueue.grantRole(PSM, address(this));

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
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM
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
        assertEq(redemptionQueue.queueLength(), 1);
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
        assertEq(redemptionQueue.queueLength(), 0);

        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);

        assertEq(redemptionQueue.queueLength(), 1);

        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueLength(), 2);
    }

    function test_Enqueue_EmitsEvent() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);

        vm.expectEmit(true, false, false, true);
        emit RedemptionQueued(user1, amount, 0);

        redemptionQueue.enqueue(user1, amount);
    }

    function test_Enqueue_MultipleEntries() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 200e18);
        _mintOkuMoney(address(redemptionQueue), 300e18);

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
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, PSM
            )
        );
        redemptionQueue.processQueue(0, 10, address(usdc), address(okuMoney));
    }

    function test_ProcessQueue_BurnsOkuMoney() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        uint256 queueBalanceBefore = okuMoney.balanceOf(address(redemptionQueue));

        // Setup: give queue minter role to burn
        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        // Setup: approve USDC for transfer
        // At 1x notePrice, usdcAmount = okuMAmount * notePrice / PRECISION / DECIMAL_MULTIPLIER
        uint256 usdcAmount = amount * okuMoney.okuMPrice() / PRECISION / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
        );

        assertEq(okuMoney.balanceOf(address(redemptionQueue)), queueBalanceBefore - amount);
    }

    function test_ProcessQueue_TransfersUSDC() public {
        uint256 okuMoneyAmount = 100e18; // 100 OkuMoney
        uint256 usdcAmount = 100e6; // 100 USDC (6 decimals) at 1x notePrice

        _mintOkuMoney(address(redemptionQueue), okuMoneyAmount);
        redemptionQueue.enqueue(user1, okuMoneyAmount);

        // Setup
        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
        );

        // User should receive USDC (6 decimals), not OkuMoney amount (18 decimals)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + usdcAmount);
    }

    function test_ProcessQueue_AdvancesQueueHead() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueLength(), 2);

        // Setup
        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        // Process only 1 entry
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueHead() + 1,
            address(usdc),
            address(okuMoney)
        );

        // Queue head should advance, length decreases
        assertEq(redemptionQueue.queueLength(), 1);

        // First entry should now be invalid
        vm.expectRevert("Invalid index");
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
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), 300e6); // 300 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 300e6);

        // Process only 2 entries
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueHead() + 2,
            address(usdc),
            address(okuMoney)
        );

        // Should have 1 entry left
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_ProcessQueue_StopsWhenBufferDepleted() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        // Only provide enough USDC for 1 entry
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
        );

        // Should have processed only 1
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_ProcessQueue_EmitsEvent() public {
        uint256 okuMoneyAmount = 100e18; // 100 OkuMoney
        uint256 usdcAmount = 100e6; // 100 USDC

        _mintOkuMoney(address(redemptionQueue), okuMoneyAmount);
        redemptionQueue.enqueue(user1, okuMoneyAmount);

        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        vm.expectEmit(true, false, false, true);
        emit RedemptionProcessed(user1, okuMoneyAmount, usdcAmount);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
        );
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
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        // Only provide enough for first entry
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 user2UsdcBefore = usdc.balanceOf(user2);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
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

        assertEq(redemptionQueue.queueLength(), 2);

        // Process one
        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueHead() + 1,
            address(usdc),
            address(okuMoney)
        );

        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_GetQueueEntry_RevertsInvalidIndex() public {
        vm.expectRevert("Invalid index");
        redemptionQueue.getQueueEntry(0);
    }

    // ============ Price Appreciation Tests ============

    /**
     * @notice Verifies that users earn yield while waiting in queue via okuMPrice() appreciation
     * @dev Non-rebasing: the note token count is unchanged, but okuMPrice() increases
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

        // Now increase notePrice - user should earn yield via price appreciation
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2); // 2x price

        // The stored okuMAmount remains the same (non-rebasing)
        RedemptionQueue.QueueEntry memory entryAfterPrice = redemptionQueue.getQueueEntry(0);
        assertEq(entryAfterPrice.okuMAmount, amount); // Still 100e18 okuMAmount

        // But the dollar VALUE has doubled via getQueueEntryValue()
        uint256 currentValue = redemptionQueue.getQueueEntryValue(0);
        assertEq(currentValue, amount * 2); // 200e18 dollar value

        // Process queue and verify user receives the increased amount
        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        // Need 200 USDC (6 decimals) now to match 200e18 dollar value
        _mintUsdc(address(this), 200e6); // 200 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 200e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
        );

        // User should receive 200 USDC (6 decimals) - earned 100% yield via price appreciation
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 200e6);
    }

    /**
     * @notice Verifies price appreciation with multiple users in queue
     */
    function test_QueuePriceAppreciation_MultipleUsers() public {
        // User1 and User2 both queue 100e18
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 100e18);

        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        // Increase notePrice by 50%
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 3 / 2); // 1.5x price

        // Both should now have dollar value of 150e18
        assertEq(redemptionQueue.getQueueEntryValue(0), 150e18);
        assertEq(redemptionQueue.getQueueEntryValue(1), 150e18);

        // Setup for processing
        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), 300e6); // 300 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 300e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 user2UsdcBefore = usdc.balanceOf(user2);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
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

        // Initially value equals original amount (notePrice == 1e18)
        assertEq(redemptionQueue.getQueueEntryValue(0), amount);

        // After 2x notePrice
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 2);
        assertEq(redemptionQueue.getQueueEntryValue(0), amount * 2);

        // After another price increase (total 3x)
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(PRECISION * 3);
        assertEq(redemptionQueue.getQueueEntryValue(0), amount * 3);
    }

    // ============ Fuzz Tests for Price Appreciation ============

    /**
     * @notice Fuzz test: User earns correct yield while queued via notePrice appreciation
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

        // Increase notePrice
        uint256 newPrice = PRECISION + priceIncrease;
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

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
        assertEq(actualValue, expectedValue, "Value should reflect new notePrice");
    }

    /**
     * @notice Fuzz test: User receives correct USDC payout after price appreciation
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

        // Increase notePrice
        uint256 newPrice = PRECISION + priceIncrease;
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

        // Calculate expected payout: okuMAmount * notePrice / PRECISION (dollar value in 18 dec)
        uint256 expectedDollarValue = redemptionQueue.getQueueEntryValue(0);
        // Convert to USDC (6 decimals)
        uint256 expectedPayoutUsdc = expectedDollarValue / DECIMAL_MULTIPLIER;

        // Setup for processing
        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), expectedPayoutUsdc);
        _approveUsdc(address(this), address(redemptionQueue), expectedPayoutUsdc);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
        );

        // User should receive exact expected payout (in USDC - 6 decimals)
        assertEq(
            usdc.balanceOf(user1),
            user1UsdcBefore + expectedPayoutUsdc,
            "User should receive full yield from price appreciation"
        );
        assertEq(redemptionQueue.queueLength(), 0, "Queue should be empty");
    }

    /**
     * @notice Fuzz test: Multiple notePrice increases compound correctly
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
        okuMoney.updateOkuMPrice(price1);

        // Second price increase
        uint256 price2 = price1 + increase2;
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(price2);

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
        assertEq(redemptionQueue.queueLength(), numUsers, "Queue should have all users");

        // Setup for processing - convert note dollar value to USDC
        // At 1x notePrice, dollar value == okuMAmount
        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        uint256 totalNeededUsdc = totalNeeded / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), totalNeededUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalNeededUsdc);

        // Process all
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
        );

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

            _mintOkuMoney(address(redemptionQueue), amounts[i]);
            redemptionQueue.enqueue(users[i], amounts[i]);

            initialBalances[i] = usdc.balanceOf(users[i]);

            if (i < numToProcess) {
                totalForProcessed += amounts[i];
            }
        }

        // Setup - only provide enough USDC for the ones we'll process
        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        uint256 totalForProcessedUsdc = totalForProcessed / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), totalForProcessedUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalForProcessedUsdc);

        // Process only numToProcess
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueHead() + numToProcess,
            address(usdc),
            address(okuMoney)
        );

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
     * @notice Fuzz test: FIFO with price appreciation - each user gets correct price-adjusted amount
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

        // Increase notePrice
        uint256 newPrice = PRECISION + priceIncrease;
        vm.prank(rebaser);
        okuMoney.updateOkuMPrice(newPrice);

        // Calculate total needed after price appreciation
        uint256 totalNeededUsdc = 0;
        uint256[] memory expectedPayoutsUsdc = new uint256[](numUsers);
        for (uint256 i = 0; i < numUsers; i++) {
            // dollarValue = okuMAmount * notePrice / PRECISION
            uint256 dollarValue = (amounts[i] * newPrice) / PRECISION;
            expectedPayoutsUsdc[i] = dollarValue / DECIMAL_MULTIPLIER;
            totalNeededUsdc += expectedPayoutsUsdc[i];
        }

        // Setup for processing
        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        _mintUsdc(address(this), totalNeededUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalNeededUsdc);

        // Process all
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
        );

        // Verify each user got their price-adjusted amount in FIFO order
        assertEq(redemptionQueue.queueLength(), 0, "Queue should be empty");

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
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        uint256 bufferAmountNotes = amountPerUser * numToPay;
        uint256 bufferAmountUsdc = bufferAmountNotes / DECIMAL_MULTIPLIER;
        uint256 amountPerUserUsdc = amountPerUser / DECIMAL_MULTIPLIER;

        _mintUsdc(address(this), bufferAmountUsdc);
        _approveUsdc(address(this), address(redemptionQueue), bufferAmountUsdc);

        // Try to process all - will stop after numToPay
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
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

            _mintOkuMoney(address(redemptionQueue), amounts[i]);
            redemptionQueue.enqueue(users[i], amounts[i]);

            initialBalances[i] = usdc.balanceOf(users[i]);
            totalQueued += amounts[i];
        }

        // Setup - provide enough for roughly half
        vm.prank(admin);
        okuMoney.grantRole(MINTER, address(redemptionQueue));

        // Convert to USDC amount inline
        uint256 bufferUsdc = (totalQueued / 2) / DECIMAL_MULTIPLIER;

        _mintUsdc(address(this), bufferUsdc);
        _approveUsdc(address(this), address(redemptionQueue), bufferUsdc);

        uint256 queueLengthBefore = redemptionQueue.queueLength();

        // Process
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(),
            redemptionQueue.queueTail(),
            address(usdc),
            address(okuMoney)
        );

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
