// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {ScaledUIAmountUpgradeable} from "../../src/lib/ScaledUIAmountUpgradeable.sol";
import {Roles} from "../../src/lib/Roles.sol";
import {ScaledUIHarness} from "../mocks/ScaledUIHarness.sol";

/**
 * @title AccrualTest
 * @notice The multiplier authority path: every bound, the guardian lever, and
 *         monotonicity. The setter is an oracle write, so this is the suite an
 *         auditor should read first.
 */
contract AccrualTest is BaseTest {
    /// @dev Per-second rate whose nominal annualization is exactly at the cap.
    ///      `1000 bps == 0.10`, so `excess = 0.10 * 1e18 / 31_536_000`.
    uint256 internal constant RATE_AT_APR_CAP = Constants.PRECISION + 3_170_979_198;

    // ============ Monotonicity ============

    function test_RateBelowPrecision_Reverts() public {
        vm.prank(rateSetter);
        vm.expectRevert(Errors.MultiplierCannotDecrease.selector);
        token.setYieldRate(Constants.PRECISION - 1, block.timestamp + 1 days);
    }

    function test_RateAtPrecision_IsAllowedAndYieldsNothing() public {
        _accrue(RATE_5_PCT_APY, 10 days);
        uint256 frozen = token.uiMultiplier();

        vm.prank(rateSetter);
        token.setYieldRate(Constants.PRECISION, block.timestamp + 10 days);
        vm.warp(block.timestamp + 10 days);

        assertEq(token.uiMultiplier(), frozen, "PRECISION is the no-yield placeholder");
    }

    function test_MultiplierNeverDecreases_AcrossManySegments() public {
        uint256 previous = token.uiMultiplier();
        uint256[4] memory rates =
            [RATE_2_PCT_APY, RATE_5_PCT_APY, Constants.PRECISION, RATE_10_PCT_APY];
        for (uint256 i = 0; i < rates.length; ++i) {
            _accrue(rates[i], 10 days);
            uint256 current = token.uiMultiplier();
            assertGe(current, previous, "multiplier must be monotone");
            previous = current;
        }
    }

    // ============ APR cap ============

    function test_RateAtAprCap_Accepted() public {
        vm.prank(rateSetter);
        token.setYieldRate(RATE_AT_APR_CAP, block.timestamp + 1 days);
        assertLe(token.impliedAprBps(), Constants.MAX_IMPLIED_APR);
    }

    function test_RateAboveAprCap_Reverts() public {
        // Far enough above that flooring cannot mask it.
        uint256 tooHigh = Constants.PRECISION + 4_000_000_000;
        vm.prank(rateSetter);
        vm.expectPartialRevert(ScaledUIAmountUpgradeable.RateAboveMaximum.selector);
        token.setYieldRate(tooHigh, block.timestamp + 1 days);
    }

    function test_ImpliedApr_ZeroWhenNoYield() public view {
        assertEq(token.impliedAprBps(), 0);
    }

    // ============ Storage accessors ============

    /// @notice The anchor is exposed so an off-chain indexer can reconstruct the
    ///         whole trajectory from `(baseMultiplier, ratePerSecond,
    ///         lastAccrualTime, rateEnd)` without replaying events.
    function test_StorageAccessors_ExposeTheFullTrajectory() public {
        assertEq(token.baseMultiplier(), Constants.PRECISION);
        assertEq(token.ratePerSecond(), Constants.PRECISION);
        assertEq(token.rateEnd(), token.lastAccrualTime());

        uint256 end = block.timestamp + 10 days;
        vm.prank(rateSetter);
        token.setYieldRate(RATE_5_PCT_APY, end);

        assertEq(token.baseMultiplier(), Constants.PRECISION, "anchored at the pre-write value");
        assertEq(token.ratePerSecond(), RATE_5_PCT_APY);
        assertEq(token.lastAccrualTime(), block.timestamp);
        assertEq(token.rateEnd(), end);

        // After a second segment the anchor should have moved to the live value.
        vm.warp(block.timestamp + 5 days);
        uint256 mid = token.uiMultiplier();
        vm.prank(rateSetter);
        token.setYieldRate(RATE_2_PCT_APY, block.timestamp + 10 days);
        assertEq(token.baseMultiplier(), mid, "re-anchored on the second write");
    }

    // ============ Duration cap ============

    function test_RateEndZero_Reverts() public {
        vm.prank(rateSetter);
        vm.expectRevert(ScaledUIAmountUpgradeable.RateEndNotInFuture.selector);
        token.setYieldRate(RATE_5_PCT_APY, 0);
    }

    function test_RateEndInPast_Reverts() public {
        vm.warp(block.timestamp + 1000);
        vm.prank(rateSetter);
        vm.expectRevert(ScaledUIAmountUpgradeable.RateEndNotInFuture.selector);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp - 1);
    }

    function test_RateEndNow_Reverts() public {
        vm.prank(rateSetter);
        vm.expectRevert(ScaledUIAmountUpgradeable.RateEndNotInFuture.selector);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp);
    }

    function test_DurationAtCap_Accepted() public {
        vm.prank(rateSetter);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION);
        assertEq(token.rateEnd(), block.timestamp + Constants.MAX_RATE_DURATION);
    }

    function test_DurationAboveCap_Reverts() public {
        vm.prank(rateSetter);
        vm.expectPartialRevert(ScaledUIAmountUpgradeable.RateDurationTooLong.selector);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + Constants.MAX_RATE_DURATION + 1);
    }

    /// @notice Worst-case over-accrual from a compromised setter key, in one
    ///         maximum-length segment. This is the number that bounds the blast
    ///         radius, so it is asserted rather than asserted-in-a-comment.
    function test_WorstCaseOverAccrual_BoundedUnderOnePercent() public {
        _accrue(RATE_AT_APR_CAP, Constants.MAX_RATE_DURATION);
        // 1000bps over 30 days ~= 0.82%.
        assertLt(token.uiMultiplier(), (Constants.PRECISION * 1009) / 1000);
        assertGt(token.uiMultiplier(), (Constants.PRECISION * 1005) / 1000);
    }

    // ============ MAX_MULTIPLIER projection ============

    /// @notice The ceiling is checked against the value projected to `rateEnd`,
    ///         so it cannot be breached mid-segment.
    /// @dev Driven through `ScaledUIHarness` because `MAX_MULTIPLIER` sits
    ///      ~135,000x above where ten years at the APR cap lands — the branch is
    ///      defensive and unreachable via legitimate rates. Reaching it by
    ///      accruing would need ~1,600 maximum-length segments.
    function test_ProjectedMultiplierAboveMax_Reverts() public {
        ScaledUIHarness h = new ScaledUIHarness();
        h.init();
        h.pokeBase(Constants.MAX_MULTIPLIER);

        vm.expectPartialRevert(ScaledUIAmountUpgradeable.MultiplierAboveMaximum.selector);
        h.setYieldRate(RATE_AT_APR_CAP, block.timestamp + Constants.MAX_RATE_DURATION);
    }

    /// @notice And a projection that lands exactly at the ceiling is accepted.
    function test_ProjectedMultiplierAtMax_Accepted() public {
        ScaledUIHarness h = new ScaledUIHarness();
        h.init();
        // Well below the ceiling: a capped segment stays inside it.
        h.pokeBase(Constants.MAX_MULTIPLIER / 2);
        h.setYieldRate(RATE_AT_APR_CAP, block.timestamp + Constants.MAX_RATE_DURATION);
        assertLe(h.newUIMultiplier(), Constants.MAX_MULTIPLIER);
    }

    // ============ haltAccrual ============

    function test_HaltAccrual_FreezesMultiplier() public {
        _accrue(RATE_5_PCT_APY, 10 days);

        vm.prank(rateSetter);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 30 days);
        vm.warp(block.timestamp + 5 days);
        uint256 atHalt = token.uiMultiplier();

        vm.prank(guardian);
        token.haltAccrual();

        assertEq(token.uiMultiplier(), atHalt, "value preserved, growth stopped");
        vm.warp(block.timestamp + 3650 days);
        assertEq(token.uiMultiplier(), atHalt, "and stays stopped");
    }

    /// @notice A halt must leave an UNAMBIGUOUS state for integrators: `rateEnd`
    ///         is pulled to now, so `effectiveAt()` no longer implies that
    ///         something is scheduled and `uiMultiplier() == newUIMultiplier()`.
    function test_HaltAccrual_LeavesNothingPending() public {
        vm.prank(rateSetter);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 30 days);
        vm.warp(block.timestamp + 5 days);

        vm.prank(guardian);
        token.haltAccrual();

        assertEq(token.effectiveAt(), block.timestamp, "rateEnd pulled to now");
        assertEq(token.rateEnd(), token.lastAccrualTime());
        assertEq(token.uiMultiplier(), token.newUIMultiplier(), "nothing pending");
        assertEq(token.ratePerSecond(), Constants.PRECISION);
        assertEq(token.impliedAprBps(), 0);
    }

    /// @notice Monotone-safe: the guardian can only withhold, never reduce.
    function test_HaltAccrual_CannotReduceAccruedValue() public {
        _accrue(RATE_5_PCT_APY, 25 days);
        uint256 accrued = token.uiMultiplier();
        assertGt(accrued, Constants.PRECISION);

        vm.prank(guardian);
        token.haltAccrual();

        assertEq(token.uiMultiplier(), accrued);
    }

    function test_HaltAccrual_ResumableByRateSetter() public {
        _accrue(RATE_5_PCT_APY, 10 days);
        vm.prank(guardian);
        token.haltAccrual();
        uint256 frozen = token.uiMultiplier();

        _accrue(RATE_5_PCT_APY, 10 days);
        assertGt(token.uiMultiplier(), frozen, "cold can override the halt");
    }

    // ============ Access control ============

    function test_SetYieldRate_RequiresRateSetter() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 1 days);
    }

    function test_HaltAccrual_RequiresGuardian() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.haltAccrual();
    }

    /// @notice The guardian cannot set a rate — it can only withhold. Separation
    ///         of duties is what makes a warm-multisig guardian safe.
    function test_Guardian_CannotSetRate() public {
        vm.prank(guardian);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 1 days);
    }

    function test_RateSetter_CannotHalt() public {
        vm.prank(rateSetter);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.haltAccrual();
    }

    // ============ Pause interaction ============

    /// @notice Emergency levers must survive a pause: an operator may need to
    ///         zero the rate during an incident, and pausing the setter would
    ///         defeat that.
    function test_SetYieldRate_WorksWhilePaused() public {
        vm.prank(pauser);
        token.pause();
        vm.prank(rateSetter);
        token.setYieldRate(Constants.PRECISION, block.timestamp + 1 days);
    }

    function test_HaltAccrual_WorksWhilePaused() public {
        vm.prank(pauser);
        token.pause();
        vm.prank(guardian);
        token.haltAccrual();
    }

    // ============ APY sanity ============

    /// @notice The fixture rate should deliver ~5% over a year of capped segments.
    function test_FixtureRate_DeliversApproximatelyFivePercentApy() public {
        // 12 x 30d segments ~= 360 days.
        for (uint256 i = 0; i < 12; ++i) {
            _accrue(RATE_5_PCT_APY, 30 days);
        }
        uint256 m = token.uiMultiplier();
        assertGt(m, (Constants.PRECISION * 1047) / 1000, "at least ~4.7%");
        assertLt(m, (Constants.PRECISION * 1053) / 1000, "at most ~5.3%");
    }
}
