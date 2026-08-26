// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Roles} from "../../src/lib/Roles.sol";
import {OkuM} from "../../src/token/OkuM.sol";
import {SubscriptionModule} from "../../src/psm/SubscriptionModule.sol";
import {USDOkuWrapper} from "../../src/wrapper/USDOkuWrapper.sol";

/**
 * @title SyncWindowTest
 * @notice The post-step sync window: what it gates, what it does not, and that
 *         it can never outlive its bound.
 *
 * @dev THE MECHANISM IS AUTO-ARM ONLY. Every `setOkuMultiplier` write arms a
 *      lock of `syncWindowDuration()` seconds on the operations that price
 *      through the multiplier. The lock expires on its own. There is no
 *      `beginSyncWindow`, no `endSyncWindow`, no epoch, and no inter-window gap.
 *
 *      That is a deliberate reduction from an earlier orchestrator-driven epoch
 *      protocol, and the reasoning is worth stating because the machinery looked
 *      load-bearing:
 *
 *        - The epoch was supposed to make "a tick completed on every chain"
 *          externally verifiable. It never did: equal epochs proved both chains
 *          *wrote*, never that they wrote the SAME VALUE. Off-chain parity
 *          checking now compares the multiplier values directly, which is
 *          strictly stronger and needs no on-chain bookkeeping at all.
 *        - `beginSyncWindow` had to be callable before the write, which meant a
 *          window could be opened and never used — so it needed a
 *          write-landed-in-epoch check to close, which needed a
 *          `last_write_epoch` field, which needed an anti-grief gap to stop
 *          windows being chained... Each mechanism existed to contain the
 *          previous one. Arming on the write removes the whole chain: there is
 *          no unfenced tick to guard against, because the fence and the tick are
 *          the same transaction.
 *        - The gap (`MIN_SYNC_WINDOW_GAP`) bought a 96% availability floor
 *          against a compromised rate setter. Arming-on-write gives a tighter
 *          one for free: the setter cannot arm without also taking a step, steps
 *          are capped at `MAX_STEP_BPS` each and floored by fee coverage, so
 *          spamming windows means spamming real, bounded, self-limiting
 *          multiplier increases — a far louder and more constrained attack than
 *          holding a lock open.
 *
 *      What survives is the part that was actually doing work: a bounded,
 *      auto-expiring block on multiplier-priced operations across the interval
 *      in which a step has landed here but not yet on the peer chain.
 */
