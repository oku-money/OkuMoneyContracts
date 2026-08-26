// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {OkuMultiplierAdapter} from "../../src/oracle/OkuMultiplierAdapter.sol";

/**
 * @title OkuMultiplierAdapterTest
 * @notice Bounds, staleness, 18-decimal reporting, history refusal, sync-lock
 *         pass-through.
 * @dev STALENESS IS NOW ANCHORED ON THE LAST STEP. `M_oku` is stepwise, so
 *      `effectiveAt()` is the timestamp of the most recent `setOkuMultiplier`
 *      and `updatedAt == startedAt == effectiveAt()` — the honest figure for a
 *      consumer running its own freshness check. A lapsed mark leaves the
 *      multiplier flat and truthful; the threshold is what stops anyone pricing
 *      off it indefinitely.
 */
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
        assertEq(feed.description(), "OkuM uiMultiplier / USD");
    }

    // ============ Live reads ============

    function test_LatestRoundData_TracksMultiplier() public {
        _stepBy(50); // +0.5%

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

    /// @notice For a stepwise feed, `updatedAt` is the step timestamp — not the
    ///         read timestamp. A consumer's own staleness check must see the age
    ///         of the mark, not the age of the block.
    function test_UpdatedAtIsTheStepTimestampNotNow() public {
        _stepBy(10);
        uint256 stepTs = token.effectiveAt();
        vm.warp(block.timestamp + 3 days);

        (,, uint256 startedAt, uint256 updatedAt,) = feed.latestRoundData();
        assertEq(updatedAt, stepTs, "updatedAt is the mark, not the read");
        assertEq(startedAt, stepTs);
        assertLt(updatedAt, block.timestamp);
    }

    // ============ Bounds ============

    function test_AboveMaxAnswer_Reverts() public {
        _stepToAtLeast(11e18);
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
        _stepBy(10);
        // Anchored on the mark itself, not on `now`: `_stepBy` warps past the
        // sync window, so counting from the current block would silently
        // overshoot the threshold and test the wrong branch.
        vm.warp(token.effectiveAt() + STALENESS);
        feed.latestRoundData();
        assertTrue(feed.isHealthy());
    }

    /// @notice A mark that lapsed long ago leaves a flat, truthful multiplier —
    ///         but a consumer must not keep pricing off it forever.
    function test_PastStaleness_Reverts() public {
        _stepBy(10);
        vm.warp(token.effectiveAt() + STALENESS + 1);

        vm.expectPartialRevert(OkuMultiplierAdapter.StaleAnswer.selector);
        feed.latestRoundData();
        assertFalse(feed.isHealthy());
    }

    /// @notice A fresh step restores health. This is the operational loop: the
    ///         staleness threshold is a published cadence commitment, and the
    ///         only way to satisfy it is to keep marking.
    function test_StepRefreshesAfterStale() public {
        _stepBy(10);
        vm.warp(token.effectiveAt() + STALENESS + 1);
        assertFalse(feed.isHealthy());

        _stepBy(10);
        assertTrue(feed.isHealthy(), "a new mark clears staleness");
    }

    /// @notice `haltAccrual` blocks future steps, so the feed simply ages out.
    /// @dev The guardian halt is deliberately NOT surfaced as a distinct feed
    ///      signal: withholding a mark and being unable to make one are the same
    ///      thing from a consumer's perspective, and both show up as staleness.
    ///      An earlier revision had an `isAccrualStopped()` view, which under
    ///      continuous accrual meant "the rate segment expired". With stepwise
    ///      accrual every read is "stopped" between marks, so the view was
    ///      permanently true and told a consumer nothing. Removed.
    function test_HaltAccrual_AgesOutIntoStaleness() public {
        _stepBy(10);
        vm.prank(guardian);
        token.haltAccrual();

        assertTrue(feed.isHealthy(), "still fresh immediately after the halt");
        vm.warp(token.effectiveAt() + STALENESS + 1);
        assertFalse(feed.isHealthy(), "and eventually stale, with no way to refresh");
    }

    /// @notice At genesis the mark is the deploy timestamp, so the feed is fresh
    ///         from block one — no integration is broken by an unmarked token.
    function test_FreshAtGenesis() public view {
        assertEq(token.effectiveAt(), token.lastSteppedAt());
        assertTrue(feed.isHealthy());
    }

    // ============ Historical rounds ============

    function test_GetRoundData_AlwaysReverts() public {
        vm.expectRevert(OkuMultiplierAdapter.NoDataPresent.selector);
        feed.getRoundData(1);
    }

    // ============ Post-step sync window passthroughs ============

    function test_SyncWindow_PassthroughTracksTheToken() public {
        assertFalse(feed.isSyncLocked());
        assertEq(feed.syncLockedUntil(), 0);

        _stepNoWarp(1.001e18);

        assertTrue(feed.isSyncLocked(), "adapter must surface the module gate");
        assertEq(feed.syncLockedUntil(), token.syncLockedUntil());

        vm.warp(token.syncLockedUntil());
        assertFalse(feed.isSyncLocked());
    }

    /// @notice The window must NOT mark the feed unhealthy.
    ///
    /// @dev Deliberate. The multiplier is genuinely correct during a window —
    ///      the step that armed it has already landed HERE; the window holds
    ///      this chain still while the peer catches up. Reporting unhealthy
    ///      would trigger needless liquidation pauses on an accurate feed. The
    ///      narrower fact worth surfacing is that a position valued off this
    ///      feed cannot be unwound through the module for at most
    ///      `MAX_SYNC_WINDOW`, which `isSyncLocked()` says precisely.
    function test_SyncWindow_DoesNotAffectHealth() public {
        assertTrue(feed.isHealthy());

        _stepNoWarp(1.001e18);

        assertTrue(feed.isSyncLocked());
        assertTrue(feed.isHealthy(), "an accurate price must not be marked unhealthy");
        (, int256 answer,,,) = feed.latestRoundData();
        // casting to 'uint256' is safe because the adapter derives `answer`
        // from `uiMultiplier()`, which is monotonically >= PRECISION and
        // bounded by MAX_MULTIPLIER, so it is never negative.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(uint256(answer), token.uiMultiplier(), "and must still be readable");
    }
}
