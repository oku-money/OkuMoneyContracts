// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {OkuMoneyEvents} from "../../src/lib/events/OkuMoneyEvents.sol";
import {Deploy} from "../shared/Deploy.sol";
import {OkuMoneyErrors} from "../../src/lib/errors/OkuMoneyErrors.sol";

/// @notice Cyfrin audit #13. Re-arming the segment already accruing used to re-anchor the
///         stored base at each chain's own landing second; integer rounding then left
///         chains that received identical broadcasts wei apart for good (81 wei after 30
///         epochs at 12 s skew in Cyfrin's PoC), and let a paused same-rate re-arm raise
///         the projected curve (7 wei). `_rearmAnchor` now keeps the stored anchor when a
///         write repeats the live active segment, and promotes the live successor at
///         `okuMRateEnd` when it repeats that, so the stored schedule is a function of the
///         broadcast alone.
contract OkuMoneyRearmSkewTest is BaseTest {
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant DAY = 1 days;
    uint256 internal constant BASE_WINDOW = 80_640;
    uint256 internal constant SKEW = 12;
    // about 5% APY and about 8% APY as per-second rates
    uint256 internal constant RATE_BASE = 1_000_000_001_547_126_016;
    uint256 internal constant RATE_SETTLE = 1_000_000_002_440_418_608;

    struct Stored {
        uint256 base;
        uint256 anchor;
        uint256 rate;
        uint256 rateEnd;
        uint256 pending;
        uint256 pendingEnd;
    }

    function _stored(OkuMoney c) internal view returns (Stored memory s) {
        s = Stored(
            c.okuMBaseMultiplier(),
            c.okuMLastAccrualTime(),
            c.okuMRatePerSecond(),
            c.okuMRateEnd(),
            c.okuMPendingRatePerSecond(),
            c.okuMPendingRateEnd()
        );
    }

    function _assertSameStored(OkuMoney a, OkuMoney b) internal view {
        Stored memory x = _stored(a);
        Stored memory y = _stored(b);
        assertEq(x.base, y.base, "base");
        assertEq(x.anchor, y.anchor, "anchor");
        assertEq(x.rate, y.rate, "rate");
        assertEq(x.rateEnd, y.rateEnd, "rateEnd");
        assertEq(x.pending, y.pending, "pending");
        assertEq(x.pendingEnd, y.pendingEnd, "pendingEnd");
    }

    function _apply(
        OkuMoney chain,
        uint256 rate,
        uint256 end,
        uint256 nextRate,
        uint256 nextEnd
    )
        internal
    {
        vm.prank(rateManager);
        chain.setOkuMYieldRateWithSuccessor(rate, end, nextRate, nextEnd);
    }

    function _second() internal returns (OkuMoney chainB) {
        (chainB,) = Deploy.deployOkuMoney(admin);
        vm.prank(admin);
        chainB.grantRole(OKUM_RATE_MANAGER, rateManager);
    }

    /// @dev The epoch pipeline's two re-arms per epoch, the second chain landing `skew`
    ///      seconds after the first (Cyfrin's PoC schedule).
    function _runPipeline(
        uint256 epochs,
        uint256 skew
    )
        internal
        returns (OkuMoney chainA, OkuMoney chainB)
    {
        chainA = okuMoney;
        chainB = _second();

        vm.warp(T0);
        _apply(chainA, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        _apply(chainB, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);

        for (uint256 k = 0; k < epochs; k++) {
            uint256 s = T0 + k * DAY;

            vm.warp(s + BASE_WINDOW - 1 hours);
            _apply(chainA, RATE_BASE, s + BASE_WINDOW, RATE_SETTLE, s + DAY);
            vm.warp(s + BASE_WINDOW - 1 hours + skew);
            _apply(chainB, RATE_BASE, s + BASE_WINDOW, RATE_SETTLE, s + DAY);

            vm.warp(s + BASE_WINDOW + 1000);
            _apply(chainA, RATE_SETTLE, s + DAY, RATE_BASE, s + DAY + BASE_WINDOW);
            vm.warp(s + BASE_WINDOW + 1000 + skew);
            _apply(chainB, RATE_SETTLE, s + DAY, RATE_BASE, s + DAY + BASE_WINDOW);
        }

        vm.warp(T0 + epochs * DAY);
    }

    /// @dev Cyfrin's PoC, inverted: 12 s of landing skew over 30 epochs used to leave the
    ///      later chain 81 wei higher (1_004_173_195_218_205_737 vs ..._656). Now the stored
    ///      schedules, and so the multipliers, are identical.
    function test_RearmSkew_PocNowLeavesChainsIdentical() public {
        (OkuMoney a, OkuMoney b) = _runPipeline(30, SKEW);
        _assertSameStored(a, b);
        assertEq(a.okuMMultiplier(), b.okuMMultiplier());
        // the anchor is the epoch grid, not either chain's landing second
        assertEq(a.okuMLastAccrualTime(), T0 + 29 * DAY + BASE_WINDOW);
    }

    /// @dev Any skew, any epoch count: identical stored schedules.
    function testFuzz_RearmSkew_StoredScheduleIndependentOfLandingSecond(
        uint256 skew,
        uint256 epochs
    )
        public
    {
        skew = bound(skew, 0, 900);
        epochs = bound(epochs, 1, 12);
        (OkuMoney a, OkuMoney b) = _runPipeline(epochs, skew);
        _assertSameStored(a, b);
        assertEq(a.okuMMultiplier(), b.okuMMultiplier());
    }

    // ---- the three cases of `_rearmAnchor` ----

    /// @dev Keep: the active window is live and the write repeats it. Base and anchor stay,
    ///      the curve is the same integers, and the event still reports m(now).
    function test_Keep_ActiveSegmentRepeated() public {
        vm.warp(T0);
        _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        Stored memory before = _stored(okuMoney);

        vm.warp(T0 + 12_345);
        uint256 mNow = okuMoney.okuMMultiplier();
        vm.expectEmit(false, false, false, true, address(okuMoney));
        emit OkuMoneyEvents.OkuMYieldRateUpdated(RATE_BASE, RATE_BASE, T0 + BASE_WINDOW, mNow);
        _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);

        Stored memory after_ = _stored(okuMoney);
        assertEq(after_.base, before.base);
        assertEq(after_.anchor, T0);
        assertEq(okuMoney.okuMMultiplier(), mNow);
    }

    /// @dev Promote: the active window has lapsed and the write repeats the live successor.
    ///      It becomes the active segment from `okuMRateEnd`, with the multiplier there as
    ///      its base, and every future value is unchanged.
    function test_Promote_LiveSuccessorRepeated() public {
        vm.warp(T0);
        _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        vm.warp(T0 + BASE_WINDOW);
        uint256 atRateEnd = okuMoney.okuMMultiplier();

        uint256[4] memory probes =
            [T0 + BASE_WINDOW + 1000, T0 + BASE_WINDOW + 3000, T0 + DAY - 1, T0 + DAY];
        uint256[4] memory expected;
        for (uint256 i = 0; i < probes.length; i++) {
            vm.warp(probes[i]);
            expected[i] = okuMoney.okuMMultiplier();
        }

        vm.warp(T0 + BASE_WINDOW + 1000);
        _apply(okuMoney, RATE_SETTLE, T0 + DAY, RATE_BASE, T0 + DAY + BASE_WINDOW);
        assertEq(okuMoney.okuMLastAccrualTime(), T0 + BASE_WINDOW);
        assertEq(okuMoney.okuMBaseMultiplier(), atRateEnd);

        for (uint256 i = 0; i < probes.length; i++) {
            vm.warp(probes[i]);
            assertEq(okuMoney.okuMMultiplier(), expected[i], "promote moved the curve");
        }
    }

    /// @dev Any other write re-anchors at now, as before: a one-wei rate change, a one-second
    ///      end change, a halt, and the successor re-armed while the active window is live.
    function test_Fresh_AnythingElseReanchorsAtNow() public {
        uint256 t = T0 + 5000;
        uint256[2][5] memory writes = [
            [RATE_BASE + 1, T0 + BASE_WINDOW],
            [RATE_BASE - 1, T0 + BASE_WINDOW],
            [RATE_BASE, T0 + BASE_WINDOW + 1],
            [RATE_BASE, T0 + BASE_WINDOW - 1],
            [RATE_SETTLE, T0 + DAY]
        ];
        for (uint256 i = 0; i < writes.length; i++) {
            uint256 snap = vm.snapshotState();
            vm.warp(T0);
            _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
            vm.warp(t);
            uint256 mNow = okuMoney.okuMMultiplier();
            vm.prank(rateManager);
            okuMoney.setOkuMYieldRate(writes[i][0], writes[i][1]);
            assertEq(okuMoney.okuMLastAccrualTime(), t, "re-anchors at now");
            assertEq(okuMoney.okuMBaseMultiplier(), mNow);
            vm.revertToState(snap);
        }

        // a halt
        vm.warp(T0);
        _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        vm.warp(t);
        uint256 m = okuMoney.okuMMultiplier();
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(PRECISION, 0);
        assertEq(okuMoney.okuMLastAccrualTime(), t);
        assertEq(okuMoney.okuMBaseMultiplier(), m);
    }

    /// @dev A promote needs the successor to be the segment accruing: once it has lapsed
    ///      too, repeating it is a write in the past and reverts as before.
    function test_Promote_NotAfterSuccessorLapsed() public {
        vm.warp(T0);
        _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        vm.warp(T0 + DAY + 1);
        vm.prank(rateManager);
        vm.expectRevert();
        okuMoney.setOkuMYieldRate(RATE_SETTLE, T0 + DAY);
    }

    /// @dev Re-sending an identical broadcast (a retry after a lost receipt) now leaves the
    ///      stored schedule exactly as it was.
    function test_IdenticalResendIsANoOp() public {
        vm.warp(T0);
        _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        vm.warp(T0 + 777);
        _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        Stored memory once = _stored(okuMoney);
        vm.warp(T0 + 9999);
        _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        Stored memory twice = _stored(okuMoney);
        assertEq(twice.base, once.base);
        assertEq(twice.anchor, once.anchor);
        assertEq(twice.anchor, T0);
    }

    /// @dev Cyfrin's pause-gate case: a paused re-arm of the same rate and end, which the
    ///      gate admits, used to raise the value at the window's end by 7 wei. It now raises
    ///      nothing.
    function test_PausedSameRateRearm_RaisesNothing() public {
        uint256 window = 604_800;
        vm.warp(T0);
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(RATE_BASE, T0 + window);

        vm.warp(T0 + 80_515);
        vm.prank(pauser);
        okuMoney.pause();

        uint256 snap = vm.snapshotState();
        vm.warp(T0 + window);
        uint256 untouched = okuMoney.okuMMultiplier();

        vm.revertToState(snap);
        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(RATE_BASE, T0 + window); // same rate, same end: admitted
        vm.warp(T0 + window);
        assertEq(okuMoney.okuMMultiplier(), untouched);
    }

    /// @dev The same while paused for the promote case.
    function test_PausedPromote_RaisesNothing() public {
        vm.warp(T0);
        _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        vm.warp(T0 + BASE_WINDOW + 1000);
        vm.prank(pauser);
        okuMoney.pause();

        uint256 snap = vm.snapshotState();
        vm.warp(T0 + DAY);
        uint256 untouched = okuMoney.okuMMultiplier();
        vm.revertToState(snap);

        vm.prank(rateManager);
        okuMoney.setOkuMYieldRate(RATE_SETTLE, T0 + DAY);
        vm.warp(T0 + DAY);
        assertEq(okuMoney.okuMMultiplier(), untouched);
    }

    // ---- a chain that lands outside the segment the broadcast re-arms (Cyfrin #13 follow-up) ----
    //
    // The fix makes every chain store the same schedule PROVIDED each processes the broadcast
    // inside the same effective segment. These tests pin what happens when one does not.

    /// @dev Late: the stage-settlement artifact repeats the base segment (RATE_BASE, base end).
    ///      A chain that lands after that window ended is asked to re-arm a segment in the
    ///      past. It reverts and stores nothing, so a straggler cannot diverge silently.
    function test_Straddle_LateStageRepeatRevertsAndStoresNothing() public {
        vm.warp(T0);
        _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        Stored memory before = _stored(okuMoney);

        uint256[3] memory landings = [T0 + BASE_WINDOW, T0 + BASE_WINDOW + 1, T0 + DAY - 1];
        for (uint256 i = 0; i < landings.length; i++) {
            vm.warp(landings[i]);
            vm.prank(rateManager);
            vm.expectRevert(OkuMoneyErrors.EndTimestampInPast.selector);
            okuMoney.setOkuMYieldRateWithSuccessor(
                RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY
            );
            Stored memory after_ = _stored(okuMoney);
            assertEq(after_.base, before.base, "base");
            assertEq(after_.anchor, before.anchor, "anchor");
            assertEq(after_.rateEnd, before.rateEnd, "rateEnd");
        }
    }

    /// @dev Late: the roll repeats the settlement segment. Landing after the settlement ended
    ///      reverts the same way, including at the exact end second (end <= now).
    function test_Straddle_LateRollRepeatRevertsAndStoresNothing() public {
        vm.warp(T0);
        _apply(okuMoney, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        Stored memory before = _stored(okuMoney);

        uint256[2] memory landings = [T0 + DAY, T0 + DAY + 5];
        for (uint256 i = 0; i < landings.length; i++) {
            vm.warp(landings[i]);
            vm.prank(rateManager);
            vm.expectRevert(OkuMoneyErrors.EndTimestampInPast.selector);
            okuMoney.setOkuMYieldRateWithSuccessor(
                RATE_SETTLE, T0 + DAY, RATE_BASE, T0 + DAY + BASE_WINDOW
            );
            Stored memory after_ = _stored(okuMoney);
            assertEq(after_.base, before.base, "base");
            assertEq(after_.anchor, before.anchor, "anchor");
        }
    }

    /// @dev Early, a chain whose clock LAGS (an L2 after a sequencer outage, Accepted Risk
    ///      #15): the roll artifact (RATE_SETTLE, settlement end) is derived once the base
    ///      window has ended, but this chain's `block.timestamp` is still inside it. The
    ///      write is not a re-arm of the running segment (that is the base rate), so it is
    ///      a plain rate change and re-anchors at the lagging clock, replacing the rest of
    ///      the base window with the settlement rate. The contract admits it and the chains
    ///      DIVERGE from then on. The contract cannot tell, so this is pinned as the reason for
    ///      the off-chain guard: `applyScheduleToChain` (EVM) and `set-yield-rate.ts` (SVM)
    ///      refuse the write by the chain's own clock (`rearmWindowProblem`, yield-tooling).
    function test_Straddle_EarlyRollOnLaggingChainDivergesSilently() public {
        OkuMoney leader = okuMoney;
        OkuMoney lagger = _second();

        vm.warp(T0);
        _apply(leader, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);
        _apply(lagger, RATE_BASE, T0 + BASE_WINDOW, RATE_SETTLE, T0 + DAY);

        // the leader's clock is past the base window: the roll re-arms the live successor
        vm.warp(T0 + BASE_WINDOW + 1000);
        _apply(leader, RATE_SETTLE, T0 + DAY, RATE_BASE, T0 + DAY + BASE_WINDOW);
        assertEq(leader.okuMLastAccrualTime(), T0 + BASE_WINDOW, "leader promoted");

        // the lagging chain receives the same artifact, but its clock is 2 hours behind
        vm.warp(T0 + BASE_WINDOW - 2 hours);
        _apply(lagger, RATE_SETTLE, T0 + DAY, RATE_BASE, T0 + DAY + BASE_WINDOW);
        assertEq(lagger.okuMLastAccrualTime(), T0 + BASE_WINDOW - 2 hours, "lagger re-anchored");

        vm.warp(T0 + DAY);
        assertTrue(leader.okuMMultiplier() != lagger.okuMMultiplier(), "chains diverged");
        // the stored schedules differ too, which a drift check on anchors would catch
        assertTrue(leader.okuMLastAccrualTime() != lagger.okuMLastAccrualTime());
    }
}

