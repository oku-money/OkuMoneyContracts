// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {RedemptionQueueEvents} from "../../src/lib/events/RedemptionQueueEvents.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {MockHighDecimalToken} from "../mocks/MockHighDecimalToken.sol";

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

    /// @notice `address(0)` is the "slot cleared" sentinel — it must never be
    ///         storable as a real entry.
    /// @dev A zero-user entry would be permanently unprocessable (processQueue
    ///      soft-skips it as AlreadyCleared) AND unrescuable, while
    ///      `totalQueuedOkuM` is never decremented for it — permanently
    ///      inflating `totalQueuedUsdc()` and so permanently blocking
    ///      `LitePSM.withdrawUsdc` via WouldStrandQueue. Unreachable via the
    ///      sole caller today, but `enqueue` is a role-gated external entry
    ///      point and the sentinel collision is load-bearing.
    function test_Enqueue_RevertsOnZeroAddressUser() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        vm.expectRevert(Errors.ZeroAddress.selector);
        redemptionQueue.enqueue(address(0), 100e18);
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

    /// @dev Pins the storage layout: an entry is two slots, `user | timestamp << 160` then
    ///      `okuMAmount`, under the ERC-7201 namespace (queue mapping is the first member).
    function test_Enqueue_EntryPacksIntoTwoSlots() public {
        bytes32 base = 0xa62273ae8f4f9b4de76a6f11e9bbf5ca0a9c42e1f4bbbcb4369e173f90b6e000;
        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);

        bytes32 entrySlot = keccak256(abi.encode(uint256(0), base));
        bytes32 slot0 = vm.load(address(redemptionQueue), entrySlot);
        bytes32 slot1 = vm.load(address(redemptionQueue), bytes32(uint256(entrySlot) + 1));
        bytes32 slot2 = vm.load(address(redemptionQueue), bytes32(uint256(entrySlot) + 2));

        assertEq(slot0, bytes32(uint256(uint160(user1)) | (block.timestamp << 160)));
        assertEq(uint256(slot1), 100e18);
        assertEq(uint256(slot2), 0, "no third slot");
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

        uint256 dollarValue =
            Math.mulDiv(amount, okuMoney.okuMMultiplier(), PRECISION, Math.Rounding.Floor);
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
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, QUEUE_PSM
            )
        );
        redemptionQueue.processQueue(0, 10);
    }

    function test_ProcessQueue_BurnsOkuMoney() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        uint256 queueBalanceBefore = okuMoney.balanceOf(address(redemptionQueue));

        // Setup: approve USDC for transfer
        // At 1x okuMMultiplier, usdcAmount = okuMAmount * okuMMultiplier / PRECISION / DECIMAL_MULTIPLIER
        uint256 usdcAmount = Math.mulDiv(
            amount, okuMoney.okuMMultiplier(), PRECISION, Math.Rounding.Floor
        ) / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());

        assertEq(okuMoney.balanceOf(address(redemptionQueue)), queueBalanceBefore - amount);
    }

    /// @notice Documents the ACTUAL consequence of a RedemptionQueue wired to the wrong
    ///         OkuMoney instance (the gap closed by `LitePSM.initialize`'s
    ///         `QueueOkuMoneyMismatch` check) — correcting an incorrect assumption that
    ///         such a mismatch "silently burns the wrong token after paying real USDC".
    ///         It does not: `processQueue` burns via `$.okuMoney` (the queue's OWN wired
    ///         reference), so a queue pointed at an unrelated OkuMoney calls `burn` on
    ///         THAT token as itself — a call it holds neither balance nor `OKUM_BURNER`
    ///         on. That revert is unguarded by design (see the DELIBERATELY UNGUARDED
    ///         comment in `RedemptionQueue.processQueue`), so it unwinds the ENTIRE
    ///         transaction, including the USDC already paid to the user earlier in the
    ///         same call — the batch is fail-closed, not silently corrupting state. The
    ///         real escrowed OkuMoney (sent here by whatever actually funded the queue)
    ///         is untouched and recoverable; it just can never be processed through this
    ///         misconfigured queue. This is exactly why `LitePSM.initialize` now rejects
    ///         the mismatch up front rather than relying on this revert as a safety net.
    function test_ProcessQueue_MismatchedOkuMoney_RevertsEntireBatch_NoSilentCorruption() public {
        // A second, unrelated OkuMoney instance — NOT the one actually escrowed in the
        // queue below.
        OkuMoney otherOkuMoneyImpl = new OkuMoney();
        bytes memory otherInit =
            abi.encodeCall(OkuMoney.initialize, ("Other", "OTH", admin, MAX_SUPPLY));
        OkuMoney otherOkuMoney =
            OkuMoney(address(new ERC1967Proxy(address(otherOkuMoneyImpl), otherInit)));

        // A queue wired to `otherOkuMoney` instead of the suite's `okuMoney`, with
        // `QUEUE_PSM` granted directly to this test contract (bypassing LitePSM
        // entirely — mirroring how every other test in this file exercises the queue in
        // isolation, and standing in for what `LitePSM.initialize`'s new check now
        // prevents from ever being reachable via the real deploy path).
        RedemptionQueue mismatchedQueueImpl = new RedemptionQueue();
        bytes memory queueInit = abi.encodeCall(
            RedemptionQueue.initialize, (address(otherOkuMoney), address(usdc), admin)
        );
        RedemptionQueue mismatchedQueue =
            RedemptionQueue(address(new ERC1967Proxy(address(mismatchedQueueImpl), queueInit)));
        vm.prank(admin);
        mismatchedQueue.grantRole(QUEUE_PSM, address(this));

        // The REAL okuMoney is what actually gets escrowed (exactly as LitePSM would
        // transfer it in before calling enqueue) — the mismatch is already damage-done
        // by this point, regardless of what happens next.
        uint256 amount = 100e18;
        _mintOkuMoney(address(mismatchedQueue), amount);
        mismatchedQueue.enqueue(user1, amount);

        uint256 usdcAmount = Math.mulDiv(
            amount, okuMoney.okuMMultiplier(), PRECISION, Math.Rounding.Floor
        ) / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(mismatchedQueue), usdcAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 realOkuMoneyEscrowBefore = okuMoney.balanceOf(address(mismatchedQueue));

        // Precompute args BEFORE expectRevert: `queueHead()`/`queueTail()` are external
        // staticcalls through the proxy, and `vm.expectRevert` latches onto the very next
        // external call — evaluating them inline as `processQueue` arguments would
        // consume the cheatcode on the view call instead of on `processQueue` itself.
        uint256 head = mismatchedQueue.queueHead();
        uint256 tail = mismatchedQueue.queueTail();

        // Reverts inside the unguarded `otherOkuMoney.burn(...)` call (the queue holds
        // neither OKUM_BURNER nor any balance on `otherOkuMoney`) — unwinding the whole
        // batch, including the USDC transfer to user1 that executed earlier in this same
        // call.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(mismatchedQueue),
                OKUM_BURNER
            )
        );
        mismatchedQueue.processQueue(head, tail);

        // Nothing moved: no USDC paid, no real OkuMoney escrow touched.
        assertEq(usdc.balanceOf(user1), user1UsdcBefore);
        assertEq(okuMoney.balanceOf(address(mismatchedQueue)), realOkuMoneyEscrowBefore);
    }

    function test_ProcessQueue_TransfersUSDC() public {
        uint256 okuMoneyAmount = 100e18; // 100 OkuMoney
        uint256 usdcAmount = 100e6; // 100 USDC (6 decimals) at 1x okuMMultiplier

        _mintOkuMoney(address(redemptionQueue), okuMoneyAmount);
        redemptionQueue.enqueue(user1, okuMoneyAmount);

        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());

        // User should receive USDC (6 decimals), not OkuMoney amount (18 decimals)
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + usdcAmount);
    }

    function test_ProcessQueue_AdvancesQueueHead() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        assertEq(redemptionQueue.queueLength(), 2);

        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        // Process only 1 entry
        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueHead() + 1);

        // processQueue no longer auto-advances; caller drives head forward via advanceHead.
        redemptionQueue.advanceHead(2);

        // Queue head should now have advanced, length decreases
        assertEq(redemptionQueue.queueLength(), 1);

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

        _mintUsdc(address(this), 300e6); // 300 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 300e6);

        // Process only 2 entries
        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueHead() + 2);
        redemptionQueue.advanceHead(3);

        // Should have 1 entry left
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_ProcessQueue_StopsWhenBufferDepleted() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 100e18);

        // Only provide enough USDC for 1 entry
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());
        redemptionQueue.advanceHead(2);

        // Should have processed only 1
        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_ProcessQueue_EmitsEvent() public {
        uint256 okuMoneyAmount = 100e18;
        uint256 usdcAmount = 100e6;

        _mintOkuMoney(address(redemptionQueue), okuMoneyAmount);
        redemptionQueue.enqueue(user1, okuMoneyAmount);
        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        vm.warp(block.timestamp + 1 hours);
        vm.expectEmit(true, false, false, true);
        emit RedemptionProcessed(user1, okuMoneyAmount, 100e18, usdcAmount, 1 hours);
        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());
    }

    function test_ProcessQueue_FIFO_Order() public {
        // Enqueue in order: user1, user2, user3
        _mintOkuMoney(address(redemptionQueue), 100e18);
        _mintOkuMoney(address(redemptionQueue), 200e18);
        _mintOkuMoney(address(redemptionQueue), 300e18);

        redemptionQueue.enqueue(user1, 100e18);
        redemptionQueue.enqueue(user2, 200e18);
        redemptionQueue.enqueue(user3, 300e18);

        // Only provide enough for first entry
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 user2UsdcBefore = usdc.balanceOf(user2);

        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());

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
        _mintUsdc(address(this), 100e6); // 100 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 100e6);
        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueHead() + 1);
        // queueLength is now an upper bound until advanceHead runs.
        redemptionQueue.advanceHead(2);

        assertEq(redemptionQueue.queueLength(), 1);
    }

    function test_GetQueueEntry_RevertsInvalidIndex() public {
        vm.expectRevert(RedemptionQueue.InvalidIndex.selector);
        redemptionQueue.getQueueEntry(0);
    }

    /// @notice `getQueueEntryValue` bounds-checks independently of `getQueueEntry`.
    /// @dev Both read the same `[queueHead, queueTail)` window but neither delegates
    ///      to the other, so the rail has to be asserted on each. Unguarded, this one
    ///      would read a zeroed slot and quote a $0 valuation for a non-existent
    ///      entry — a plausible-looking number rather than a failure, which is the
    ///      worse outcome for an operator script sizing a batch.
    function test_GetQueueEntryValue_RevertsInvalidIndex() public {
        vm.expectRevert(RedemptionQueue.InvalidIndex.selector);
        redemptionQueue.getQueueEntryValue(0);
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

        // Need 200 USDC (6 decimals) now to match 200e18 dollar value
        _mintUsdc(address(this), 200e6); // 200 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 200e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());

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

        _mintUsdc(address(this), 300e6); // 300 USDC (6 decimals)
        _approveUsdc(address(this), address(redemptionQueue), 300e6);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        uint256 user2UsdcBefore = usdc.balanceOf(user2);

        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());

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
        // setOkuMMultiplier requires strict increase, so the increment is bounded
        // away from zero.
        priceIncrease = bound(priceIncrease, 1, PRECISION * 9); // Up to 10x total

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
        uint256 expectedValue =
            Math.mulDiv(initialNoteAmount, newPrice, PRECISION, Math.Rounding.Floor);
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

        _mintUsdc(address(this), expectedPayoutUsdc);
        _approveUsdc(address(this), address(redemptionQueue), expectedPayoutUsdc);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);

        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());
        redemptionQueue.advanceHead(redemptionQueue.queueTail());

        // User should receive exact expected payout (in USDC - 6 decimals)
        assertEq(
            usdc.balanceOf(user1),
            user1UsdcBefore + expectedPayoutUsdc,
            "User should receive full yield from multiplier appreciation"
        );
        assertEq(redemptionQueue.queueLength(), 0, "Queue should be empty");
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
        uint256 expectedValue =
            Math.mulDiv(initialNoteAmount, price2, PRECISION, Math.Rounding.Floor);
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
        // At 1x okuMMultiplier, dollar value == okuMAmount

        uint256 totalNeededUsdc = totalNeeded / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), totalNeededUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalNeededUsdc);

        // Process all
        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());
        redemptionQueue.advanceHead(numUsers);

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

        uint256 totalForProcessedUsdc = totalForProcessed / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), totalForProcessedUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalForProcessedUsdc);

        // Process only numToProcess
        redemptionQueue.processQueue(
            redemptionQueue.queueHead(), redemptionQueue.queueHead() + numToProcess
        );
        redemptionQueue.advanceHead(numToProcess);

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
            uint256 dollarValue = Math.mulDiv(amounts[i], newPrice, PRECISION, Math.Rounding.Floor);
            expectedPayoutsUsdc[i] = dollarValue / DECIMAL_MULTIPLIER;
            totalNeededUsdc += expectedPayoutsUsdc[i];
        }

        // Setup for processing

        _mintUsdc(address(this), totalNeededUsdc);
        _approveUsdc(address(this), address(redemptionQueue), totalNeededUsdc);

        // Process all
        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());
        redemptionQueue.advanceHead(numUsers);

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

        uint256 bufferAmountNotes = amountPerUser * numToPay;
        uint256 bufferAmountUsdc = bufferAmountNotes / DECIMAL_MULTIPLIER;
        uint256 amountPerUserUsdc = amountPerUser / DECIMAL_MULTIPLIER;

        _mintUsdc(address(this), bufferAmountUsdc);
        _approveUsdc(address(this), address(redemptionQueue), bufferAmountUsdc);

        // Try to process all - will stop after numToPay
        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());
        redemptionQueue.advanceHead(numToPay);

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

        // Convert to USDC amount inline
        uint256 bufferUsdc = (totalQueued / 2) / DECIMAL_MULTIPLIER;

        _mintUsdc(address(this), bufferUsdc);
        _approveUsdc(address(this), address(redemptionQueue), bufferUsdc);

        uint256 queueLengthBefore = redemptionQueue.queueLength();

        // Process
        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());
        redemptionQueue.advanceHead(numUsers);

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
        vm.expectRevert(Errors.ZeroAddress.selector);
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

    function test_RescueQueueEntry_FirstThenAdvanceHead() public {
        uint256 amount = 500e18;

        // Enqueue 3 entries
        _mintOkuMoney(address(redemptionQueue), amount * 3);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);
        redemptionQueue.enqueue(user3, amount);

        assertEq(redemptionQueue.queueHead(), 0);
        assertEq(redemptionQueue.queueTail(), 3);

        // Rescue the first entry — head does NOT auto-advance.
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user1);
        assertEq(redemptionQueue.queueHead(), 0, "Rescue must not auto-advance head");

        // advanceHead is the explicit cursor advance.
        uint256 advanced = redemptionQueue.advanceHead(3);
        assertEq(advanced, 1, "Exactly one cleared slot was skipped");
        assertEq(redemptionQueue.queueHead(), 1, "Head should advance after advanceHead");
    }

    function test_RescueQueueEntry_DoesNotAdvanceHeadWhenMiddle() public {
        uint256 amount = 500e18;

        // Enqueue 3 entries
        _mintOkuMoney(address(redemptionQueue), amount * 3);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);
        redemptionQueue.enqueue(user3, amount);

        assertEq(redemptionQueue.queueHead(), 0);

        // Rescue the middle entry — head should not move even after advanceHead
        // because index 0 is still live.
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(1, user2);
        redemptionQueue.advanceHead(3);

        assertEq(redemptionQueue.queueHead(), 0, "Head should not advance when middle is cleared");
    }

    function test_RescueQueueEntry_ProcessQueueAfterRescue() public {
        uint256 amount = 500e18;

        // Enqueue 3 entries
        _mintOkuMoney(address(redemptionQueue), amount * 3);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);
        redemptionQueue.enqueue(user3, amount);

        // Grant queue the ability to burn

        // Rescue the first entry (stuck)
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user1);

        // Now process remaining entries
        uint256 usdcNeeded = (amount * 2) / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcNeeded);
        _approveUsdc(address(this), address(redemptionQueue), usdcNeeded);

        uint256 user2UsdcBefore = usdc.balanceOf(user2);
        uint256 user3UsdcBefore = usdc.balanceOf(user3);

        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());

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
        // Process one entry, advance head past index 0, then try to re-process from 0.
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        uint256 usdcAmount = amount / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);
        redemptionQueue.processQueue(0, 1);
        // processQueue no longer auto-advances; drive the cursor forward explicitly.
        redemptionQueue.advanceHead(1);
        assertEq(redemptionQueue.queueHead(), 1);

        vm.expectRevert(RedemptionQueue.StartBelowHead.selector);
        redemptionQueue.processQueue(0, 1);
    }

    function test_ProcessQueue_RevertEndAboveTail() public {
        // Empty queue — tail == 0, asking for endIndex > 0 must revert.
        vm.expectRevert(RedemptionQueue.EndAboveTail.selector);
        redemptionQueue.processQueue(0, 5);
    }

    function test_AdvanceHead_PastChainOfRescued() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount * 4);

        // Enqueue four entries.
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user1, amount);
        assertEq(redemptionQueue.queueHead(), 0);
        assertEq(redemptionQueue.queueTail(), 4);

        // Rescue indices 0, 1, 2 in order. rescueQueueEntry no longer auto-advances
        // the head, so it stays at 0 throughout.
        vm.startPrank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user2);
        redemptionQueue.rescueQueueEntry(1, user2);
        redemptionQueue.rescueQueueEntry(2, user2);
        vm.stopPrank();
        assertEq(redemptionQueue.queueHead(), 0, "Rescue must not auto-advance");

        // A single advanceHead call drains all contiguous cleared slots up to the cap.
        uint256 advanced = redemptionQueue.advanceHead(10);
        assertEq(advanced, 3, "Three contiguous cleared slots are skipped");
        assertEq(redemptionQueue.queueHead(), 3);
        assertEq(redemptionQueue.queueTail(), 4);
    }

    function test_AdvanceHead_RespectsMaxSlots() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount * 4);

        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user1, amount);

        // Clear the first three slots.
        vm.startPrank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user2);
        redemptionQueue.rescueQueueEntry(1, user2);
        redemptionQueue.rescueQueueEntry(2, user2);
        vm.stopPrank();

        // Cap to 2 slots — head should land at 2, not 3.
        uint256 advanced = redemptionQueue.advanceHead(2);
        assertEq(advanced, 2);
        assertEq(redemptionQueue.queueHead(), 2);

        // A second call finishes the job.
        advanced = redemptionQueue.advanceHead(10);
        assertEq(advanced, 1);
        assertEq(redemptionQueue.queueHead(), 3);
    }

    function test_AdvanceHead_NoopWhenAllLive() public {
        _mintOkuMoney(address(redemptionQueue), 100e18);
        redemptionQueue.enqueue(user1, 100e18);

        uint256 advanced = redemptionQueue.advanceHead(100);
        assertEq(advanced, 0);
        assertEq(redemptionQueue.queueHead(), 0);
    }

    function test_AdvanceHead_NoopWhenEmpty() public {
        // queueHead == queueTail == 0
        uint256 advanced = redemptionQueue.advanceHead(100);
        assertEq(advanced, 0);
        assertEq(redemptionQueue.queueHead(), 0);
    }

    function test_AdvanceHead_StopsAtLiveSlot() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount * 3);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);
        redemptionQueue.enqueue(user3, amount);

        // Clear index 0 only, leave index 1 live.
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user1);

        uint256 advanced = redemptionQueue.advanceHead(10);
        assertEq(advanced, 1, "Should stop at the first live slot");
        assertEq(redemptionQueue.queueHead(), 1);
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

    // ============ TransferFailed Soft-Skip Tests ============
    //
    // Drives the mock-USDC blocked-address path through {RedemptionQueue.processQueue}
    // so the low-level `.call` returns `ok = false` and the entry is soft-skipped via
    // `RedemptionSkipped(i, TransferFailed)` instead of reverting the whole batch.
    // The OkuM for the skipped entry stays in escrow and `totalQueuedOkuM` is NOT
    // decremented; the operator clears it later via `rescueQueueEntry`.

    /// @notice Blocked recipient on a single-entry queue: skip event emitted,
    ///         no OkuM burned, totalQueuedOkuM unchanged, queueHead does NOT advance
    ///         (entry slot still occupied).
    function test_ProcessQueue_TransferFailed_SoftSkipEmitsEvent() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        // Approve USDC for the (would-be) transfer.
        uint256 usdcAmount = Math.mulDiv(
            amount, okuMoney.okuMMultiplier(), PRECISION, Math.Rounding.Floor
        ) / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        // Block user1 so transferFrom returns false without reverting.
        usdc.setBlocked(user1, true);

        uint256 escrowBefore = okuMoney.balanceOf(address(redemptionQueue));
        uint256 totalQueuedBefore = redemptionQueue.totalQueuedOkuM();

        vm.expectEmit(true, false, false, true);
        emit RedemptionQueueEvents.RedemptionSkipped(
            0, RedemptionQueueEvents.RedemptionSkipReason.TransferFailed
        );
        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());

        // OkuM stays in escrow.
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), escrowBefore);
        // Accumulator is NOT decremented.
        assertEq(redemptionQueue.totalQueuedOkuM(), totalQueuedBefore);
        // User got no USDC.
        assertEq(usdc.balanceOf(user1), 0);
        // Entry slot is still populated (not deleted).
        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(0);
        assertEq(entry.user, user1);
        assertEq(entry.okuMAmount, amount);
        // queueHead still 0: _advanceHead does not skip the failed entry because
        // entry.user != address(0).
        assertEq(redemptionQueue.queueHead(), 0);
    }

    /// @notice Interleave blocked + clean users: the blocked one is skipped, the
    ///         clean one is processed in the same batch.
    function test_ProcessQueue_TransferFailed_NextEntryStillProcesses() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount * 3);

        // user1 blocked, user2 clean, user3 blocked.
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);
        redemptionQueue.enqueue(user3, amount);

        usdc.setBlocked(user1, true);
        usdc.setBlocked(user3, true);

        uint256 perEntryUsdc = amount * okuMoney.okuMMultiplier() / PRECISION / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), perEntryUsdc * 3);
        _approveUsdc(address(this), address(redemptionQueue), perEntryUsdc * 3);

        uint256 escrowBefore = okuMoney.balanceOf(address(redemptionQueue));

        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());

        // user2 processed: received USDC, OkuM burned.
        assertEq(usdc.balanceOf(user2), perEntryUsdc);
        // user1 + user3 skipped: no USDC, OkuM still in escrow.
        assertEq(usdc.balanceOf(user1), 0);
        assertEq(usdc.balanceOf(user3), 0);
        // Only user2's OkuM was burned (1 entry of `amount`).
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), escrowBefore - amount);
        // totalQueuedOkuM decremented only by user2's portion.
        assertEq(redemptionQueue.totalQueuedOkuM(), amount * 2);
        // queueHead still 0 (user1's slot blocks advancement).
        assertEq(redemptionQueue.queueHead(), 0);
        // user1 and user3 entries still live.
        assertEq(redemptionQueue.getQueueEntry(0).user, user1);
        assertEq(redemptionQueue.getQueueEntry(2).user, user3);
        // user2's slot is deleted (zeroed but still in [head, tail) range).
        RedemptionQueue.QueueEntry memory cleared = redemptionQueue.getQueueEntry(1);
        assertEq(cleared.user, address(0));
        assertEq(cleared.okuMAmount, 0);
    }

    /// @notice TransferFailed via the *return-false* shape (no revert).
    ///         Hardening regression: before SafeERC20.trySafeTransferFrom was
    ///         introduced here, `transferFrom` returning `false` was treated as
    ///         success and the OkuM would have been burned while the user got
    ///         no USDC. The fix decodes the return data — both this test and
    ///         the revert-shape test above must now route into the same skip
    ///         branch.
    function test_ProcessQueue_TransferFailed_ReturnFalse_IsAlsoSoftSkipped() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        uint256 usdcAmount = Math.mulDiv(
            amount, okuMoney.okuMMultiplier(), PRECISION, Math.Rounding.Floor
        ) / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);

        // Configure MockUSDC to *return false* (no revert) for transfers
        // involving user1. Mirrors a hypothetical non-standard USDC variant.
        usdc.setReturnFalse(user1, true);

        uint256 escrowBefore = okuMoney.balanceOf(address(redemptionQueue));
        uint256 totalQueuedBefore = redemptionQueue.totalQueuedOkuM();

        vm.expectEmit(true, false, false, true);
        emit RedemptionQueueEvents.RedemptionSkipped(
            0, RedemptionQueueEvents.RedemptionSkipReason.TransferFailed
        );
        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());

        // Same post-conditions as the revert-shape test: OkuM in escrow,
        // accumulator unchanged, no USDC paid, slot still occupied.
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), escrowBefore);
        assertEq(redemptionQueue.totalQueuedOkuM(), totalQueuedBefore);
        assertEq(usdc.balanceOf(user1), 0);
        RedemptionQueue.QueueEntry memory entry = redemptionQueue.getQueueEntry(0);
        assertEq(entry.user, user1);
        assertEq(entry.okuMAmount, amount);
        assertEq(redemptionQueue.queueHead(), 0);
    }

    /// @notice After a TransferFailed skip, the queue can be cleared via
    ///         rescueQueueEntry: OkuM is returned to the alternate recipient and
    ///         the queue advances.
    function test_ProcessQueue_TransferFailed_ThenRescueClearsIt() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount);
        redemptionQueue.enqueue(user1, amount);

        // First attempt: blocked -> soft-skip.
        usdc.setBlocked(user1, true);
        uint256 usdcAmount = Math.mulDiv(
            amount, okuMoney.okuMMultiplier(), PRECISION, Math.Rounding.Floor
        ) / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), usdcAmount);
        _approveUsdc(address(this), address(redemptionQueue), usdcAmount);
        redemptionQueue.processQueue(redemptionQueue.queueHead(), redemptionQueue.queueTail());

        // Operator rescues to an alternate recipient (user2).
        uint256 user2OkuMBefore = okuMoney.balanceOf(user2);
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user2);
        // Explicit cursor advance after rescue.
        redemptionQueue.advanceHead(1);

        assertEq(okuMoney.balanceOf(user2), user2OkuMBefore + amount);
        assertEq(redemptionQueue.totalQueuedOkuM(), 0);
        // Slot cleared; head advanced past it.
        assertEq(redemptionQueue.queueHead(), 1);
        assertEq(redemptionQueue.queueLength(), 0);
    }

    /// @notice Drive the `RedemptionSkipped(AlreadyCleared)` branch.
    ///         Path: enqueue three entries [u1, u2, u3], rescue the middle slot
    ///         (index 1), then process the [0,3) range. Index 0 (user1) processes
    ///         normally, index 1 fires AlreadyCleared, index 2 (user3) processes.
    function test_ProcessQueue_AlreadyCleared_SoftSkipEmitsEvent() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount * 3);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);
        redemptionQueue.enqueue(user3, amount);

        // Rescue the middle slot — head stays at 0 because index 0 still live.
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(1, user2);
        assertEq(redemptionQueue.queueHead(), 0);

        uint256 perEntryUsdc = amount * okuMoney.okuMMultiplier() / PRECISION / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), perEntryUsdc * 2);
        _approveUsdc(address(this), address(redemptionQueue), perEntryUsdc * 2);

        vm.expectEmit(true, false, false, true);
        emit RedemptionQueueEvents.RedemptionSkipped(
            1, RedemptionQueueEvents.RedemptionSkipReason.AlreadyCleared
        );
        redemptionQueue.processQueue(0, 3);
        redemptionQueue.advanceHead(3);

        // Both live entries processed; head advanced past all three after advanceHead.
        assertEq(usdc.balanceOf(user1), perEntryUsdc);
        assertEq(usdc.balanceOf(user3), perEntryUsdc);
        assertEq(redemptionQueue.queueHead(), 3);
        assertEq(redemptionQueue.queueLength(), 0);
    }

    /// @notice Drive the `RedemptionSkipped(InsufficientFunds)` branch.
    ///         Approve less USDC than the second entry requires; loop should
    ///         break with InsufficientFunds and stop processing further entries.
    function test_ProcessQueue_InsufficientFunds_EmitsEventAndBreaks() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount * 2);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);

        uint256 perEntryUsdc = amount * okuMoney.okuMMultiplier() / PRECISION / DECIMAL_MULTIPLIER;
        // Fund only the first entry.
        _mintUsdc(address(this), perEntryUsdc);
        _approveUsdc(address(this), address(redemptionQueue), perEntryUsdc);

        vm.expectEmit(true, false, false, true);
        emit RedemptionQueueEvents.RedemptionSkipped(
            1, RedemptionQueueEvents.RedemptionSkipReason.InsufficientFunds
        );
        redemptionQueue.processQueue(0, 2);
        redemptionQueue.advanceHead(2);

        // user1 paid; user2 still queued.
        assertEq(usdc.balanceOf(user1), perEntryUsdc);
        assertEq(usdc.balanceOf(user2), 0);
        // queueHead advanced past user1 (cleared), stopped at user2 (live).
        assertEq(redemptionQueue.queueHead(), 1);
        assertEq(redemptionQueue.queueLength(), 1);
    }

    /// @notice An ALLOWANCE-bound batch must halt with `InsufficientFunds`, exactly like
    ///         a balance-bound one — not misreport as `TransferFailed`.
    /// @dev Regression for the gap between the loop's funding check and how payouts
    ///      actually move. Payouts use `transferFrom`, so the real ceiling is
    ///      `min(balance, allowance)`; the check formerly read balance alone. Here the
    ///      caller holds plenty of USDC but has approved only enough for one entry —
    ///      the shape `LitePSM.processQueue` produces whenever its operator-supplied
    ///      `approveAmount` under-covers the batch.
    ///
    ///      Before the fix the balance check passed, `trySafeTransferFrom` then failed on
    ///      allowance, and the entry surfaced as `TransferFailed` — whose documented
    ///      remedy is `rescueQueueEntry` (see {RedemptionQueueEvents}). An operator
    ///      following that would have returned OkuM to a perfectly healthy user over an
    ///      approval-sizing mistake, and paid full loop-body gas for every remaining
    ///      entry in a batch that could no longer settle.
    function test_ProcessQueue_AllowanceBound_BreaksWithInsufficientFunds() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount * 2);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);

        uint256 perEntryUsdc = Math.mulDiv(
            amount, okuMoney.okuMMultiplier(), PRECISION, Math.Rounding.Floor
        ) / DECIMAL_MULTIPLIER;

        // BALANCE covers both entries; ALLOWANCE covers only the first. This is the
        // distinction the old balance-only check could not see.
        _mintUsdc(address(this), perEntryUsdc * 2);
        _approveUsdc(address(this), address(redemptionQueue), perEntryUsdc);

        vm.expectEmit(true, false, false, true);
        emit RedemptionQueueEvents.RedemptionSkipped(
            1, RedemptionQueueEvents.RedemptionSkipReason.InsufficientFunds
        );
        redemptionQueue.processQueue(0, 2);

        // First entry settled, second untouched and still claimable.
        assertEq(usdc.balanceOf(user1), perEntryUsdc, "first entry should settle");
        assertEq(usdc.balanceOf(user2), 0, "second entry must not settle");
        RedemptionQueue.QueueEntry memory stillQueued = redemptionQueue.getQueueEntry(1);
        assertEq(stillQueued.user, user2, "second entry must remain live, not cleared");
        assertEq(stillQueued.okuMAmount, amount);
        // Only the settled entry's OkuM left escrow.
        assertEq(redemptionQueue.totalQueuedOkuM(), amount, "only entry 0 should decrement");
    }

    /// @notice `burn()` failing must revert the WHOLE batch — no USDC moved, no state
    ///         changed. Pins the fail-closed guarantee the loop depends on.
    /// @dev This is the one call in `processQueue` allowed to revert the batch, and the
    ///      only one running AFTER value has moved. `trySafeTransferFrom` fails BEFORE any
    ///      USDC moves, so soft-skipping it unwinds cleanly; by the time `burn` runs the
    ///      USDC has already reached the user, and the only way to undo that is to revert.
    ///
    ///      Swallowing it would pay the user and leave the OkuM un-burned — unbacked
    ///      supply, created silently. And it would buy nothing: every way `burn` can
    ///      revert (role revoked, this contract blacklisted, balance shortfall) is
    ///      batch-invariant, so a failure for one entry is a failure for all. There are no
    ///      "other users" a soft-skip could rescue.
    ///
    ///      Asserted on a TWO-entry batch whose first entry would otherwise have settled,
    ///      so the test would fail if the revert were ever softened into a skip.
    function test_ProcessQueue_BurnerRoleRevoked_RevertsWholeBatch() public {
        uint256 amount = 100e18;
        _mintOkuMoney(address(redemptionQueue), amount * 2);
        redemptionQueue.enqueue(user1, amount);
        redemptionQueue.enqueue(user2, amount);

        uint256 perEntryUsdc = Math.mulDiv(
            amount, okuMoney.okuMMultiplier(), PRECISION, Math.Rounding.Floor
        ) / DECIMAL_MULTIPLIER;
        _mintUsdc(address(this), perEntryUsdc * 2);
        _approveUsdc(address(this), address(redemptionQueue), perEntryUsdc * 2);

        // Revoke OKUM_BURNER (granted to the queue in BaseTest.setUp) so `burn` reverts on
        // the first entry — after that entry's USDC transfer has already succeeded.
        vm.prank(admin);
        okuMoney.revokeRole(OKUM_BURNER, address(redemptionQueue));

        uint256 queuedBefore = redemptionQueue.totalQueuedOkuM();
        uint256 escrowBefore = okuMoney.balanceOf(address(redemptionQueue));

        // Named: the point is that the BURN authority was revoked, so a bare
        // expectRevert would also accept a pause or bounds failure and the test
        // would pass without exercising the unwind it exists to prove.
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                address(redemptionQueue),
                OKUM_BURNER
            )
        );
        redemptionQueue.processQueue(0, 2);

        // Nothing moved: the revert unwound the in-flight transfer.
        assertEq(usdc.balanceOf(user1), 0, "no USDC may move when the batch reverts");
        assertEq(usdc.balanceOf(user2), 0);
        assertEq(redemptionQueue.totalQueuedOkuM(), queuedBefore, "accounting must be intact");
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), escrowBefore, "escrow intact");
        assertEq(redemptionQueue.getQueueEntry(0).user, user1, "entry 0 must survive");
        assertEq(redemptionQueue.getQueueEntry(1).user, user2, "entry 1 must survive");
        // Recoverable: grant the role and the same batch settles normally.
        vm.prank(admin);
        okuMoney.grantRole(OKUM_BURNER, address(redemptionQueue));
        redemptionQueue.processQueue(0, 2);
        assertEq(usdc.balanceOf(user1), perEntryUsdc, "settles after the role is restored");
        assertEq(usdc.balanceOf(user2), perEntryUsdc);
        assertEq(redemptionQueue.totalQueuedOkuM(), 0);
    }

    // ============ View Getter Tests ============

    function test_View_Usdc() public view {
        assertEq(address(redemptionQueue.usdc()), address(usdc));
    }

    function test_View_UsdcDecimalMultiplier() public view {
        // MockUSDC is 6 decimals; multiplier = 10**(18-6) = 1e12.
        assertEq(redemptionQueue.usdcDecimalMultiplier(), 1e12);
        assertEq(redemptionQueue.usdcDecimalMultiplier(), DECIMAL_MULTIPLIER);
    }

    // ============ Initialization rails ============
    //
    // Relocated from the former CoverageGaps.t.sol.

    function test_Initialize_RevertZeroOkuMoney() public {
        RedemptionQueue impl = new RedemptionQueue();
        bytes memory initData =
            abi.encodeCall(RedemptionQueue.initialize, (address(0), address(usdc), admin));
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroUsdc() public {
        RedemptionQueue impl = new RedemptionQueue();
        bytes memory initData =
            abi.encodeCall(RedemptionQueue.initialize, (address(okuMoney), address(0), admin));
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_Initialize_RevertZeroAdmin() public {
        RedemptionQueue impl = new RedemptionQueue();
        bytes memory initData = abi.encodeCall(
            RedemptionQueue.initialize, (address(okuMoney), address(usdc), address(0))
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    /// @dev The queue derives `usdcDecimalMultiplier` as `10**(18 - decimals)`, so
    ///      anything above 18 underflows the exponent. Rejected at init rather than
    ///      discovered on the first redemption.
    function test_Initialize_RevertUsdcDecimalsTooLarge() public {
        MockHighDecimalToken hd = new MockHighDecimalToken(20);
        RedemptionQueue impl = new RedemptionQueue();
        bytes memory initData =
            abi.encodeCall(RedemptionQueue.initialize, (address(okuMoney), address(hd), admin));
        vm.expectRevert(
            abi.encodeWithSelector(RedemptionQueue.UsdcDecimalsTooLarge.selector, uint8(20))
        );
        new ERC1967Proxy(address(impl), initData);
    }
}
