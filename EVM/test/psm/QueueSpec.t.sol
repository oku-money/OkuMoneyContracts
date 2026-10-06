// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {RedemptionQueueEvents} from "../../src/lib/events/RedemptionQueueEvents.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Deploy} from "../shared/Deploy.sol";
import {OverrideBlockGuard} from "../../src/lib/OverrideBlockGuard.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/// @notice Product-level queue specs, written from intended behaviour (public never
///         overtakes the queue; backend may reorder; blacklisted users are never paid;
///         pause stops all USDC exits; payouts use processing-time value).
/// @dev World model: users mint through the PSM, the operator sweeps USDC to treasury,
///      leaving a thin buffer, so redemptions queue.
contract QueueSpecTest is BaseTest {
    /// 5% APY per second.
    uint256 internal constant RATE_5PCT_APY = 1_000_000_001_547_125_958;

    function setUp() public override {
        super.setUp();
    }

    // ============ World-building helpers ============

    /// @dev User mints OkuM through the PSM with real USDC (USDC lands in the buffer).
    function _userMints(address user, uint256 usdcAmount) internal {
        _mintUsdc(user, usdcAmount);
        _approveUsdc(user, address(litePsm), usdcAmount);
        vm.prank(user);
        litePsm.mintOkuM(usdcAmount);
    }

    /// @dev Operator sweeps the buffer down to `usdcLeft` (what a treasury sweep does).
    function _sweepBufferTo(uint256 usdcLeft) internal {
        uint256 bal = usdc.balanceOf(address(litePsm));
        if (bal > usdcLeft) {
            vm.prank(bufferWithdrawer);
            litePsm.withdrawUsdc(treasury, bal - usdcLeft);
        }
    }

    /// @dev Operator tops the buffer up through the real entry point.
    function _depositBuffer(uint256 usdcAmount) internal {
        _mintUsdc(bufferDepositor, usdcAmount);
        _approveUsdc(bufferDepositor, address(litePsm), usdcAmount);
        vm.prank(bufferDepositor);
        litePsm.depositBuffer(usdcAmount, false, 0, 0, 0);
    }

    function _redeem(address user, uint256 okuMAmount) internal returns (uint256 paid) {
        _approveOkuMoney(user, address(litePsm), okuMAmount);
        vm.prank(user);
        paid = litePsm.redeemOkuM(okuMAmount);
    }

    function _process(uint256 start, uint256 end, uint256 approveAmount) internal {
        vm.prank(queueProcessor);
        litePsm.processQueue(start, end, approveAmount);
    }

    /// @dev Independent of MathLib.rpow.
    function _refPow(uint256 r, uint256 n) internal pure returns (uint256 z) {
        z = 1e18;
        uint256 b = r;
        while (n > 0) {
            if (n & 1 == 1) z = (z * b) / 1e18;
            b = (b * b) / 1e18;
            n >>= 1;
        }
    }

    // ============ 1. The public cannot jump the queue ============

    function test_Spec_NewcomerCannotJumpQueue_AfterPartialRefill() public {
        _userMints(user1, 8000e6);
        _userMints(user2, 2000e6);
        _sweepBufferTo(5000e6);

        assertEq(_redeem(user1, 8000e18), 0, "user1 exceeds buffer -> queued");
        assertEq(redemptionQueue.queueLength(), 1);

        // Operator refills 4000 -> buffer 9000, owed to queue 8000, surplus only 1000.
        _depositBuffer(4000e6);

        uint256 user2UsdcBefore = usdc.balanceOf(user2);
        // 2000 > surplus 1000: must NOT be paid instantly out of the queue's money.
        assertEq(_redeem(user2, 2000e18), 0, "newcomer must be queued behind user1");
        assertEq(usdc.balanceOf(user2), user2UsdcBefore, "newcomer paid ahead of the queue");
        assertEq(redemptionQueue.queueLength(), 2);

        uint256 user1UsdcBefore = usdc.balanceOf(user1);
        _process(0, 2, 9000e6);
        assertEq(usdc.balanceOf(user1), user1UsdcBefore + 8000e6, "head of queue paid in full");
        assertEq(
            usdc.balanceOf(user2), user2UsdcBefore, "second entry not fundable yet (1000 left)"
        );
    }

    function test_Spec_SmallRedeemCannotJump_WhileLargeEntryQueued() public {
        _userMints(user1, 6000e6);
        _userMints(user2, 1000e6);
        _sweepBufferTo(5000e6);

        assertEq(_redeem(user1, 6000e18), 0, "queued: 6000 > 5000 buffer");

        uint256 before = usdc.balanceOf(user2);
        assertEq(_redeem(user2, 1000e18), 0, "1000 would fit the buffer but 6000 is owed first");
        assertEq(usdc.balanceOf(user2), before);
        assertEq(redemptionQueue.queueLength(), 2);
    }

    /// USDC genuinely above the queue's claim stays instantly redeemable.
    function test_Spec_SurplusAboveQueueClaim_IsInstantlyRedeemable() public {
        _userMints(user1, 6000e6);
        _userMints(user2, 4000e6);
        _sweepBufferTo(5000e6);
        assertEq(_redeem(user1, 6000e18), 0);

        _depositBuffer(6000e6); // buffer 11000, owed 6000, surplus 5000

        uint256 before = usdc.balanceOf(user2);
        assertEq(_redeem(user2, 4000e18), 4000e6, "surplus covers it -> instant");
        assertEq(usdc.balanceOf(user2), before + 4000e6);
        assertEq(redemptionQueue.queueLength(), 1, "queue unchanged");
    }

    // ============ 2. Backend can skip an oversized head ============

    function test_Spec_Backend_CanSkipOversizedHead_ViaStartIndex() public {
        _userMints(user1, 6000e6);
        _userMints(user2, 1000e6);
        _userMints(user3, 1000e6);
        _sweepBufferTo(0);

        _redeem(user1, 6000e18);
        _redeem(user2, 1000e18);
        _redeem(user3, 1000e18);
        assertEq(redemptionQueue.queueLength(), 3, "buffer is empty, all three queue");

        _depositBuffer(2500e6);

        // Head entry (6000) cannot be funded -> batch halts, nobody paid.
        _process(0, 3, 2500e6);
        assertEq(usdc.balanceOf(user2), 0, "FIFO halts at the unfundable head");

        // Backend deliberately breaks FIFO: start at index 1.
        _process(1, 3, 2500e6);
        assertEq(usdc.balanceOf(user2), 1000e6);
        assertEq(usdc.balanceOf(user3), 1000e6);
        assertEq(usdc.balanceOf(user1), 0, "oversized head still waiting");

        // Head cannot advance past the live oversized entry.
        redemptionQueue.advanceHead(3);
        assertEq(redemptionQueue.queueHead(), 0);
        assertEq(redemptionQueue.totalQueuedOkuM(), 6000e18);
    }

    // ============ 3. Blacklist semantics ============

    /// redeemUsdOku must not bypass an OkuMoney blacklist.
    function test_Spec_OkuMBlacklisted_CannotQueueViaRedeemUsdOku() public {
        _mintUsdc(user1, 1000e6);
        _approveUsdc(user1, address(litePsm), 1000e6);
        vm.prank(user1);
        litePsm.mintUsdOku(1000e6);
        _sweepBufferTo(0); // anything redeemed must queue
        _approveOkuDollar(user1, address(litePsm), 1000e18);

        vm.prank(blacklister);
        okuMoney.blacklist(user1); // OkuMoney only; OkuDollar blacklist untouched

        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LitePSM.UserBlacklisted.selector, user1));
        litePsm.redeemUsdOku(1000e18);
        assertEq(redemptionQueue.queueLength(), 0, "blacklisted user must not enter the queue");
    }

    function test_Spec_OkuMBlacklisted_CannotInstantRedeemViaRedeemUsdOku() public {
        _mintUsdc(user1, 1000e6);
        _approveUsdc(user1, address(litePsm), 1000e6);
        vm.prank(user1);
        litePsm.mintUsdOku(1000e6); // buffer now holds 1000 USDC

        _approveOkuDollar(user1, address(litePsm), 1000e18);
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        uint256 before = usdc.balanceOf(user1);
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LitePSM.UserBlacklisted.selector, user1));
        litePsm.redeemUsdOku(1000e18);
        assertEq(usdc.balanceOf(user1), before, "blacklisted user was paid USDC");
    }

    function test_Spec_OkuMBlacklisted_CannotMintUsdOku() public {
        vm.prank(blacklister);
        okuMoney.blacklist(user1);

        _mintUsdc(user1, 100e6);
        _approveUsdc(user1, address(litePsm), 100e6);
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LitePSM.UserBlacklisted.selector, user1));
        litePsm.mintUsdOku(100e6);
    }

    function test_Spec_BlacklistedWhileQueued_NotPaid_OthersStillSettle() public {
        _userMints(user1, 5000e6);
        _userMints(user2, 5000e6);
        _userMints(user3, 5000e6);
        _sweepBufferTo(0);
        _redeem(user1, 5000e18);
        _redeem(user2, 5000e18);
        _redeem(user3, 5000e18);
        assertEq(redemptionQueue.queueLength(), 3);

        vm.prank(blacklister);
        okuMoney.blacklist(user2);

        _depositBuffer(15_000e6);
        uint256 supplyBefore = okuMoney.totalSupply();

        _process(0, 3, 15_000e6);

        assertEq(usdc.balanceOf(user1), 5000e6, "user1 paid");
        assertEq(usdc.balanceOf(user3), 5000e6, "user3 paid (not blocked by user2)");
        assertEq(usdc.balanceOf(user2), 0, "blacklisted user must not be paid");
        assertEq(okuMoney.totalSupply(), supplyBefore - 10_000e18, "only paid entries burned");
        assertEq(
            okuMoney.balanceOf(address(redemptionQueue)),
            5000e18,
            "blacklisted user's OkuM stays escrowed"
        );
    }

    // ============ 4. Pause semantics ============

    function test_Spec_WithdrawUsdc_BlockedWhenPsmPaused() public {
        _userMints(user1, 1000e6);
        vm.prank(pauser);
        litePsm.pause();

        vm.prank(bufferWithdrawer);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.withdrawUsdc(treasury, 100e6);
    }

    function test_Spec_OkuMoneyPaused_StopsQueuePayouts() public {
        _userMints(user1, 1000e6);
        _sweepBufferTo(0);
        _redeem(user1, 1000e18);
        _depositBuffer(1000e6);

        vm.prank(pauser);
        okuMoney.pause();

        uint256 psmBefore = usdc.balanceOf(address(litePsm));
        vm.prank(queueProcessor);
        vm.expectRevert(LitePSM.OkuMoneyPaused.selector);
        litePsm.processQueue(0, 1, 1000e6);
        assertEq(usdc.balanceOf(address(litePsm)), psmBefore, "USDC left a frozen system");
        assertEq(usdc.balanceOf(user1), 0);
    }

    // ============ 5. Streaming accrual ============

    /// Paid at processing-time value, checked against an independent power function.
    function test_Spec_StreamingAccrual_PaysProcessingTimeValue() public {
        _userMints(user1, 6000e6);
        _sweepBufferTo(0);

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(RATE_5PCT_APY, block.timestamp + 90 days);

        assertEq(_redeem(user1, 6000e18), 0, "queued");

        vm.warp(block.timestamp + 60 days);
        vm.roll(block.number + 1);

        uint256 expectedUsdc = (6000e18 * _refPow(RATE_5PCT_APY, 60 days) / 1e18) / 1e12;
        assertGt(expectedUsdc, 6000e6, "fixture: yield must have accrued");
        assertLt(expectedUsdc, 6050e6, "fixture: ~0.8% over 60d at 5% APY");

        _depositBuffer(expectedUsdc + 10e6);
        _process(0, 1, expectedUsdc + 10e6);

        assertApproxEqAbs(usdc.balanceOf(user1), expectedUsdc, 1, "paid at processing-time rate");
        assertEq(redemptionQueue.totalQueuedOkuM(), 0);
    }

    /// withdrawUsdc must respect the CURRENT (grown) claim, not the enqueue-time one.
    function test_Spec_StrandCheck_TracksGrowingObligation() public {
        _userMints(user1, 6000e6);
        _sweepBufferTo(0);

        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(RATE_5PCT_APY, block.timestamp + 90 days);
        _redeem(user1, 6000e18);

        vm.warp(block.timestamp + 1 days);
        vm.roll(block.number + 1);

        uint256 owed1 = redemptionQueue.totalQueuedUsdc();
        _depositBuffer(owed1 + 100e6); // 100 USDC of genuine surplus

        // Surplus is withdrawable, one wei more is not.
        vm.prank(bufferWithdrawer);
        vm.expectRevert(abi.encodeWithSelector(LitePSM.WouldStrandQueue.selector, owed1 - 1, owed1));
        litePsm.withdrawUsdc(treasury, 100e6 + 1);

        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(treasury, 100e6);
        assertEq(usdc.balanceOf(address(litePsm)), owed1);

        // 30 more days: the claim has grown past the balance; even 1 wei is now refused.
        vm.warp(block.timestamp + 30 days);
        vm.roll(block.number + 1);
        uint256 owed2 = redemptionQueue.totalQueuedUsdc();
        assertGt(owed2, owed1, "claim grows with the multiplier");

        vm.prank(bufferWithdrawer);
        vm.expectRevert(abi.encodeWithSelector(LitePSM.WouldStrandQueue.selector, owed1 - 1, owed2));
        litePsm.withdrawUsdc(treasury, 1);
    }

    // ============ Frozen (blacklisted-while-queued) entries ============

    function _queueThreeAndBlacklistMiddle() internal {
        _userMints(user1, 5000e6);
        _userMints(user2, 5000e6);
        _userMints(user3, 5000e6);
        _sweepBufferTo(0);
        _redeem(user1, 5000e18);
        _redeem(user2, 5000e18);
        _redeem(user3, 5000e18);
        vm.prank(blacklister);
        okuMoney.blacklist(user2);
    }

    function test_Spec_Freeze_RemovesObligation_AndEmitsEvents() public {
        _queueThreeAndBlacklistMiddle();
        _depositBuffer(15_000e6);

        vm.expectEmit(true, false, false, true);
        emit RedemptionQueueEvents.RedemptionSkipped(
            1, RedemptionQueueEvents.RedemptionSkipReason.Blacklisted
        );
        vm.expectEmit(true, true, false, true);
        emit RedemptionQueueEvents.RedemptionFrozen(1, user2, 5000e18);
        _process(0, 3, 15_000e6);

        assertEq(redemptionQueue.totalQueuedOkuM(), 0, "frozen entry is not a queue obligation");
        assertEq(redemptionQueue.totalFrozenOkuM(), 5000e18);
        assertEq(redemptionQueue.totalQueuedUsdc(), 0);
        assertEq(redemptionQueue.getFrozenEntry(1).user, user2);
        assertEq(redemptionQueue.getQueueEntry(1).user, address(0), "slot cleared");

        // Head can now pass every slot, and the frozen OkuM no longer blocks withdrawals.
        redemptionQueue.advanceHead(3);
        assertEq(redemptionQueue.queueHead(), 3);
        uint256 all = usdc.balanceOf(address(litePsm));
        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(treasury, all);
        assertEq(usdc.balanceOf(address(litePsm)), 0);
    }

    function test_Spec_Freeze_ReleaseSendsOkuM_OnlyRescuer() public {
        _queueThreeAndBlacklistMiddle();
        _depositBuffer(15_000e6);
        _process(0, 3, 15_000e6);

        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, QUEUE_RESCUER
            )
        );
        redemptionQueue.releaseFrozenEntry(1, user1);

        // Blacklisted user can't receive it back, a clean recipient can.
        vm.prank(queueRescuer);
        vm.expectRevert(OkuMoney.RecipientBlacklisted.selector);
        redemptionQueue.releaseFrozenEntry(1, user2);

        vm.prank(unblacklister);
        okuMoney.unblacklist(user2);
        vm.prank(queueRescuer);
        redemptionQueue.releaseFrozenEntry(1, user2);

        assertEq(okuMoney.balanceOf(user2), 5000e18);
        assertEq(redemptionQueue.totalFrozenOkuM(), 0);
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), 0);

        vm.prank(queueRescuer);
        vm.expectRevert(RedemptionQueue.NoFrozenEntry.selector);
        redemptionQueue.releaseFrozenEntry(1, user2);
    }

    function test_Spec_Freeze_FrozenOkuMNotCountedInReserve() public {
        _queueThreeAndBlacklistMiddle();
        _depositBuffer(15_000e6);
        _process(0, 1, 15_000e6); // only user1 paid; user2/user3 untouched
        _process(1, 2, 15_000e6); // freezes user2

        // Obligation = user3's 5000 only; frozen 5000 OkuM is not reserved.
        assertEq(redemptionQueue.totalQueuedUsdc(), 5000e6);
    }

    function test_Spec_Enqueue_RejectsBlacklistedUser() public {
        vm.prank(admin);
        redemptionQueue.grantRole(QUEUE_PSM, address(this));
        vm.prank(blacklister);
        okuMoney.blacklist(user1);
        vm.expectRevert(abi.encodeWithSelector(RedemptionQueue.UserBlacklisted.selector, user1));
        redemptionQueue.enqueue(user1, 100e18);
    }

    // ============ Self-cancel ============

    function _queueOne(address user, uint256 okuM) internal {
        _userMints(user, okuM / 1e12);
        _sweepBufferTo(0);
        _redeem(user, okuM);
    }

    function test_Spec_Cancel_ReturnsOkuMToOwner_AndRemovesObligation() public {
        _queueOne(user1, 1000e18);
        assertEq(okuMoney.balanceOf(user1), 0);

        vm.expectEmit(true, true, false, true);
        emit RedemptionQueueEvents.RedemptionCancelled(0, user1, 1000e18);
        vm.prank(user1);
        redemptionQueue.cancelQueueEntry(0);

        assertEq(okuMoney.balanceOf(user1), 1000e18);
        assertEq(redemptionQueue.totalQueuedOkuM(), 0);
        assertEq(redemptionQueue.totalQueuedUsdc(), 0);
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), 0);
    }

    function test_Spec_Cancel_OnlyOwner_AndOnlyOnce() public {
        _queueOne(user1, 1000e18);

        vm.prank(user2);
        vm.expectRevert(RedemptionQueue.NotEntryOwner.selector);
        redemptionQueue.cancelQueueEntry(0);

        vm.prank(user1);
        redemptionQueue.cancelQueueEntry(0);
        vm.prank(user1);
        vm.expectRevert(RedemptionQueue.EntryAlreadyCleared.selector);
        redemptionQueue.cancelQueueEntry(0);

        vm.prank(user1);
        vm.expectRevert(RedemptionQueue.InvalidIndex.selector);
        redemptionQueue.cancelQueueEntry(99);
    }

    function test_Spec_Cancel_WorksWhilePsmPaused_NoUsdcMoves() public {
        _queueOne(user1, 1000e18);
        vm.prank(pauser);
        litePsm.pause();
        uint256 psmUsdc = usdc.balanceOf(address(litePsm));

        vm.prank(user1);
        redemptionQueue.cancelQueueEntry(0);
        assertEq(okuMoney.balanceOf(user1), 1000e18);
        assertEq(usdc.balanceOf(address(litePsm)), psmUsdc);
    }

    function test_Spec_Cancel_BlacklistedUserCannotCancel() public {
        _queueOne(user1, 1000e18);
        vm.prank(blacklister);
        okuMoney.blacklist(user1);
        vm.prank(user1);
        vm.expectRevert();
        redemptionQueue.cancelQueueEntry(0);
    }

    function test_Spec_Backend_CancelsOnUsersBehalf_ViaRescue() public {
        _queueOne(user1, 1000e18);
        vm.prank(queueRescuer);
        redemptionQueue.rescueQueueEntry(0, user1);
        assertEq(okuMoney.balanceOf(user1), 1000e18);
        assertEq(redemptionQueue.totalQueuedOkuM(), 0);
    }

    // ============ Stray OkuM ============

    function test_Spec_RescueExcess_SweepsOnlyDonation_NeverEscrow() public {
        _queueOne(user1, 1000e18);
        _mintOkuMoney(address(redemptionQueue), 7e18); // mistaken direct transfer

        vm.prank(queueRescuer);
        redemptionQueue.rescueExcessOkuM(treasury);
        assertEq(okuMoney.balanceOf(treasury), 7e18, "only the excess leaves");
        assertEq(okuMoney.balanceOf(address(redemptionQueue)), 1000e18, "escrow intact");
        assertEq(redemptionQueue.totalQueuedOkuM(), 1000e18);

        vm.prank(queueRescuer);
        vm.expectRevert(RedemptionQueue.NothingToRescue.selector);
        redemptionQueue.rescueExcessOkuM(treasury);
    }

    function test_Spec_RescueExcess_FrozenEscrowIsProtected() public {
        _queueThreeAndBlacklistMiddle();
        _depositBuffer(15_000e6);
        _process(0, 3, 15_000e6);
        assertEq(redemptionQueue.totalFrozenOkuM(), 5000e18);

        vm.prank(queueRescuer);
        vm.expectRevert(RedemptionQueue.NothingToRescue.selector);
        redemptionQueue.rescueExcessOkuM(treasury);
    }

    function test_Spec_RescueExcess_OnlyRescuer_NoZeroRecipient() public {
        _mintOkuMoney(address(redemptionQueue), 1e18);
        vm.prank(user1);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, user1, QUEUE_RESCUER
            )
        );
        redemptionQueue.rescueExcessOkuM(user1);

        vm.prank(queueRescuer);
        vm.expectRevert(Errors.ZeroAddress.selector);
        redemptionQueue.rescueExcessOkuM(address(0));
    }

    // ============ depositBuffer(.., processQueue) ============

    function test_Spec_DepositBuffer_Atomic_PaysQueueInSameTx() public {
        _queueOne(user1, 3000e18);
        _mintUsdc(bufferDepositor, 3000e6);
        _approveUsdc(bufferDepositor, address(litePsm), 3000e6);

        vm.startPrank(admin);
        litePsm.grantRole(PSM_QUEUE_PROCESSOR, bufferDepositor);
        vm.stopPrank();

        vm.prank(bufferDepositor);
        litePsm.depositBuffer(3000e6, true, 0, 1, 3000e6);

        assertEq(usdc.balanceOf(user1), 3000e6);
        assertEq(redemptionQueue.totalQueuedOkuM(), 0);
    }

    function test_Spec_DepositBuffer_Atomic_RequiresQueueProcessorRole() public {
        _mintUsdc(bufferDepositor, 100e6);
        _approveUsdc(bufferDepositor, address(litePsm), 100e6);
        vm.prank(bufferDepositor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                bufferDepositor,
                PSM_QUEUE_PROCESSOR
            )
        );
        litePsm.depositBuffer(100e6, true, 0, 0, 0);
    }

    function test_Spec_DepositBuffer_Atomic_BlockedWhenPaused_PlainStillWorks() public {
        vm.prank(admin);
        litePsm.grantRole(PSM_QUEUE_PROCESSOR, bufferDepositor);
        vm.prank(pauser);
        litePsm.pause();
        _mintUsdc(bufferDepositor, 200e6);
        _approveUsdc(bufferDepositor, address(litePsm), 200e6);

        vm.prank(bufferDepositor);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        litePsm.depositBuffer(100e6, true, 0, 0, 0);

        vm.prank(bufferDepositor);
        litePsm.depositBuffer(100e6, false, 0, 0, 0); // adding USDC is always allowed
    }

    function test_Spec_DepositBuffer_Atomic_BlockedInOverrideBlock() public {
        vm.prank(admin);
        litePsm.grantRole(PSM_QUEUE_PROCESSOR, bufferDepositor);
        _mintUsdc(bufferDepositor, 100e6);
        _approveUsdc(bufferDepositor, address(litePsm), 100e6);
        _stampYieldLockBlock();

        vm.prank(bufferDepositor);
        vm.expectRevert(OverrideBlockGuard.OverrideInProgress.selector);
        litePsm.depositBuffer(100e6, true, 0, 0, 0);
    }

    // ============ 18-decimal collateral (e.g. Binance-Peg USDC) ============

    function test_Spec_18DecCollateral_QueuePaysExactly_AndDustFloorApplies() public {
        MockUSDC18Dec usdc18 = new MockUSDC18Dec();
        (RedemptionQueue q18,) =
            Deploy.deployRedemptionQueue(address(okuMoney), address(usdc18), admin);
        (LitePSM psm18,) = Deploy.deployLitePSM(
            address(okuMoney), address(okuDollar), address(usdc18), address(q18), admin
        );
        vm.startPrank(admin);
        q18.grantRole(QUEUE_PSM, address(psm18));
        okuMoney.grantRole(OKUM_MINTER, address(psm18));
        okuMoney.grantRole(OKUM_BURNER, address(psm18));
        okuMoney.grantRole(OKUM_BURNER, address(q18));
        psm18.grantRole(PSM_QUEUE_PROCESSOR, queueProcessor);
        vm.stopPrank();
        vm.prank(allowanceManager);
        okuMoney.configureMinterAllowance(address(psm18), MAX_SUPPLY);

        // Dust floor: 18-dec has no decimal-multiplier floor, MIN_REDEMPTION_OKUM applies.
        _mintOkuMoney(user1, 1000e18);
        _approveOkuMoney(user1, address(psm18), 1000e18);
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LitePSM.BelowMinimumRedemption.selector, 1e11, 1e12));
        psm18.redeemOkuM(1e11);

        // Empty buffer -> queued; 1:1 at multiplier 1, paid exactly in 18-dec units.
        vm.prank(user1);
        assertEq(psm18.redeemOkuM(1000e18), 0);
        usdc18.mint(address(psm18), 1000e18);
        vm.prank(queueProcessor);
        psm18.processQueue(0, 1, 1000e18);
        assertEq(usdc18.balanceOf(user1), 1000e18);
    }
}

contract MockUSDC18Dec is ERC20("USD18", "USD18") {
    function decimals() public pure override returns (uint8) {
        return 18;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