contract SyncWindowTest is BaseTest {
    function setUp() public override {
        super.setUp();
        _seedBuffer(1_000_000e6);
        // A covering fee schedule, so steps in this suite are about the window
        // rather than about step coverage (which `StepArbitrageTest` owns).
        vm.prank(capManager);
        module.setFees(50, 50);
    }

    // ============ Ships on ============

    /// @notice The window is ON at deployment. A zero default would leave the
    ///         protection installed but inert, and therefore dependent on
    ///         someone remembering to enable it — the class of dependency this
    ///         design exists to remove.
    function test_ShipsOnAtDefaultDuration() public view {
        assertEq(token.syncWindowDuration(), Constants.DEFAULT_SYNC_WINDOW);
        assertEq(Constants.DEFAULT_SYNC_WINDOW, 60);
        assertFalse(token.isSyncLocked(), "but nothing is locked before the first step");
        assertEq(token.syncLockedUntil(), 0);
    }

    // ============ Arming ============

    function test_Step_ArmsTheWindowForExactlyDuration() public {
        uint256 expected = block.timestamp + token.syncWindowDuration();

        vm.expectEmit(false, false, false, true, address(token));
        emit OkuM.SyncWindowArmed(expected);
        vm.prank(rateSetter);
        token.setOkuMultiplier(1.001e18);

        assertTrue(token.isSyncLocked());
        assertEq(token.syncLockedUntil(), expected);
    }

    /// @notice A second step inside an open window RE-ARMS from now — it does not
    ///         stack. Assignment rather than extension is what makes the
    ///         `MAX_SYNC_WINDOW` bound hold by construction rather than by
    ///         argument.
    function test_StepDuringOpenWindow_ReArmsWithoutStacking() public {
        vm.prank(rateSetter);
        token.setOkuMultiplier(1.001e18);
        uint256 first = token.syncLockedUntil();

        vm.warp(block.timestamp + 10);
        vm.prank(rateSetter);
        token.setOkuMultiplier(1.002e18);
        uint256 second = token.syncLockedUntil();

        assertEq(second, block.timestamp + token.syncWindowDuration());
        assertEq(second - first, 10, "re-armed from now, not appended");
        assertLe(second - block.timestamp, Constants.MAX_SYNC_WINDOW);
    }

    /// @notice `haltAccrual` does NOT arm. `OKU_GUARDIAN` is warm and justified
    ///         as withhold-only; arming would hand that warm key a repeatable
    ///         mint/redeem block the RBAC model explicitly denies it. Nothing
    ///         about the current multiplier changes on a halt, so there is
    ///         nothing to fence either.
    function test_HaltAccrual_DoesNotArm() public {
        vm.prank(guardian);
        token.haltAccrual();
        assertFalse(token.isSyncLocked());
        assertEq(token.syncLockedUntil(), 0);
    }

    /// @notice A rejected step arms nothing — the arm is downstream of every
    ///         guard, so a reverted write leaves no trace.
    function test_RejectedStep_ArmsNothing() public {
        // Drop coverage below the step so `StepNotCovered` is the binding
        // rejection rather than `StepAboveMaximum`. The two bounds coincide at
        // `MAX_FEE_BPS == MAX_STEP_BPS == 100`, so a fully-covered schedule
        // makes the coverage check unreachable by construction — which is worth
        // knowing: at maximum fees, step coverage never binds and only the step
        // ceiling does.
        vm.startPrank(capManager);
        token.resetStepHighWaterMark();
        module.setFees(1, 1);
        vm.stopPrank();

        vm.prank(rateSetter);
        vm.expectPartialRevert(OkuM.StepNotCovered.selector);
        token.setOkuMultiplier(1.005e18); // 50 bps against 2 bps of coverage
        assertFalse(token.isSyncLocked());
    }

    // ============ What is gated ============

    function test_Gated_ModuleMint() public {
        _psmMint(user1, 100e6);
        _stepNoWarp(1.001e18);

        usdc.mint(user1, 100e6);
        vm.startPrank(user1);
        usdc.approve(address(module), 100e6);
        vm.expectPartialRevert(SubscriptionModule.SyncWindowActive.selector);
        module.mint(100e6);
        vm.stopPrank();
    }

    function test_Gated_ModuleRedeem() public {
        uint256 raw = _psmMint(user1, 100e6);
        _stepNoWarp(1.001e18);

        vm.startPrank(user1);
        token.approve(address(module), raw);
        vm.expectPartialRevert(SubscriptionModule.SyncWindowActive.selector);
        module.redeem(raw);
        vm.stopPrank();
    }

    function test_Gated_ModuleRedeemUiAmount() public {
        _psmMint(user1, 100e6);
        _stepNoWarp(1.001e18);

        vm.startPrank(user1);
        token.approve(address(module), type(uint256).max);
        vm.expectPartialRevert(SubscriptionModule.SyncWindowActive.selector);
        module.redeemUiAmount(10e18);
        vm.stopPrank();
    }

    /// @notice Queue processing prices at the live multiplier, so it is gated —
    ///         but note it is deliberately NOT pause-gated. The distinction is
    ///         the point: pause is unbounded incident response and could strand
    ///         queued users indefinitely; this window is bounded by
    ///         `MAX_SYNC_WINDOW`.
    function test_Gated_ProcessQueue() public {
        _queueOneRedemption();
        _stepNoWarp(1.001e18);

        vm.prank(queueProcessor);
        vm.expectPartialRevert(SubscriptionModule.SyncWindowActive.selector);
        module.processQueue(0, 1, 1000e6);
    }

    function test_Gated_WrapperWrap() public {
        uint256 raw = _psmMint(user1, 100e6);
        _stepNoWarp(1.001e18);

        vm.startPrank(user1);
        token.approve(address(wrapper), raw);
        vm.expectPartialRevert(USDOkuWrapper.SyncWindowActive.selector);
        wrapper.wrap(raw);
        vm.stopPrank();
    }

    function test_Gated_WrapperUnwrap() public {
        uint256 raw = _psmMint(user1, 100e6);
        uint256 usdOkuOut = _wrap(user1, raw);
        _stepNoWarp(token.uiMultiplier() + 1e15);

        vm.startPrank(user1);
        usdOku.approve(address(wrapper), usdOkuOut);
        vm.expectPartialRevert(USDOkuWrapper.SyncWindowActive.selector);
        wrapper.unwrap(usdOkuOut);
        vm.stopPrank();
    }

    // ============ What is NOT gated ============

    /// @notice `setUsdOkuRate` is deliberately NOT gated, and this is the
    ///         subtlest call in the design.
    ///
    /// @dev Its solvency precondition reads `M_oku`-derived backing, so an
    ///      earlier draft gated it on the grounds that mid-propagation the
    ///      backing figure is stale on one chain. But the staleness only ever
    ///      runs one way: `M_oku` is monotone, so a step still in flight can
    ///      only make backing LARGER than the figure checked. The check is
    ///      therefore conservative mid-tick — it can refuse a rate it would
    ///      later allow, never allow one it should refuse. Gating it would buy
    ///      nothing and would make the rate setter blockable during exactly the
    ///      incident in which it most needs to be able to write.
    function test_NotGated_SetUsdOkuRate() public {
        _stepNoWarp(1.001e18);
        assertTrue(token.isSyncLocked());

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + 20 days);
        assertGt(usdOku.ratePerSecond(), Constants.PRECISION);
    }

    /// @notice Buffer movement is at par — no multiplier in the arithmetic, so
    ///         nothing a stale multiplier could misprice.
    function test_NotGated_BufferMovement() public {
        _stepNoWarp(1.001e18);

        usdc.mint(bufferDepositor, 500e6);
        vm.startPrank(bufferDepositor);
        usdc.approve(address(module), 500e6);
        module.depositBuffer(500e6);
        vm.stopPrank();

        vm.prank(bufferWithdrawer);
        module.withdrawUsdc(treasury, 100e6);
        assertEq(usdc.balanceOf(treasury), 100e6);
    }

    /// @notice Raw transfers move no value through the multiplier — the display
    ///         layer is derived, not settled. Gating them would freeze the token
    ///         for a display concern.
    function test_NotGated_RawTransfers() public {
        uint256 raw = _psmMint(user1, 100e6);
        _stepNoWarp(1.001e18);

        vm.prank(user1);
        token.transfer(user2, raw / 2);
        assertEq(token.balanceOf(user2), raw / 2);
    }

    /// @notice Emergency levers stay callable. A window must never be able to
    ///         block incident response.
    function test_NotGated_EmergencyLevers() public {
        _stepNoWarp(1.001e18);

        vm.prank(guardian);
        token.haltAccrual();
        vm.prank(blacklister);
        token.blacklist(user5);
        vm.prank(psmPauser);
        module.pause();

        assertTrue(token.accrualHalted());
        assertTrue(token.isBlacklisted(user5));
        assertTrue(module.paused());
    }

    // ============ Expiry ============

    /// @notice The upper bound is EXCLUSIVE, so at `lockedUntil` exactly the
    ///         system is already open. This is what lets a zero-length window be
    ///         genuinely inert rather than blocking the rest of the second.
    function test_Expiry_UpperBoundIsExclusive() public {
        _stepNoWarp(1.001e18);
        uint256 lockedUntil = token.syncLockedUntil();

        vm.warp(lockedUntil - 1);
        assertTrue(token.isSyncLocked(), "still locked one second before");

        vm.warp(lockedUntil);
        assertFalse(token.isSyncLocked(), "open exactly at lockedUntil");
        _psmMint(user1, 100e6);
    }

    /// @notice THE LIVENESS BACKSTOP. There is no close call, so nothing has to
    ///         run for the window to lift — a dead orchestrator cannot brick
    ///         redemption. Under the old begin/end design this was a property of
    ///         the auto-expiry path; here it is the only path.
    function test_Expiry_NeedsNoTransaction() public {
        _stepNoWarp(1.001e18);
        assertTrue(token.isSyncLocked());

        vm.warp(block.timestamp + Constants.MAX_SYNC_WINDOW);
        assertFalse(token.isSyncLocked(), "lifted with no transaction of any kind");
        _psmMint(user1, 100e6);
    }

    // ============ Duration configuration ============

    function test_Duration_ZeroDisablesEntirely() public {
        vm.prank(capManager);
        token.setSyncWindowDuration(0);

        vm.prank(rateSetter);
        token.setOkuMultiplier(1.001e18);

        assertFalse(token.isSyncLocked());
        assertEq(token.syncLockedUntil(), 0, "an inert window never writes the anchor");
        _psmMint(user1, 100e6);
    }

    function test_Duration_BoundedByMaxSyncWindow() public {
        vm.prank(capManager);
        vm.expectPartialRevert(OkuM.SyncWindowTooLong.selector);
        token.setSyncWindowDuration(Constants.MAX_SYNC_WINDOW + 1);

        vm.prank(capManager);
        token.setSyncWindowDuration(Constants.MAX_SYNC_WINDOW);
        assertEq(token.syncWindowDuration(), Constants.MAX_SYNC_WINDOW);
    }

    /// @notice The bound is a CONSTANT, not a config field: no key, warm or
    ///         cold, can widen it. Combined with assign-not-extend arming, a
    ///         window's remaining life is bounded from every reachable state.
    function test_Duration_WindowNeverExceedsBoundEvenAtMaxDuration() public {
        vm.prank(capManager);
        token.setSyncWindowDuration(Constants.MAX_SYNC_WINDOW);

        vm.prank(rateSetter);
        token.setOkuMultiplier(1.001e18);
        assertLe(token.syncLockedUntil() - block.timestamp, Constants.MAX_SYNC_WINDOW);

        vm.warp(block.timestamp + 1);
        vm.prank(rateSetter);
        token.setOkuMultiplier(1.002e18);
        assertLe(token.syncLockedUntil() - block.timestamp, Constants.MAX_SYNC_WINDOW);
    }

    function test_Duration_RequiresCapManager() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.setSyncWindowDuration(30);
    }

    // ============ Independence from pause ============

    /// @notice Pause and the window are orthogonal: different causes, different
    ///         durations, different keys. A paused module with an expired window
    ///         is still paused; an unpaused module inside a window is still
    ///         gated.
    function test_IndependentOfPause() public {
        _stepNoWarp(1.001e18);
        vm.prank(psmPauser);
        module.pause();

        vm.warp(token.syncLockedUntil());
        assertFalse(token.isSyncLocked());

        usdc.mint(user1, 100e6);
        vm.startPrank(user1);
        usdc.approve(address(module), 100e6);
        vm.expectRevert(); // still paused, window irrelevant
        module.mint(100e6);
        vm.stopPrank();
    }

    // ============ Helpers ============

    /// @dev Drain the buffer, then redeem so the redemption is escrowed.
    function _queueOneRedemption() internal {
        uint256 raw = _psmMint(user1, 1000e6);
        // Read the balance BEFORE the prank: an external call in an argument
        // position consumes `vm.prank`, and the drain would then be attempted by
        // the test contract and fail on the role check.
        uint256 buffer = usdc.balanceOf(address(module));
        vm.prank(bufferWithdrawer);
        module.withdrawUsdc(treasury, buffer);

        vm.startPrank(user1);
        token.approve(address(module), raw);
        module.redeem(raw);
        vm.stopPrank();
        assertEq(queue.queueTail(), 1);
    }
}
