// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Roles} from "../../src/lib/Roles.sol";
import {OkuDollar} from "../../src/token/OkuDollar.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @title SyncWindowTest
 * @notice Cross-chain multiplier sync window on the EVM side.
 *
 * @dev SCOPE. The window addresses exactly one thing: a multiplier tick is not
 *      atomic across chains, so during propagation the peer chain prices a raw
 *      token differently, and anything converting value through the multiplier
 *      in that interval settles at a stale price on one side.
 *
 *      It does NOT address local step arbitrage (mint at M0, hold across a
 *      discrete step, redeem at M1). On this chain that surface does not exist —
 *      accrual is continuous, so there is no step to hold across. On SVM it does,
 *      and `tout` is what closes it there. Do not extend this window expecting it
 *      to deter a hold-across-the-step attacker: such an attacker never transacts
 *      while the window is open, so window length is irrelevant to them.
 *
 *      GATING RULE, asserted below: an operation is sync-gated iff it prices
 *      through the multiplier. `mint`, `redeem`, `redeemUiAmount` and
 *      `processQueue` are; `depositBuffer`, `withdrawUsdc`, `advanceHead`,
 *      `setYieldRate` and `haltAccrual` are not.
 */
contract SyncWindowTest is BaseTest {
    uint256 internal constant WINDOW = 120;

    function setUp() public override {
        super.setUp();
        _seedBuffer(1_000_000e6);
    }

    // ============ Helpers ============

    function _setWindow(uint256 duration) internal {
        vm.prank(capManager);
        token.setSyncWindowDuration(duration);
    }

    function _open(uint256 epoch) internal {
        vm.prank(rateSetter);
        token.beginSyncWindow(epoch);
    }

    function _close(uint256 epoch) internal {
        vm.prank(rateSetter);
        token.endSyncWindow(epoch);
    }

    /// @dev Clear the inter-window gap so a fresh window can be opened.
    function _clearGap() internal {
        vm.warp(block.timestamp + Constants.MIN_SYNC_WINDOW_GAP);
    }

    // ============ Ships inert ============

    function test_ShipsInert_DurationZeroAndNeverLocked() public view {
        assertEq(token.syncWindowDuration(), 0, "window must ship disabled");
        assertEq(token.syncLockedUntil(), 0);
        assertEq(token.syncEpoch(), 0);
        assertFalse(token.isSyncLocked());
    }

    /// @dev The property that lets this ship dormant: with duration 0, a rate
    ///      write must not arm anything — not even for the current second, and
    ///      critically must not move the gap anchor, or enabling the feature
    ///      later could be blocked for `MIN_SYNC_WINDOW_GAP` by a rate write
    ///      that predated it.
    function test_ShipsInert_SetYieldRateDoesNotArm() public {
        vm.prank(rateSetter);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 30 days);

        assertEq(token.syncLockedUntil(), 0, "inert config must not move gap anchor");
        assertFalse(token.isSyncLocked());

        // And the price-sensitive path still works in the same block.
        _psmMint(user1, 1000e6);
    }

    // ============ Blocking ============

    function test_Window_BlocksMintAndRedeem() public {
        uint256 raw = _psmMint(user1, 1000e6);
        _setWindow(WINDOW);
        _open(1);

        assertTrue(token.isSyncLocked());

        vm.expectRevert(
            abi.encodeWithSelector(LitePSM.SyncWindowActive.selector, token.syncLockedUntil())
        );
        vm.prank(user1);
        litePsm.mint(1e6);

        vm.startPrank(user1);
        token.approve(address(litePsm), raw);
        vm.expectRevert(
            abi.encodeWithSelector(LitePSM.SyncWindowActive.selector, token.syncLockedUntil())
        );
        litePsm.redeem(raw);
        vm.stopPrank();
    }

    function test_Window_BlocksRedeemUiAmount() public {
        uint256 raw = _psmMint(user1, 1000e6);
        _setWindow(WINDOW);
        _open(1);

        // Hoist BOTH reads: an external call in the argument list would be the
        // "next call" that `expectRevert` latches onto, so the assertion would
        // pass or fail for the wrong reason.
        uint256 uiBalance = token.balanceOfUI(user1);
        uint256 lockedUntil = token.syncLockedUntil();

        vm.startPrank(user1);
        token.approve(address(litePsm), raw);
        vm.expectRevert(abi.encodeWithSelector(LitePSM.SyncWindowActive.selector, lockedUntil));
        litePsm.redeemUiAmount(uiBalance);
        vm.stopPrank();
    }

    /// @dev The deliberate divergence from pause. `processQueue` is NOT
    ///      pause-gated, because pause is unbounded and stranding users in the
    ///      queue indefinitely would be worse than the risk. It IS sync-gated,
    ///      because the window is bounded and duty-cycled, and because the queue
    ///      prices at the live multiplier — leaving it open would be a real hole.
    function test_Window_BlocksProcessQueue() public {
        // Mint FIRST, then drain — minting deposits USDC into the very buffer
        // we are trying to empty, so the reverse order leaves the redemption
        // instantly satisfiable and nothing ever queues.
        uint256 raw = _psmMint(user1, 1000e6);

        // NB: read the balance BEFORE the prank — an external call in the
        // argument list would consume `vm.prank` itself.
        uint256 buffered = usdc.balanceOf(address(litePsm));
        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(treasury, buffered);

        vm.startPrank(user1);
        token.approve(address(litePsm), raw);
        litePsm.redeem(raw);
        vm.stopPrank();
        assertEq(queue.queueLength(), 1, "expected a queued entry");

        _seedBuffer(10_000e6);
        _setWindow(WINDOW);
        _open(1);

        vm.expectRevert(
            abi.encodeWithSelector(LitePSM.SyncWindowActive.selector, token.syncLockedUntil())
        );
        vm.prank(queueProcessor);
        litePsm.processQueue(0, 1, 10_000e6);

        // Clears normally once released.
        _close(1);
        vm.prank(queueProcessor);
        litePsm.processQueue(0, 1, 10_000e6);
        assertEq(queue.totalQueuedRaw(), 0);
    }

    // ============ Release paths ============

    function test_Window_EarlyCloseReleasesImmediately() public {
        _setWindow(WINDOW);
        _open(1);
        assertTrue(token.isSyncLocked());

        _close(1);
        assertFalse(token.isSyncLocked());
        _psmMint(user1, 1000e6);
    }

    /// @dev Liveness backstop: if the orchestrator dies mid-tick and never
    ///      calls `endSyncWindow`, mint/redeem must resume unaided. Without
    ///      this the mechanism would be a bricking vector strictly worse than
    ///      the arbitrage it prevents.
    function test_Window_AutoExpiresWithoutOperator() public {
        _setWindow(WINDOW);
        _open(1);
        assertTrue(token.isSyncLocked());

        vm.warp(block.timestamp + WINDOW);
        assertFalse(token.isSyncLocked(), "window must self-expire");
        _psmMint(user1, 1000e6);
    }

    function test_Window_ExclusiveUpperBound() public {
        _setWindow(WINDOW);
        uint256 openedAt = block.timestamp;
        _open(1);

        vm.warp(openedAt + WINDOW - 1);
        assertTrue(token.isSyncLocked(), "last second must still be locked");
        vm.warp(openedAt + WINDOW);
        assertFalse(token.isSyncLocked(), "boundary is exclusive");
    }

    // ============ Ungated surfaces ============

    /// @dev Everything that does not price through the multiplier must stay
    ///      open, or the window would obstruct the operator's own remediation
    ///      mid-tick.
    function test_Window_LeavesParValueAndAdminPathsOpen() public {
        _setWindow(WINDOW);
        _open(1);

        // Buffer movement is at par.
        _seedBuffer(1000e6);
        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(treasury, 100e6);

        // The multiplier itself must remain writable — the window must never
        // censor the rate setter.
        vm.prank(rateSetter);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 30 days);

        // And the guardian's emergency lever must remain available.
        vm.prank(guardian);
        token.haltAccrual();

        // Plain transfers are unaffected — the window gates PSM conversion,
        // not the raw ledger.
        _mintRaw(user1, 100e18);
        vm.prank(user1);
        token.transfer(user2, 1e18);
    }

    /// @dev `haltAccrual` must not arm a window. `OKU_GUARDIAN` is warm and
    ///      justified as withhold-only; arming would hand it a repeatable
    ///      mint/redeem block, a capability the RBAC docs deny it.
    function test_HaltAccrual_DoesNotArmWindow() public {
        _setWindow(WINDOW);
        vm.prank(guardian);
        token.haltAccrual();

        assertFalse(token.isSyncLocked(), "guardian must not be able to arm a window");
        assertEq(token.syncLockedUntil(), 0);
    }

    // ============ Epoch discipline ============

    function test_Epoch_BeginRequiresExactSuccessor() public {
        _setWindow(WINDOW);

        vm.expectRevert(abi.encodeWithSelector(OkuDollar.SyncEpochMismatch.selector, 0, 1));
        vm.prank(rateSetter);
        token.beginSyncWindow(0);

        vm.expectRevert(abi.encodeWithSelector(OkuDollar.SyncEpochMismatch.selector, 2, 1));
        vm.prank(rateSetter);
        token.beginSyncWindow(2);

        _open(1);
        assertEq(token.syncEpoch(), 1);
    }

    /// @dev A release for a different tick must not close the live window,
    ///      otherwise a stale or replayed call could unlock mid-propagation.
    function test_Epoch_EndRequiresMatch() public {
        _setWindow(WINDOW);
        _open(1);

        vm.expectRevert(abi.encodeWithSelector(OkuDollar.SyncEpochMismatch.selector, 0, 1));
        vm.prank(rateSetter);
        token.endSyncWindow(0);
        assertTrue(token.isSyncLocked(), "stale release must not unlock");

        _close(1);
        assertFalse(token.isSyncLocked());
    }

    // ============ Anti-griefing gap ============

    function test_Gap_RefusesSecondWindowInsideGap() public {
        _setWindow(WINDOW);
        _open(1);
        _close(1);

        uint256 earliest = token.syncLockedUntil() + Constants.MIN_SYNC_WINDOW_GAP;
        vm.expectRevert(
            abi.encodeWithSelector(OkuDollar.SyncWindowGapNotElapsed.selector, earliest)
        );
        vm.prank(rateSetter);
        token.beginSyncWindow(2);

        _clearGap();
        _open(2);
    }

    /// @dev THE anti-griefing property. A caller looping `setYieldRate` must not
    ///      be able to hold a permanent block — but the write must also never be
    ///      rejected, since that would make the rate setter censorable by anyone
    ///      able to open a window. So: clamp, never revert.
    function test_Gap_RateWriteInsideGapClampsRatherThanReverts() public {
        _setWindow(WINDOW);
        _open(1);
        _close(1);
        uint256 anchor = token.syncLockedUntil();

        for (uint256 i = 0; i < 3; ++i) {
            vm.warp(block.timestamp + 10);
            vm.prank(rateSetter);
            token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 30 days); // must SUCCEED
        }

        assertEq(token.syncLockedUntil(), anchor, "gap anchor moved: window was re-armed");
        assertFalse(token.isSyncLocked());
        _psmMint(user1, 1000e6);
    }

    /// @dev The other side of the clamp: outside the gap a bare rate write DOES
    ///      arm, so a tick can never land completely unfenced merely because the
    ///      operator skipped `beginSyncWindow`.
    function test_Gap_RateWriteOutsideGapArmsFailClosed() public {
        _setWindow(WINDOW);
        _clearGap();

        vm.prank(rateSetter);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 30 days);

        assertTrue(token.isSyncLocked(), "fail-closed arming did not fire");

        vm.warp(block.timestamp + WINDOW);
        assertFalse(token.isSyncLocked());
    }

    /// @dev The availability floor claimed in `Constants` is arithmetic, so
    ///      assert it rather than trusting the comment.
    function test_Gap_AvailabilityFloorHolds() public pure {
        uint256 cycle = Constants.MIN_SYNC_WINDOW_GAP + Constants.MAX_SYNC_WINDOW;
        assertGe((Constants.MIN_SYNC_WINDOW_GAP * 100) / cycle, 96);
    }

    // ============ Parameter bounds and RBAC ============

    function test_Duration_RejectsAboveMax() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                OkuDollar.SyncWindowTooLong.selector,
                Constants.MAX_SYNC_WINDOW + 1,
                Constants.MAX_SYNC_WINDOW
            )
        );
        vm.prank(capManager);
        token.setSyncWindowDuration(Constants.MAX_SYNC_WINDOW + 1);
    }

    function test_Duration_AcceptsExactlyMax() public {
        _setWindow(Constants.MAX_SYNC_WINDOW);
        assertEq(token.syncWindowDuration(), Constants.MAX_SYNC_WINDOW);
    }

    function test_Rbac_DurationIsCapManagerOnly() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                rateSetter,
                Roles.OKU_CAP_MANAGER
            )
        );
        vm.prank(rateSetter);
        token.setSyncWindowDuration(WINDOW);
    }

    function test_Rbac_WindowOpenCloseIsRateSetterOnly() public {
        _setWindow(WINDOW);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                capManager,
                Roles.OKU_RATE_SETTER
            )
        );
        vm.prank(capManager);
        token.beginSyncWindow(1);

        _open(1);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                guardian,
                Roles.OKU_RATE_SETTER
            )
        );
        vm.prank(guardian);
        token.endSyncWindow(1);
    }

    // ============ Pause independence ============

    /// @dev Two orthogonal gates. Neither implies the other, and the sync
    ///      window must not become a backdoor pause or vice versa.
    function test_Window_AndPauseAreIndependent() public {
        _setWindow(WINDOW);
        _open(1);
        assertTrue(token.isSyncLocked());
        assertFalse(litePsm.paused(), "opening a window must not pause the PSM");

        _close(1);
        vm.prank(psmPauser);
        litePsm.pause();
        assertTrue(litePsm.paused());
        assertFalse(token.isSyncLocked(), "pausing must not arm a window");
    }
}
