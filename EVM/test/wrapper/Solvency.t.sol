// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {USDOku} from "../../src/token/USDOku.sol";

/**
 * @title SolvencyTest
 * @notice The bound that defines the product's risk.
 *
 * @dev USDOku's declared liability MAY EXCEED realized backing — by design.
 *      That is what "forward-looking" means, and it is the reason the product
 *      can pay a smooth rate against a lumpy asset. It is only safe if the gap
 *      is bounded, measured, and funded:
 *
 *        liability = USDOku.totalSupply()                     // dollars, 1:1
 *        backing   = wrapper OkuM balance x M_oku             // dollars, realized
 *        gap       = liability - backing                      // may be > 0
 *        gapBps    = gap x 10_000 / backing                   // <= MAX_SOLVENCY_GAP_BPS
 *
 *      `MAX_SOLVENCY_GAP_BPS` is a CONSTANT, not a config field: no key can
 *      widen it. And the enforcement point is deliberately narrow — a single
 *      check, in `setUsdOkuRate`, against the liability PROJECTED TO `rateEnd`.
 *
 *      WHAT THAT ONE SITE ACTUALLY GUARANTEES — and what it does not. The check
 *      bounds the ABSOLUTE shortfall a write may create. It does NOT make the
 *      gap RATIO a continuously-preserved property, and an earlier version of
 *      this comment claimed it did. The correction is worth spelling out because
 *      the wrong version is intuitive:
 *
 *        - Wrap adds matching liability and backing, so the shortfall is
 *          unchanged and the ratio can only shrink. A wrap-side check would be
 *          unreachable code.
 *        - Unwrap removes matching liability and backing (both price at
 *          `M_oku`), so the shortfall is likewise unchanged — but the ratio's
 *          denominator SHRINKS, so `solvencyGapBps()` GROWS. Exits alone can
 *          walk it past 100 bps with no rate write at all.
 *        - `M_oku` steps only upward, so backing only ever grows.
 *        - Liability grows toward the projection and never past it.
 *
 *      So the invariant is on the absolute shortfall, not the ratio:
 *      `MAX_SOLVENCY_GAP_BPS` caps how much shortfall a write may add, measured
 *      against peak liability, and nothing else can add any (conversions are
 *      shortfall-neutral; only `M_usd` accrual widens it). See
 *      `SystemInvariants.invariant_ShortfallBoundedByPeakLiability`.
 *
 *      SURPLUS WITHDRAWAL is the mirror image, tested at the bottom of this
 *      file: once realized marks overtake declared liability, the wrapper
 *      holds genuinely excess OkuM, and `withdrawSurplus` is how issuer
 *      capital that funded a gap gets to leave once it is no longer needed.
 *
 *      The ratio remains the right MONITORING signal — a small shortfall
 *      becoming a large ratio is precisely the shape of a wrapper draining
 *      toward its last holders — but it is a signal, not a bound.
 */
