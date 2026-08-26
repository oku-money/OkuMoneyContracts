// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {TestConstants} from "../shared/Constants.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockHighDecimalToken} from "../mocks/MockHighDecimalToken.sol";

contract RedemptionQueueTest is BaseTest {
    /// @dev Queue a redemption against an EMPTY buffer.
    ///
    ///      Mints raw directly rather than through the PSM. Routing through
    ///      `mint` would deposit the caller's USDC into the buffer, and draining
    ///      it back out afterwards is blocked by `WouldStrandQueue` as soon as one
    ///      entry is already outstanding — so the second queued entry would settle
    ///      instantly instead of queueing. Keeping the buffer at zero makes the
    ///      queue path deterministic.
    function _queueRaw(address user, uint256 rawAmount) internal {
        _mintRaw(user, rawAmount);
        vm.startPrank(user);
        token.approve(address(module), rawAmount);
        module.redeem(rawAmount);
        vm.stopPrank();
    }

    /// @dev Three queued entries worth 1k / 2k / 3k dollars at a unit multiplier.
    function _queueThree() internal {
        _queueRaw(user1, 1000e18);
        _queueRaw(user2, 2000e18);
        _queueRaw(user3, 3000e18);
    }

    // ============ Enqueue ============

    function test_Enqueue_RecordsAndEscrows() public {
        _queueRaw(user1, 1000e18);
        assertEq(queue.queueLength(), 1);
        assertEq(queue.totalQueuedRaw(), 1000e18);
        assertEq(token.balanceOf(address(queue)), 1000e18);
        assertEq(queue.getQueueEntry(0).user, user1);
        assertEq(queue.getQueueEntry(0).rawAmount, 1000e18);
    }

    function test_Enqueue_RequiresQueuePsmRole() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        queue.enqueue(user1, 1e18, 0);
    }

    /// @notice `QUEUE_PSM` is deliberately not granted at init, so even the deploy
    ///         admin cannot enqueue directly.
    function test_Enqueue_AdminCannotBypassPsm() public {
        vm.prank(admin);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        queue.enqueue(user1, 1e18, 0);
    }

    // ============ Process ============

    function test_ProcessQueue_ProcessesBatchInOrder() public {
        _queueThree();
        _seedBuffer(10_000e6);

        uint256 owed = queue.totalQueuedUsdc();
        vm.prank(queueProcessor);
        module.processQueue(0, 3, owed);

        assertEq(queue.totalQueuedRaw(), 0);
        assertEq(token.balanceOf(address(queue)), 0);
        // Payouts are net of the `tout` snapshotted on each entry, which is
        // nonzero by default now that fees ship at the step-coverage floor.
        assertApproxEqAbs(usdc.balanceOf(user1), _afterTout(1000e6), 1);
        assertApproxEqAbs(usdc.balanceOf(user2), _afterTout(2000e6), 1);
        assertApproxEqAbs(usdc.balanceOf(user3), _afterTout(3000e6), 1);
        assertEq(token.totalSupply(), 0);
    }

    /// @notice Breaks (does not skip) on insufficient funds, so ordering is FIFO
    ///         and a later entry cannot jump a queue it could have afforded.
    function test_ProcessQueue_BreaksOnInsufficientFunds() public {
        _queueThree();
        _seedBuffer(1500e6); // enough for entry 0 only

        vm.prank(queueProcessor);
        module.processQueue(0, 3, 1500e6);

        assertApproxEqAbs(usdc.balanceOf(user1), _afterTout(1000e6), 1);
        assertEq(usdc.balanceOf(user2), 0, "must not skip ahead");
        assertEq(usdc.balanceOf(user3), 0);
        assertGt(queue.totalQueuedRaw(), 0);
    }

    /// @notice A recipient whose USDC transfer REVERTS (Circle blacklist shape) is
    ///         soft-skipped so one stuck user cannot block the queue.
    function test_ProcessQueue_SoftSkipsOnRevertingTransfer() public {
        _queueThree();
        _seedBuffer(10_000e6);
        usdc.setBlocked(user2, true);

        uint256 owed = queue.totalQueuedUsdc();
        vm.prank(queueProcessor);
        module.processQueue(0, 3, owed);

        assertGt(usdc.balanceOf(user1), 0);
        assertEq(usdc.balanceOf(user2), 0, "skipped");
        assertGt(usdc.balanceOf(user3), 0, "but the queue kept moving");
        assertEq(queue.getQueueEntry(1).user, user2, "entry retained for rescue");
    }

    /// @notice A non-standard ERC-20 returning `false` without reverting must be
    ///         soft-skipped, not treated as paid.
    function test_ProcessQueue_SoftSkipsOnReturnFalse() public {
        _queueThree();
        _seedBuffer(10_000e6);
        usdc.setReturnFalse(user2, true);

        uint256 owed = queue.totalQueuedUsdc();
        vm.prank(queueProcessor);
        module.processQueue(0, 3, owed);

        assertEq(usdc.balanceOf(user2), 0);
        assertEq(queue.getQueueEntry(1).user, user2, "not cleared, so not paid");
        assertGt(usdc.balanceOf(user3), 0);
    }

    function test_ProcessQueue_SoftSkipsAlreadyClearedEntry() public {
        _queueThree();
        _seedBuffer(10_000e6);

        uint256 owed = queue.totalQueuedUsdc();
        vm.prank(queueProcessor);
        module.processQueue(0, 2, owed);

        // Re-processing the same range must not double-pay.
        uint256 balBefore = usdc.balanceOf(user1);
        vm.prank(queueProcessor);
        module.processQueue(0, 2, owed);
        assertEq(usdc.balanceOf(user1), balBefore, "cleared entries are inert");
    }

    /// @notice The multiplier is read once per batch, so every entry in a batch is
    ///         priced identically regardless of position.
    function test_ProcessQueue_MultiplierCachedPerBatch() public {
        _queueRaw(user1, 1000e18);
        _queueRaw(user2, 1000e18);

        _accrue(RATE_5_PCT_APY, 20 days);
        _seedBuffer(10_000e6);

        uint256 owed = queue.totalQueuedUsdc();
        vm.prank(queueProcessor);
        module.processQueue(0, 2, owed);

        assertEq(usdc.balanceOf(user1), usdc.balanceOf(user2), "identical entries pay identically");
        assertGt(usdc.balanceOf(user1), 1000e6, "and both received the accrual");
    }

    // ============ Rescue ============

    function test_RescueQueueEntry_ReturnsTokensWithoutBurning() public {
        _queueThree();
        uint256 supplyBefore = token.totalSupply();
        uint256 rawEntry = queue.getQueueEntry(1).rawAmount;

        vm.prank(queueRescuer);
        queue.rescueQueueEntry(1, user2);

        assertEq(token.balanceOf(user2), rawEntry, "tokens returned");
        assertEq(token.totalSupply(), supplyBefore, "not burned");
        assertEq(queue.getQueueEntry(1).user, address(0), "entry cleared");
    }

    /// @notice Rescue must decrement the escrow total, or the backing invariant
    ///         breaks immediately.
    function test_RescueQueueEntry_DecrementsTotalQueuedRaw() public {
        _queueThree();
        uint256 before = queue.totalQueuedRaw();
        uint256 rawEntry = queue.getQueueEntry(1).rawAmount;

        vm.prank(queueRescuer);
        queue.rescueQueueEntry(1, user2);

        assertEq(queue.totalQueuedRaw(), before - rawEntry);
        assertLe(queue.totalQueuedRaw(), token.balanceOf(address(queue)));
    }

    function test_RescueQueueEntry_RequiresRole() public {
        _queueThree();
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        queue.rescueQueueEntry(0, user1);
    }

    function test_RescueQueueEntry_AlreadyClearedReverts() public {
        _queueThree();
        vm.startPrank(queueRescuer);
        queue.rescueQueueEntry(0, user1);
        vm.expectRevert(RedemptionQueue.EntryAlreadyCleared.selector);
        queue.rescueQueueEntry(0, user1);
        vm.stopPrank();
    }

    function test_RescueQueueEntry_InvalidIndexReverts() public {
        _queueThree();
        vm.prank(queueRescuer);
        vm.expectRevert(RedemptionQueue.InvalidIndex.selector);
        queue.rescueQueueEntry(99, user1);
    }

    function test_RescueQueueEntry_ZeroRecipientReverts() public {
        _queueThree();
        vm.prank(queueRescuer);
        vm.expectRevert(Errors.ZeroAddress.selector);
        queue.rescueQueueEntry(0, address(0));
    }

    // ============ advanceHead ============

    function test_AdvanceHead_IsPermissionlessAndForwardOnly() public {
        _queueThree();
        _seedBuffer(10_000e6);
        uint256 owed = queue.totalQueuedUsdc();
        vm.prank(queueProcessor);
        module.processQueue(0, 3, owed);

        assertEq(queue.queueHead(), 0, "processing does not auto-advance");
        assertEq(queue.queueLength(), 3, "so length is an upper bound");

        // Anyone may call it.
        vm.prank(user5);
        uint256 advanced = queue.advanceHead(10);
        assertEq(advanced, 3);
        assertEq(queue.queueHead(), 3);
        assertEq(queue.queueLength(), 0);

        // Idempotent.
        vm.prank(user5);
        assertEq(queue.advanceHead(10), 0);
    }

    function test_AdvanceHead_StopsAtLiveEntry() public {
        _queueThree();
        _seedBuffer(1500e6);
        vm.prank(queueProcessor);
        module.processQueue(0, 3, 1500e6);

        queue.advanceHead(10);
        assertEq(queue.queueHead(), 1, "stops at the first live entry");
    }

    function test_AdvanceHead_GasBounded() public {
        _queueThree();
        _seedBuffer(10_000e6);
        uint256 owed = queue.totalQueuedUsdc();
        vm.prank(queueProcessor);
        module.processQueue(0, 3, owed);

        assertEq(queue.advanceHead(1), 1, "respects maxSlots");
        assertEq(queue.queueHead(), 1);
    }

    // ============ Donation sweep ============

    /// @notice `totalQueuedRaw <= balanceOf(queue)` is a BOUND, not an equality:
    ///         anyone can donate tokens for free. Without a sweep the surplus
    ///         would be stranded forever.
    function test_SweepExcess_RecoversDonationOnly() public {
        uint256 escrowed = 1000e18;
        _queueRaw(user1, escrowed);

        _mintRaw(user5, 77e18);
        vm.prank(user5);
        token.transfer(address(queue), 77e18);

        assertEq(token.balanceOf(address(queue)), escrowed + 77e18);
        assertEq(queue.totalQueuedRaw(), escrowed);

        vm.prank(queueRescuer);
        queue.sweepExcess(treasury);

        assertEq(token.balanceOf(treasury), 77e18, "only the donation");
        assertEq(token.balanceOf(address(queue)), escrowed, "escrow untouched");
        assertEq(queue.totalQueuedRaw(), escrowed);
    }

    /// @notice The sweep is capped at the surplus, so it provably cannot reach
    ///         escrowed user funds.
    function test_SweepExcess_NoSurplusReverts() public {
        _queueRaw(user1, 1000e18);
        vm.prank(queueRescuer);
        vm.expectRevert(RedemptionQueue.NoExcessToSweep.selector);
        queue.sweepExcess(treasury);
    }

    function test_SweepExcess_RequiresRole() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        queue.sweepExcess(treasury);
    }

    function test_SweepExcess_ZeroRecipientReverts() public {
        vm.prank(queueRescuer);
        vm.expectRevert(Errors.ZeroAddress.selector);
        queue.sweepExcess(address(0));
    }

    // ============ Views ============

    function test_TotalQueuedUsdc_IsMultiplierAware() public {
        _queueRaw(user1, 1000e18);
        assertApproxEqAbs(queue.totalQueuedUsdc(), 1000e6, 1);
        _accrue(RATE_5_PCT_APY, Constants.MAX_RATE_DURATION);
        assertGt(queue.totalQueuedUsdc(), 1000e6);
    }

    function test_GetQueueEntryValue() public {
        _queueRaw(user1, 1000e18);
        assertEq(queue.getQueueEntryValue(0), module.quoteRedeem(1000e18));
    }

    function test_GetQueueEntry_OutOfRangeReverts() public {
        vm.expectRevert(RedemptionQueue.InvalidIndex.selector);
        queue.getQueueEntry(0);
    }

    // ============ Init cross-assertions ============

    function test_Initialize_AssetMismatchReverts() public {
        MockUSDC other = new MockUSDC();
        RedemptionQueue impl = new RedemptionQueue();
        vm.expectPartialRevert(RedemptionQueue.AssetMismatch.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(RedemptionQueue.initialize, (address(token), address(other), admin))
        );
    }

    function test_Initialize_ZeroAddressReverts() public {
        RedemptionQueue impl = new RedemptionQueue();
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(RedemptionQueue.initialize, (address(token), address(usdc), address(0)))
        );
    }

    /// @notice The queue must not hold `QUEUE_PSM` for anyone at init.
    function test_Initialize_DoesNotGrantQueuePsm() public view {
        assertFalse(queue.hasRole(keccak256("QUEUE_PSM"), admin));
        assertTrue(queue.hasRole(keccak256("QUEUE_PSM"), address(module)));
    }
}
