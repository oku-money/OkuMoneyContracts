// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {OkuMoney} from "../../src/token/OkuMoney.sol";
import {Deploy} from "../shared/Deploy.sol";

/// @notice Pins the accepted residual of Cyfrin audit #13: re-arming an UNCHANGED rate
///         re-anchors the stored base at each chain's own landing second, and the integer
///         rounding of that re-anchor makes the stored schedule depend on the landing
///         second, so identical broadcasts leave two chains a few wei apart (the sign of the
///         gap depends on the skew; at 12 s the later chain is the higher one).
///
///         The curve is mathematically unchanged by a re-arm; only rounding differs. The
///         numbers below are the ones the READMEs and `epoch-accounting.md` quote, so a
///         change to the accrual math that moves them has to revisit that text.
contract OkuMoneyRearmSkewTest is BaseTest {
    uint256 internal constant T0 = 1_800_000_000;
    uint256 internal constant DAY = 1 days;
    uint256 internal constant BASE_WINDOW = 80_640;
    uint256 internal constant SKEW = 12;
    // about 5% APY and about 8% APY as per-second rates
    uint256 internal constant RATE_BASE = 1_000_000_001_547_126_016;
    uint256 internal constant RATE_SETTLE = 1_000_000_002_440_418_608;

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

    /// @dev The epoch pipeline's two re-arms per epoch, the second chain landing `skew`
    ///      seconds after the first. Returns both multipliers at the end of the run.
    function _runPipeline(uint256 epochs, uint256 skew) internal returns (uint256 mA, uint256 mB) {
        OkuMoney chainA = okuMoney;
        (OkuMoney chainB,) = Deploy.deployOkuMoney(admin);
        vm.prank(admin);
        chainB.grantRole(OKUM_RATE_MANAGER, rateManager);

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

        // every field the drift monitor compares exactly is identical
        assertEq(chainA.okuMRatePerSecond(), chainB.okuMRatePerSecond());
        assertEq(chainA.okuMRateEnd(), chainB.okuMRateEnd());
        assertEq(chainA.okuMPendingRatePerSecond(), chainB.okuMPendingRatePerSecond());
        assertEq(chainA.okuMPendingRateEnd(), chainB.okuMPendingRateEnd());

        return (chainA.okuMMultiplier(), chainB.okuMMultiplier());
    }

    /// @dev Cyfrin's measurement: 12 s of landing skew, 30 epochs, 81 wei apart, the chain
    ///      that landed later higher (about 1e-15 relative; the ledger-wide effect is that
    ///      its PSM pays that excess on redemptions, in proportion to the amount redeemed).
    function test_RearmSkew_30Epochs12sIs81Wei() public {
        (uint256 mA, uint256 mB) = _runPipeline(30, SKEW);
        assertEq(mA, 1_004_173_195_218_205_656);
        assertEq(mB, 1_004_173_195_218_205_737);
        assertEq(mB - mA, 81);
    }

    /// @dev The residual is dust against the drift monitor's 1 bps tolerance, whatever the
    ///      skew. Its sign depends on the skew (rounding goes either way), so only its size
    ///      is bounded.
    function testFuzz_RearmSkew_StaysFarInsideDriftTolerance(uint256 skew) public {
        skew = bound(skew, 0, 60);
        (uint256 mA, uint256 mB) = _runPipeline(10, skew);
        uint256 spread = mA > mB ? mA - mB : mB - mA;
        // 1 bps = 1e14 per 1e18; observed: tens of wei
        assertLt(spread, 1e4, "far inside the 1 bps drift tolerance");
    }

    /// @dev No skew, no divergence: the residual is landing-second rounding and nothing else.
    function test_RearmSkew_ZeroSkewIsExact() public {
        (uint256 mA, uint256 mB) = _runPipeline(10, 0);
        assertEq(mA, mB);
    }

    /// @dev The same rounding lets a paused same-rate, same-end re-arm (which the pause gate
    ///      admits: it compares rates and ends, both unchanged) raise the projected curve by
    ///      a few wei, so "may only lower the projected curve while paused" holds up to
    ///      integer rounding. Cyfrin's measurement: 7 wei at the window's end.
    function test_PausedSameRateRearm_RaisesProjectedCurveByRoundingDust() public {
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
        uint256 rearmed = okuMoney.okuMMultiplier();

        assertEq(rearmed - untouched, 7, "rounding dust, not yield");
        assertLt(rearmed - untouched, 100);
    }
}