contract SolvencyTest is BaseTest {
    function setUp() public override {
        super.setUp();
        _seedBuffer(10_000_000e6);
    }

    /// @dev A wrapped position: USDC -> OkuM -> USDOku.
    function _wrappedPosition(address user, uint256 usdcAmount) internal returns (uint256) {
        uint256 raw = _psmMint(user, usdcAmount);
        return _wrap(user, raw);
    }

    /// @dev Fund the wrapper's OkuM buffer — the on-chain shape of an issuer
    ///      top-up. The gap is funded by donating backing, never by diluting
    ///      OkuM holders.
    function _fundBacking(uint256 amount) internal {
        _mintRaw(treasury, amount);
        vm.prank(treasury);
        token.transfer(address(wrapper), amount);
    }

    // ============ Accounting ============

    function test_Views_ZeroLiabilityEdge() public view {
        assertEq(wrapper.declaredLiability(), 0);
        assertEq(wrapper.realizedBacking(), 0);
        assertEq(wrapper.solvencyGapBps(), 0, "no liability, no gap");
        assertEq(wrapper.backingRatioBps(), type(uint256).max);
    }

    /// @notice A fresh wrap is gap-neutral: liability and backing are created in
    ///         the same transaction at the same index.
    function test_Wrap_LeavesGapAtZero() public {
        _wrappedPosition(user1, 1000e6);
        assertEq(wrapper.declaredLiability(), wrapper.realizedBacking());
        assertEq(wrapper.solvencyGapBps(), 0);
        assertEq(wrapper.backingRatioBps(), Constants.BASIS_POINTS);
    }

    /// @notice Backing is valued at `M_oku`, so a step INCREASES backing against
    ///         an unchanged liability and pushes the gap negative (over-backed).
    ///         This is the mechanism by which realized performance closes a gap.
    function test_Step_ClosesTheGapByRaisingBacking() public {
        _wrappedPosition(user1, 1000e6);
        _accrueUsd(RATE_5_PCT_APY, 10 days);
        int256 gapBefore = wrapper.solvencyGapBps();
        assertGt(gapBefore, 0, "declared has run ahead");

        _stepBy(Constants.MAX_STEP_BPS);

        assertLt(wrapper.solvencyGapBps(), gapBefore, "realized catching up closes it");
    }

    function test_OverBackedGapIsNegative() public {
        _wrappedPosition(user1, 1000e6);
        _fundBacking(500e18);
        assertLt(wrapper.solvencyGapBps(), 0, "signed, so over-backing is expressible");
        assertGt(wrapper.backingRatioBps(), Constants.BASIS_POINTS);
    }

    /// @notice Donations count as backing. This is not an accident of using
    ///         `balanceOf` — it is the funding mechanism, and it must work
    ///         without any privileged call.
    function test_DonationsCountAsBacking() public {
        _wrappedPosition(user1, 1000e6);
        uint256 before = wrapper.realizedBacking();
        _fundBacking(100e18);
        assertEq(wrapper.realizedBacking(), before + 100e18);
    }

    // ============ The declared-rate check ============

    /// @notice The whole point: you cannot promise a rate the realized backing
    ///         cannot fund.
    ///
    /// @dev THE BOUND IS CUMULATIVE, NOT PER-WRITE, and that has to be driven
    ///      deliberately. Worst-case accrual inside one maximum-length segment is
    ///      `MAX_IMPLIED_APR` over `MAX_RATE_DURATION` ~= 79 bps, which is below
    ///      `MAX_SOLVENCY_GAP_BPS` (100) — so a single write from a zero gap can
    ///      NEVER be refused. Only consecutive segments that keep out-running the
    ///      realized marks reach the ceiling. Asserted here rather than left
    ///      implicit, because the constants have to be re-tuned together and a
    ///      test that reached the revert in one write would be silently wrong
    ///      about which constant was binding.
    function test_SetRate_RevertsOnceGapAccumulatesPastBound() public {
        _wrappedPosition(user1, 1_000_000e6);

        // First full-length segment at the cap: ~79 bps of gap. Accepted.
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_10_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);
        vm.warp(block.timestamp + Constants.MAX_RATE_DURATION);
        assertGt(wrapper.solvencyGapBps(), 0);
        assertLe(wrapper.solvencyGapBps(), int256(Constants.MAX_SOLVENCY_GAP_BPS));

        // Second segment would carry the accumulated gap past the ceiling.
        vm.prank(rateSetter);
        vm.expectPartialRevert(USDOku.SolvencyGapExceeded.selector);
        usdOku.setUsdOkuRate(RATE_10_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);
    }

    /// @notice The per-segment exposure bound, stated as the number it actually
    ///         is. If a constant changes, this fails and forces the interaction
    ///         above to be re-derived rather than assumed.
    function test_WorstCaseSingleSegmentAccrualIsBelowTheGapBound() public {
        _wrappedPosition(user1, 1_000_000e6);
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_10_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);
        vm.warp(block.timestamp + Constants.MAX_RATE_DURATION);

        int256 gap = wrapper.solvencyGapBps();
        assertGt(gap, 70, "worst-case single-segment accrual ~79 bps");
        assertLt(gap, 85);
        assertLt(
            uint256(gap),
            Constants.MAX_SOLVENCY_GAP_BPS,
            "so one write can never breach the bound from zero"
        );
    }

    /// @notice A modest rate over a short segment stays inside the bound and is
    ///         accepted. The check must not be so tight that the product cannot
    ///         pay yield at all.
    function test_SetRate_AcceptsRateWithinBound() public {
        _wrappedPosition(user1, 1_000_000e6);

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + 3 days);
        assertEq(usdOku.ratePerSecond(), RATE_5_PCT_APY);

        vm.warp(block.timestamp + 3 days);
        assertLe(wrapper.solvencyGapBps(), int256(Constants.MAX_SOLVENCY_GAP_BPS));
    }

    /// @notice PROJECTION, NOT SPOT. From an identical starting state the same
    ///         rate is refused for a long segment and accepted for a short one,
    ///         because the check is against where the liability ENDS UP, not
    ///         where it is now. This is what makes the bound un-breachable by the
    ///         mere passage of time — the same technique `MAX_MULTIPLIER` uses.
    function test_SetRate_ChecksProjectionNotSpotGap() public {
        _wrappedPosition(user1, 1_000_000e6);

        // Accumulate most of the allowance, leaving a small headroom.
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_10_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);
        vm.warp(block.timestamp + Constants.MAX_RATE_DURATION);
        int256 spot = wrapper.solvencyGapBps();
        assertLe(spot, int256(Constants.MAX_SOLVENCY_GAP_BPS), "spot is inside the bound");

        uint256 snapshot = vm.snapshotState();

        // Long segment from that state: refused on the projection alone.
        vm.prank(rateSetter);
        vm.expectPartialRevert(USDOku.SolvencyGapExceeded.selector);
        usdOku.setUsdOkuRate(RATE_10_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);

        vm.revertToState(snapshot);
        assertEq(wrapper.solvencyGapBps(), spot, "same spot gap");

        // Short segment from the SAME state: accepted.
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_10_PCT_APY, block.timestamp + 1 days);
        assertEq(usdOku.ratePerSecond(), RATE_10_PCT_APY);
    }

    /// @notice Funding the buffer raises the ceiling on the declarable rate. The
    ///         two levers — issuer capital and declared yield — are linked
    ///         on-chain rather than by policy alone.
    function test_FundingBackingRaisesTheDeclarableRate() public {
        _wrappedPosition(user1, 1_000_000e6);

        // Burn through the allowance so the next write is at the ceiling.
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_10_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);
        vm.warp(block.timestamp + Constants.MAX_RATE_DURATION);

        vm.prank(rateSetter);
        vm.expectPartialRevert(USDOku.SolvencyGapExceeded.selector);
        usdOku.setUsdOkuRate(RATE_10_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);

        // Issuer capital standing behind the smoothing restores the headroom.
        _fundBacking(100_000e18);

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_10_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);
        assertEq(usdOku.ratePerSecond(), RATE_10_PCT_APY);
    }

    /// @notice With no liability outstanding there is nothing to outrun, so any
    ///         legal rate is allowed. Without this carve-out the very first rate
    ///         write on a fresh deployment would be impossible (backing is zero,
    ///         so any gap is infinite).
    function test_SetRate_UnconstrainedWhileNoLiability() public {
        assertEq(usdOku.totalShares(), 0);
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_10_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);
        assertEq(usdOku.ratePerSecond(), RATE_10_PCT_APY);
    }

    /// @notice A LOWER rate is always writable, even while the gap is at its
    ///         limit. Slowing accrual is the only on-chain remedy for an
    ///         over-declared index (both indices are monotone — see Limitations),
    ///         so it must never be blocked by the very condition it fixes.
    function test_SetRate_CanAlwaysSlowDownEvenAtTheBound() public {
        _wrappedPosition(user1, 1_000_000e6);
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + 3 days);
        vm.warp(block.timestamp + 3 days);

        // Zero rate: no further accrual, so the projection equals the spot
        // liability and the check cannot refuse it.
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(Constants.PRECISION, block.timestamp + Constants.MAX_RATE_DURATION);
        assertEq(usdOku.ratePerSecond(), Constants.PRECISION);
    }

    /// @notice The guardian halt is likewise never solvency-gated — it can only
    ///         reduce the projection.
    function test_Halt_IsNeverSolvencyGated() public {
        _wrappedPosition(user1, 1_000_000e6);
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + 3 days);

        vm.prank(guardian);
        usdOku.haltUsdOkuAccrual();
        assertEq(usdOku.ratePerSecond(), Constants.PRECISION);
    }

    // ============ Unwrap is never solvency-gated ============

    /// @notice Refusing to let people out of a wrapper because the wrapper is
    ///         under-funded is how a slow problem becomes a panic. Unwrap has no
    ///         solvency precondition at all.
    function test_Unwrap_NeverGatedOnSolvency() public {
        uint256 out = _wrappedPosition(user1, 1000e6);
        _accrueUsd(RATE_5_PCT_APY, 10 days);
        assertGt(wrapper.solvencyGapBps(), 0, "the wrapper is under-backed");

        uint256 got = _unwrap(user1, out);
        assertGt(got, 0, "and the exit still works");
    }

    /// @notice The gap is realized by whoever exits: a holder whose balance grew
    ///         past realized backing CAN take out more OkuM than they put in,
    ///         funded by the buffer. That extraction IS the mechanism, bounded by
    ///         `MAX_SOLVENCY_GAP_BPS`, not a bug.
    function test_Gap_IsExtractableByExitingHolders() public {
        uint256 raw = _psmMint(user1, 1000e6);
        _wrap(user1, raw);
        _fundBacking(1000e18); // issuer capital standing behind the smoothing

        _accrueUsd(RATE_5_PCT_APY, Constants.MAX_RATE_DURATION);
        uint256 grown = usdOku.balanceOf(user1);

        uint256 got = _unwrap(user1, grown);
        assertGt(got, raw, "the smoothing gap is realized on exit");
    }

    // ============ The ratio amplifies as holders exit ============

    /// @notice AN EXIT DOES NOT WIDEN THE SHORTFALL, BUT IT DOES INFLATE THE
    ///         RATIO. Pinned deliberately: this is the property that makes
    ///         `solvencyGapBps()` a monitoring signal rather than an invariant,
    ///         and the fuzzer found it by driving the ratio to 146 bps against a
    ///         100 bps "bound" using nothing but unwraps.
    ///
    /// @dev An unwrap of `d` dollars burns `d` of liability and pays out `d` of
    ///      backing, so `L - B` is preserved exactly while `B` falls. Same
    ///      numerator, smaller denominator.
    ///
    ///      The consequence for operators is the useful part: as a wrapper
    ///      drains, a fixed dollar shortfall presents as an ever-worsening
    ///      percentage, and the last holders face the whole of it. That is the
    ///      real risk being measured, and it is why the alarm threshold belongs
    ///      on the ratio even though the contract bound is on the shortfall.
    function test_Unwrap_PreservesShortfallButInflatesTheRatio() public {
        uint256 raw = _psmMint(user1, 100_000e6);
        _wrap(user1, raw);
        // Deliberately UNFUNDED: the shortfall has to be real for the ratio to
        // have anything to amplify, and the wrapped principal alone is ample
        // backing for the partial exit below.

        // Open a shortfall via declared accrual.
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_10_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);
        vm.warp(block.timestamp + Constants.MAX_RATE_DURATION);

        uint256 shortfallBefore = wrapper.declaredLiability() - wrapper.realizedBacking();
        int256 ratioBefore = wrapper.solvencyGapBps();
        assertGt(shortfallBefore, 0);

        // Holders exit most of the position.
        _unwrap(user1, (usdOku.balanceOf(user1) * 9) / 10);

        uint256 shortfallAfter = wrapper.declaredLiability() - wrapper.realizedBacking();
        int256 ratioAfter = wrapper.solvencyGapBps();

        assertApproxEqAbs(shortfallAfter, shortfallBefore, 10, "the dollar shortfall is preserved");
        assertGt(ratioAfter, ratioBefore, "but the ratio inflates as backing drains");
    }

    // ============ Cumulative behaviour ============

    /// @notice A FULL CYCLE: declared runs ahead, then realized catches up and
    ///         overtakes. The gap must be positive in the middle and non-positive
    ///         at the end, and never breach the bound at any point.
    function test_FullCycle_DeclaredAheadThenRealizedCatchesUp() public {
        _wrappedPosition(user1, 100_000e6);

        // Phase 1 — declared moves first.
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + 5 days);
        vm.warp(block.timestamp + 5 days);
        int256 mid = wrapper.solvencyGapBps();
        assertGt(mid, 0, "declared ahead");
        assertLe(mid, int256(Constants.MAX_SOLVENCY_GAP_BPS), "but within the bound");

        // Phase 2 — realized marks catch up and overtake.
        _stepBy(Constants.MAX_STEP_BPS);
        assertLe(wrapper.solvencyGapBps(), 0, "realized has overtaken");
        assertGe(wrapper.backingRatioBps(), Constants.BASIS_POINTS);
    }

    /// @notice Many small holders and repeated conversions must not accumulate a
    ///         drift that walks the gap past the bound.
    function test_ManyHoldersRepeatedConversions_GapStaysBounded() public {
        address[3] memory users = [user1, user2, user3];
        for (uint256 i; i < users.length; i++) {
            _wrappedPosition(users[i], 10_000e6);
        }

        for (uint256 round; round < 5; round++) {
            vm.prank(rateSetter);
            usdOku.setUsdOkuRate(RATE_5_PCT_APY, block.timestamp + 2 days);
            vm.warp(block.timestamp + 2 days);
            _stepBy(Constants.MAX_STEP_BPS);

            for (uint256 i; i < users.length; i++) {
                uint256 half = usdOku.balanceOf(users[i]) / 2;
                if (half == 0) continue;
                uint256 back = _unwrap(users[i], half);
                _wrap(users[i], back);
            }

            assertLe(
                wrapper.solvencyGapBps(),
                int256(Constants.MAX_SOLVENCY_GAP_BPS),
                "gap breached the bound mid-cycle"
            );
        }
    }

    // ============ Surplus withdrawal ============

    /// @notice `surplus()` is zero at parity and whenever there is any gap —
    ///         it only ever reports backing genuinely IN EXCESS of liability.
    function test_Surplus_ZeroAtParityAndUnderGap() public {
        _wrappedPosition(user1, 1000e6);
        assertEq(wrapper.surplus(), 0, "gap-neutral wrap: no surplus");

        _accrueUsd(RATE_5_PCT_APY, 10 days);
        assertEq(wrapper.surplus(), 0, "a positive gap is not surplus");
    }

    function test_Surplus_ReportsDonatedBackingAboveParity() public {
        _wrappedPosition(user1, 1000e6);
        _fundBacking(250e18);

        // Donated backing minus the (zero) gap, converted back to raw OkuM at
        // the live multiplier — M_oku == 1e18 here, so it's exact.
        assertEq(wrapper.surplus(), 250e18);
    }

    function test_WithdrawSurplus_MovesExactlyWhatWasRequested() public {
        _wrappedPosition(user1, 1000e6);
        _fundBacking(250e18);

        uint256 balBefore = token.balanceOf(treasury);
        vm.prank(wrapperReserveManager);
        wrapper.withdrawSurplus(treasury, 100e18);

        assertEq(token.balanceOf(treasury), balBefore + 100e18);
        assertEq(wrapper.surplus(), 150e18, "remaining surplus reduced by exactly the withdrawal");
        assertGe(wrapper.realizedBacking(), wrapper.declaredLiability(), "still fully backed");
    }

    /// @notice THE BOUND: withdrawal may spend down to parity, never below it —
    ///         deliberately stricter than `MAX_SOLVENCY_GAP_BPS`. Spending down
    ///         to that ceiling would let capital walk a fresh gap open from the
    ///         withdrawal side, immediately undoing what a rate write's
    ///         projection check was policing from the other side.
    function test_WithdrawSurplus_RevertsPastParity() public {
        _wrappedPosition(user1, 1000e6);
        _fundBacking(100e18);

        vm.prank(wrapperReserveManager);
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("ExceedsSurplus(uint256,uint256)")), 100e18 + 1, 100e18
            )
        );
        wrapper.withdrawSurplus(treasury, 100e18 + 1);

        // Exactly at the surplus succeeds.
        vm.prank(wrapperReserveManager);
        wrapper.withdrawSurplus(treasury, 100e18);
        assertEq(wrapper.realizedBacking(), wrapper.declaredLiability(), "left at exact parity");
    }

    function test_WithdrawSurplus_ZeroWhenGapIsOpen() public {
        _wrappedPosition(user1, 1000e6);
        _accrueUsd(RATE_5_PCT_APY, 10 days);
        assertGt(wrapper.solvencyGapBps(), 0);

        vm.prank(wrapperReserveManager);
        vm.expectRevert(
            abi.encodeWithSelector(bytes4(keccak256("ExceedsSurplus(uint256,uint256)")), 1, 0)
        );
        wrapper.withdrawSurplus(treasury, 1);
    }

    function test_WithdrawSurplus_RequiresReserveManager() public {
        _wrappedPosition(user1, 1000e6);
        _fundBacking(100e18);

        vm.prank(wrapperAdmin); // sunset control is a different capability
        vm.expectRevert();
        wrapper.withdrawSurplus(treasury, 1e18);
    }

    function test_WithdrawSurplus_RejectsZeroAddressAndZeroAmount() public {
        _wrappedPosition(user1, 1000e6);
        _fundBacking(100e18);

        vm.startPrank(wrapperReserveManager);
        vm.expectRevert();
        wrapper.withdrawSurplus(address(0), 1e18);

        vm.expectRevert();
        wrapper.withdrawSurplus(treasury, 0);
        vm.stopPrank();
    }

    /// @notice The full lifecycle this exists for: fund a gap, let realized
    ///         marks overtake it, recover the now-excess capital.
    function test_FullCycle_FundGapThenRecoverOnceMarksOvertake() public {
        _wrappedPosition(user1, 1_000_000e6);
        _accrueUsd(RATE_10_PCT_APY, Constants.MAX_RATE_DURATION);
        assertGt(wrapper.solvencyGapBps(), 0, "declared ran ahead");

        // Issuer capital funds the gap so the next declaration can proceed.
        _fundBacking(2000e18);
        assertLe(wrapper.surplus(), 0 + 0, "still no surplus while any gap remains");

        // Realized marks catch up and overtake.
        _stepToAtLeast((token.uiMultiplier() * 10_500) / 10_000);
        assertLt(wrapper.solvencyGapBps(), 0, "now over-backed");
        assertGt(wrapper.surplus(), 0);

        uint256 recoverable = wrapper.surplus();
        vm.prank(wrapperReserveManager);
        wrapper.withdrawSurplus(treasury, recoverable);
        assertGe(wrapper.realizedBacking(), wrapper.declaredLiability());
    }
}
