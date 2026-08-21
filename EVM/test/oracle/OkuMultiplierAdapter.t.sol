// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {OkuMultiplierAdapter} from "../../src/oracle/OkuMultiplierAdapter.sol";

contract OkuMultiplierAdapterTest is BaseTest {
    OkuMultiplierAdapter internal feed;

    uint256 internal constant MIN_ANSWER = 0.99e18;
    uint256 internal constant MAX_ANSWER = 10e18;
    uint256 internal constant STALENESS = 7 days;

    function setUp() public override {
        super.setUp();
        feed = new OkuMultiplierAdapter(address(token), MIN_ANSWER, MAX_ANSWER, STALENESS);
    }

    // ============ Construction ============

    function test_Constructor_RejectsZeroToken() public {
        vm.expectRevert(Errors.ZeroAddress.selector);
        new OkuMultiplierAdapter(address(0), MIN_ANSWER, MAX_ANSWER, STALENESS);
    }

    function test_Constructor_RejectsInvertedBounds() public {
        vm.expectRevert(OkuMultiplierAdapter.InvalidBounds.selector);
        new OkuMultiplierAdapter(address(token), 2e18, 1e18, STALENESS);
    }

    function test_Constructor_RejectsZeroMin() public {
        vm.expectRevert(OkuMultiplierAdapter.InvalidBounds.selector);
        new OkuMultiplierAdapter(address(token), 0, MAX_ANSWER, STALENESS);
    }

    function test_Constructor_RejectsMaxAboveCeiling() public {
        vm.expectRevert(OkuMultiplierAdapter.InvalidBounds.selector);
        new OkuMultiplierAdapter(
            address(token), MIN_ANSWER, Constants.MAX_MULTIPLIER + 1, STALENESS
        );
    }

    function test_Constructor_RejectsZeroStaleness() public {
        vm.expectRevert(OkuMultiplierAdapter.InvalidBounds.selector);
        new OkuMultiplierAdapter(address(token), MIN_ANSWER, MAX_ANSWER, 0);
    }

    // ============ Metadata ============

    /// @notice 18 decimals, not Chainlink's conventional 8. An integrator assuming
    ///         8 would misprice by 1e10.
    function test_Decimals_Is18NotEight() public view {
        assertEq(feed.decimals(), 18);
    }

    function test_VersionAndDescription() public view {
        assertEq(feed.version(), 1);
        assertEq(feed.description(), "rUSDOku uiMultiplier / USD");
    }

    // ============ Live reads ============

    function test_LatestRoundData_TracksMultiplier() public {
        vm.prank(rateSetter);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 20 days);
        vm.warp(block.timestamp + 10 days);

        (, int256 answer,,,) = feed.latestRoundData();
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 reported = uint256(answer);
        assertEq(reported, token.uiMultiplier());
        assertGt(reported, Constants.PRECISION);
        assertTrue(feed.isHealthy());
    }

    function test_LatestRoundData_HealthyAtGenesis() public view {
        (, int256 answer,,,) = feed.latestRoundData();
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(uint256(answer), Constants.PRECISION);
    }

    // ============ Bounds ============

    function test_AboveMaxAnswer_Reverts() public {
        _accrueToAtLeast(11e18);
        vm.expectPartialRevert(OkuMultiplierAdapter.AnswerOutOfBounds.selector);
        feed.latestRoundData();
        assertFalse(feed.isHealthy());
    }

    function test_BelowMinAnswer_Reverts() public {
        // Bounds tighter than the genesis multiplier make the feed immediately
        // out of range — proving the lower guard fires, since the token itself
        // cannot go below 1e18.
        OkuMultiplierAdapter tight =
            new OkuMultiplierAdapter(address(token), 2e18, 10e18, STALENESS);
        vm.expectPartialRevert(OkuMultiplierAdapter.AnswerOutOfBounds.selector);
        tight.latestRoundData();
        assertFalse(tight.isHealthy());
    }

    // ============ Staleness ============

    function test_WithinStaleness_Ok() public {
        vm.prank(rateSetter);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 1 days);
        vm.warp(block.timestamp + 1 days + 6 days);
        feed.latestRoundData();
        assertTrue(feed.isHealthy());
    }

    /// @notice A rate that expired long ago leaves a flat, truthful multiplier —
    ///         but a consumer must not keep pricing off it forever.
    function test_PastStaleness_Reverts() public {
        vm.prank(rateSetter);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 1 days);
        vm.warp(block.timestamp + 1 days + STALENESS + 1);

        vm.expectPartialRevert(OkuMultiplierAdapter.StaleAnswer.selector);
        feed.latestRoundData();
        assertFalse(feed.isHealthy());
    }

    /// @notice `haltAccrual` pulls `rateEnd` to now, so the feed stays fresh for
    ///         `stalenessThreshold` and then goes stale. Consumers see the halt
    ///         through `isAccrualStopped()` immediately.
    function test_HaltAccrual_ReflectedImmediatelyThenGoesStale() public {
        vm.prank(rateSetter);
        token.setYieldRate(RATE_5_PCT_APY, block.timestamp + 20 days);
        vm.warp(block.timestamp + 5 days);

        assertFalse(feed.isAccrualStopped());
        vm.prank(guardian);
        token.haltAccrual();

        assertTrue(feed.isAccrualStopped(), "halt is immediately observable");
        assertTrue(feed.isHealthy(), "but still fresh");

        vm.warp(block.timestamp + STALENESS + 1);
        assertFalse(feed.isHealthy(), "and eventually stale");
    }

    function test_IsAccrualStopped_TrueAtGenesis() public view {
        // `initialize` leaves rateEnd == lastAccrualTime == now, so accrual is
        // stopped until the first rate is set. Correct and observable.
        assertTrue(feed.isAccrualStopped());
    }

    // ============ Historical rounds ============

    function test_GetRoundData_AlwaysReverts() public {
        vm.expectRevert(OkuMultiplierAdapter.NoDataPresent.selector);
        feed.getRoundData(1);
    }
}
