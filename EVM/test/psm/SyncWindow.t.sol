// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Roles} from "../../src/lib/Roles.sol";
import {OkuM} from "../../src/token/OkuM.sol";
import {ScaledUIAmountUpgradeable} from "../../src/lib/ScaledUIAmountUpgradeable.sol";
import {SubscriptionModule} from "../../src/psm/SubscriptionModule.sol";
import {USDOkuWrapper} from "../../src/wrapper/USDOkuWrapper.sol";

/**
 * @title SyncWindowTest
 * @notice The post-step sync window: what it gates, what it does not, and that
 *         it can never outlive its bound.
 *
 * @dev THE MECHANISM IS AUTO-ARM ONLY. Every `setOkuMultiplier` write arms a
 *      lock of `syncWindowDuration()` seconds on THE BRIDGE LEGS — `OkuM.mint`
 *      and `OkuM.burn`. The lock expires on its own. There is no
 *      `beginSyncWindow`, no `endSyncWindow`, no epoch, and no inter-window gap.
 *
 *      SCOPE IS BRIDGE LEGS ONLY, and the narrowing is the substance of this
 *      suite. An earlier version gated eleven call sites: module `mint`,
 *      `redeem`, `redeemUiAmount`, `mintUsdOku`, `redeemUsdOku`, `processQueue`,
 *      and five wrapper entry points. All of those are SINGLE-CHAIN operations
 *      priced at this chain's own `M_oku`, which is correct by definition
 *      whatever a peer chain currently believes — so the gate bought nothing and
 *      cost a post-mark outage on every user-facing operation.
 *
 *      The bridge is the one place value crosses a multiplier boundary. Raw is
 *      conserved per-instruction, but the cross-chain PAIR prices: burning 100
 *      raw where M=1.04 destroys $104 of claim while minting 100 raw where
 *      M=1.05 creates $105, conjuring $1 out of a mid-tick divergence.
 *
 *      WHY A TIME LOCK IS RIGHT HERE AND WRONG FOR STEP ARBITRAGE. The two edges
 *      differ in kind. Cross-chain divergence is transient and self-correcting —
 *      once the lagging chain ticks the edge is exactly zero, so making the
 *      attacker wait removes it. A step's gain is permanent and the multiplier is
 *      monotone, so waiting costs a step-arbitrageur nothing and no window length
 *      deters them; that is the fee floor's job (`StepArbitrageTest`).
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
        // No fee arrangement needed: `initialize` seeds both legs at the step
        // floor, so every step in this suite is covered already. Step coverage
        // is `StepArbitrageTest`'s subject, not this one's.
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
        uint256 target_ = _smallStepTarget();

        vm.expectEmit(false, false, false, true, address(token));
        emit OkuM.SyncWindowArmed(expected);
        vm.prank(rateSetter);
        token.setOkuMultiplier(target_);

        assertTrue(token.isSyncLocked());
        assertEq(token.syncLockedUntil(), expected);
    }

    /// @notice A second step inside an open window RE-ARMS from now — it does not
    ///         stack. Assignment rather than extension is what makes the
    ///         `MAX_SYNC_WINDOW` bound hold by construction rather than by
    ///         argument.
    function test_StepDuringOpenWindow_ReArmsWithoutStacking() public {
        uint256 target_ = _smallStepTarget();
        vm.prank(rateSetter);
        token.setOkuMultiplier(target_);
        uint256 first = token.syncLockedUntil();

        vm.warp(block.timestamp + 10);
        target_ = _smallStepTarget();
        vm.prank(rateSetter);
        token.setOkuMultiplier(target_);
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
    /// @dev `StepAboveMaximum` is now the only size-related rejection.
    ///      `StepNotCovered` is gone: the token no longer reads the fee schedule,
    ///      because the static per-leg floor makes coverage unconditional.
    function test_RejectedStep_ArmsNothing() public {
        uint256 oversized = Constants.PRECISION
            * (Constants.BASIS_POINTS + Constants.MAX_STEP_BPS + 1) / Constants.BASIS_POINTS;

        vm.prank(rateSetter);
        vm.expectPartialRevert(ScaledUIAmountUpgradeable.StepAboveMaximum.selector);
        token.setOkuMultiplier(oversized);
        assertFalse(token.isSyncLocked());
    }

    // ============ What it gates on this chain: nothing ============

    /// @notice THE EVM WINDOW GATES NOTHING ON-CHAIN, and that is deliberate.
    ///
    /// @dev The window fences value crossing a multiplier boundary between
    ///      chains. On SVM that pair has dedicated instructions
    ///      (`mint_oku_m_direct` / `burn_oku_m_direct`) and they are gated. EVM
    ///      has no equivalent: `OkuM.mint` and `OkuM.burn` are the shared supply
    ///      hooks the module and queue use for ordinary local subscription and
    ///      redemption, so gating them gates the entire PSM.
    ///
    ///      An earlier draft of this refactor did gate them, on the theory that
    ///      they were "the bridge legs". They are not — this test is the
    ///      regression guard for that mistake, and asserts the supply hooks stay
    ///      callable inside an open window.
    function test_SupplyHooks_NotGated() public {
        _stepNoWarp(_smallStepTarget());
        assertTrue(token.isSyncLocked(), "window is open");

        vm.prank(minter);
        token.mint(user1, 100e18);
        assertEq(token.balanceOf(user1), 100e18);

        vm.prank(minter);
        token.mint(burner, 50e18);
        vm.prank(burner);
        token.burn(10e18);
        assertEq(token.balanceOf(burner), 40e18);
    }

    /// @notice The window is still fully observable — it is an advisory signal
    ///         for monitoring and for the future bridge adapter.
    function test_AdvisorySignal_IsObservable() public {
        _stepNoWarp(_smallStepTarget());
        assertTrue(token.isSyncLocked());
        assertEq(token.syncLockedUntil(), block.timestamp + token.syncWindowDuration());
        assertLe(token.syncLockedUntil() - block.timestamp, Constants.MAX_SYNC_WINDOW);
    }

    // ============ What is NOT gated: everything single-chain ============
    //
    // These are the eleven call sites the narrowing freed. Each is priced at
    // this chain's own `M_oku` and is therefore correct mid-divergence; the
    // assertions below are the regression guard against the gate creeping back.

    /// @notice Module mint prices locally and is not gated.
    function test_NotGated_ModuleMint() public {
        _stepNoWarp(_smallStepTarget());
        assertTrue(token.isSyncLocked());
        _psmMint(user1, 100e6);
    }

    /// @notice Module redeem prices locally and is not gated. THE most important
    ///         entry here: a holder must be able to exit during a mark.
    function test_NotGated_ModuleRedeem() public {
        uint256 raw = _psmMint(user1, 100e6);
        _stepNoWarp(_smallStepTarget());
        assertTrue(token.isSyncLocked());

        vm.startPrank(user1);
        token.approve(address(module), raw);
        uint256 out = module.redeem(raw);
        vm.stopPrank();
        assertGt(out, 0);
    }

    function test_NotGated_ModuleRedeemUiAmount() public {
        _psmMint(user1, 1000e6);
        _stepNoWarp(_smallStepTarget());

        vm.startPrank(user1);
        token.approve(address(module), type(uint256).max);
        module.redeemUiAmount(10e18);
        vm.stopPrank();
    }

    /// @notice Queue processing prices at the live local multiplier, so queued
    ///         users are never stranded by a mark landing.
    function test_NotGated_ProcessQueue() public {
        _queueOneRedemption();
        _stepNoWarp(_smallStepTarget());
        assertTrue(token.isSyncLocked());

        _seedBuffer(10_000e6);
        vm.prank(queueProcessor);
        module.processQueue(0, 1, 1000e6);
    }

    function test_NotGated_WrapperWrap() public {
        uint256 raw = _psmMint(user1, 100e6);
        _stepNoWarp(_smallStepTarget());

        vm.startPrank(user1);
        token.approve(address(wrapper), raw);
        uint256 out = wrapper.wrap(raw);
        vm.stopPrank();
        assertGt(out, 0);
    }

    function test_NotGated_WrapperUnwrap() public {
        uint256 raw = _psmMint(user1, 100e6);
        uint256 usdOkuOut = _wrap(user1, raw);
        _stepNoWarp(_smallStepTarget());

        vm.startPrank(user1);
        usdOku.approve(address(wrapper), usdOkuOut);
        wrapper.unwrap(usdOkuOut);
        vm.stopPrank();
    }

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
        _stepNoWarp(_smallStepTarget());
        assertTrue(token.isSyncLocked());

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + 20 days);
        assertGt(usdOku.ratePerSecond(), Constants.PRECISION);
    }

    /// @notice Buffer movement is at par — no multiplier in the arithmetic, so
    ///         nothing a stale multiplier could misprice.
    function test_NotGated_BufferMovement() public {
        _stepNoWarp(_smallStepTarget());

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
        _stepNoWarp(_smallStepTarget());

        vm.prank(user1);
        token.transfer(user2, raw / 2);
        assertEq(token.balanceOf(user2), raw / 2);
    }

    /// @notice Emergency levers stay callable. A window must never be able to
    ///         block incident response.
    function test_NotGated_EmergencyLevers() public {
        _stepNoWarp(_smallStepTarget());

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
        _stepNoWarp(_smallStepTarget());
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
        _stepNoWarp(_smallStepTarget());
        assertTrue(token.isSyncLocked());

        vm.warp(block.timestamp + Constants.MAX_SYNC_WINDOW);
        assertFalse(token.isSyncLocked(), "lifted with no transaction of any kind");
        _psmMint(user1, 100e6);
    }

    // ============ Duration configuration ============

    function test_Duration_ZeroDisablesEntirely() public {
        vm.prank(capManager);
        token.setSyncWindowDuration(0);

        uint256 target_ = _smallStepTarget();
        vm.prank(rateSetter);
        token.setOkuMultiplier(target_);

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

        uint256 target_ = _smallStepTarget();
        vm.prank(rateSetter);
        token.setOkuMultiplier(target_);
        assertLe(token.syncLockedUntil() - block.timestamp, Constants.MAX_SYNC_WINDOW);

        vm.warp(block.timestamp + 1);
        target_ = _smallStepTarget();
        vm.prank(rateSetter);
        token.setOkuMultiplier(target_);
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
        _stepNoWarp(_smallStepTarget());
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

    /// @dev A target one bps above the current multiplier — always inside
    ///      `MAX_STEP_BPS`, so these tests never trip the step ceiling while
    ///      trying to arm a window.
    function _smallStepTarget() internal view returns (uint256) {
        uint256 current = token.uiMultiplier();
        return current + (current / Constants.BASIS_POINTS);
    }

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
