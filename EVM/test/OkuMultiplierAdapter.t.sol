// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {OkuMultiplierAdapter} from "../src/oracle/OkuMultiplierAdapter.sol";
import {Constants} from "../src/lib/Constants.sol";

/**
 * @title OkuMultiplierAdapterTest
 * @notice The adapter makes this protocol a price PUBLISHER. A wrong answer
 *         here mints borrowing power in someone else's lending market, so the
 *         bounds and liveness signals are the whole point of the contract.
 */
contract OkuMultiplierAdapterTest is BaseTest {
    OkuMultiplierAdapter internal adapter;

    int256 internal constant MIN_ANSWER = 1e18; // never below $1.00
    int256 internal constant MAX_ANSWER = 2e18; // sanity ceiling for these tests
    uint256 internal constant STALENESS = 45 days;

    function setUp() public override {
        super.setUp();
        adapter = new OkuMultiplierAdapter(address(okuM), MIN_ANSWER, MAX_ANSWER, STALENESS);
    }

    // ============ Construction ============

    function test_constructor_rejectsZeroToken() public {
        vm.expectRevert(OkuMultiplierAdapter.ZeroAddress.selector);
        new OkuMultiplierAdapter(address(0), MIN_ANSWER, MAX_ANSWER, STALENESS);
    }

    function test_constructor_rejectsInvertedBounds() public {
        vm.expectRevert(OkuMultiplierAdapter.InvalidBounds.selector);
        new OkuMultiplierAdapter(address(okuM), MAX_ANSWER, MIN_ANSWER, STALENESS);
    }

    function test_constructor_rejectsEqualBounds() public {
        vm.expectRevert(OkuMultiplierAdapter.InvalidBounds.selector);
        new OkuMultiplierAdapter(address(okuM), MIN_ANSWER, MIN_ANSWER, STALENESS);
    }

    function test_immutablesExposed() public view {
        assertEq(address(adapter.OKU_M()), address(okuM));
        assertEq(adapter.MIN_ANSWER(), MIN_ANSWER);
        assertEq(adapter.MAX_ANSWER(), MAX_ANSWER);
        assertEq(adapter.STALENESS_THRESHOLD(), STALENESS);
    }

    // ============ Chainlink surface ============

    /// @dev 18, NOT Chainlink's usual 8. An integrator assuming the usual
    ///      convention misprices by 1e10. This is the single most likely
    ///      integration error against this contract.
    function test_decimalsIs18NotChainlinkDefault8() public view {
        assertEq(adapter.decimals(), 18, "must be 18");
        assertTrue(adapter.decimals() != 8, "must NOT be Chainlink's usual 8");
    }

    function test_descriptionAndVersion() public view {
        assertEq(adapter.description(), "OkuM / USD (uiMultiplier adapter)");
        assertEq(adapter.version(), 1);
    }

    function test_latestRoundData_tracksLiveMultiplier() public {
        (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredIn) =
            adapter.latestRoundData();

        assertEq(answer, int256(Constants.PRECISION), "reports the live multiplier");
        assertEq(updatedAt, okuM.effectiveAt(), "updatedAt is the last mark");
        assertEq(startedAt, updatedAt);
        assertEq(roundId, 1);
        assertEq(answeredIn, 1);

        _stepOkuMultiplier(50);
        (, int256 after_,,,) = adapter.latestRoundData();
        assertEq(after_, int256(okuM.uiMultiplier()), "follows the mark");
        assertGt(after_, answer);
    }

    /// @dev This is a live derivation from OkuM's current state, not a push feed
    ///      with history. Returning stale invented rounds would be worse than
    ///      refusing.
    function test_getRoundData_alwaysReverts() public {
        vm.expectRevert(OkuMultiplierAdapter.NoDataPresent.selector);
        adapter.getRoundData(1);

        vm.expectRevert(OkuMultiplierAdapter.NoDataPresent.selector);
        adapter.getRoundData(0);
    }

    // ============ Health / liveness ============

    function test_isHealthy_trueWhenInBoundsAndFresh() public view {
        assertTrue(adapter.isHealthy());
        assertFalse(adapter.isAccrualStopped());
    }

    function test_isHealthy_falseWhenAboveMaxAnswer() public {
        // Walk the multiplier past MAX_ANSWER in MAX_STEP_BPS-sized steps.
        while (okuM.uiMultiplier() <= uint256(MAX_ANSWER)) {
            _stepOkuMultiplier(Constants.MAX_STEP_BPS);
        }
        assertGt(int256(okuM.uiMultiplier()), MAX_ANSWER);
        assertFalse(adapter.isHealthy(), "must go unhealthy above maxAnswer");
    }

    function test_isHealthy_falseWhenBelowMinAnswer() public {
        // M_oku is monotone and starts at PRECISION, so it can never fall below
        // a 1e18 floor in practice. Prove the branch with a tighter adapter.
        OkuMultiplierAdapter strict = new OkuMultiplierAdapter(address(okuM), 2e18, 3e18, STALENESS);
        assertLt(int256(okuM.uiMultiplier()), int256(2e18));
        assertFalse(strict.isHealthy(), "must go unhealthy below minAnswer");
    }

    /// @dev A lapsed mark leaves the multiplier flat and TRUTHFUL, but a consumer
    ///      should not price off it indefinitely. Staleness is a liveness signal,
    ///      not a correctness one.
    function test_isAccrualStopped_afterThreshold() public {
        assertFalse(adapter.isAccrualStopped());

        vm.warp(block.timestamp + STALENESS + 1);
        assertTrue(adapter.isAccrualStopped(), "stale after the threshold");
        assertFalse(adapter.isHealthy(), "stale implies unhealthy");
    }

    function test_isAccrualStopped_freshAgainAfterNewMark() public {
        vm.warp(block.timestamp + STALENESS + 1);
        assertTrue(adapter.isAccrualStopped());

        _stepOkuMultiplier(25);

        assertFalse(adapter.isAccrualStopped(), "a new mark restores freshness");
        assertTrue(adapter.isHealthy());
    }

    function test_isAccrualStopped_exactlyAtThresholdIsStillFresh() public {
        vm.warp(okuM.effectiveAt() + STALENESS);
        assertFalse(adapter.isAccrualStopped(), "boundary is inclusive-fresh");

        vm.warp(block.timestamp + 1);
        assertTrue(adapter.isAccrualStopped());
    }

    /// @dev A halted index still reports its last value truthfully; it just goes
    ///      stale. Halting is not the same as the feed being wrong.
    function test_haltedAccrualGoesStaleButKeepsReportingLastValue() public {
        _stepOkuMultiplier(50);
        uint256 marked = okuM.uiMultiplier();

        vm.prank(guardian);
        okuM.haltAccrual();

        vm.warp(block.timestamp + STALENESS + 1);

        (, int256 answer,,,) = adapter.latestRoundData();
        assertEq(answer, int256(marked), "still truthful");
        assertTrue(adapter.isAccrualStopped(), "but flagged stale");
    }
}
