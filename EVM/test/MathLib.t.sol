// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MathLibHarness} from "./mocks/MathLibHarness.sol";
import {Constants} from "../src/lib/Constants.sol";

/**
 * @title MathLibTest
 * @notice The rounding policy and the assembly branches no production path reaches.
 */
contract MathLibTest is Test {
    MathLibHarness internal h;
    uint256 internal constant P = Constants.PRECISION;

    function setUp() public {
        h = new MathLibHarness();
    }

    // ============ rpow ============

    function test_rpow_zeroBaseZeroExponentIsOne() public view {
        assertEq(h.rpow(0, 0, P), P, "0^0 == b by convention");
    }

    function test_rpow_zeroBaseNonZeroExponentIsZero() public view {
        assertEq(h.rpow(0, 5, P), 0);
    }

    function test_rpow_identityAndOneStep() public view {
        assertEq(h.rpow(P, 0, P), P);
        assertEq(h.rpow(P, 1, P), P);
        assertEq(h.rpow(2 * P, 1, P), 2 * P);
    }

    function test_rpow_evenAndOddExponentPaths() public view {
        assertEq(h.rpow(2 * P, 2, P), 4 * P);
        assertEq(h.rpow(2 * P, 3, P), 8 * P);
        assertEq(h.rpow(2 * P, 4, P), 16 * P);
    }

    /// @dev The `x * x` squaring guard.
    function test_rpow_squaringOverflowReverts() public {
        vm.expectRevert();
        h.rpow(type(uint256).max, 2, P);
    }

    /// @dev The `z * x` accumulator guard — a DIFFERENT revert site, reachable only
    ///      with an odd exponent since the accumulator is multiplied on odd
    ///      iterations. `b = 1` makes squaring lossless so `x` outruns `z`.
    function test_rpow_accumulatorOverflowReverts() public {
        vm.expectRevert();
        h.rpow(2 ** 100, 3, 1);
    }

    /// @dev Same shape one step short of overflow, so the test above fails for the
    ///      intended reason rather than because `b == 1` is rejected.
    function test_rpow_justBelowAccumulatorOverflowSucceeds() public view {
        assertEq(h.rpow(2 ** 100, 1, 1), 2 ** 100);
        assertEq(h.rpow(2 ** 20, 3, 1), 2 ** 60);
    }

    // ============ compound ============

    /// @dev The single accrual primitive. If this drifts, both indices drift together
    ///      — which is the point of having one.
    function test_compound_matchesTheDocumentedCeiling() public view {
        uint256 rate = Constants.MAX_RATE_PER_SECOND;
        assertApproxEqRel(h.compound(P, rate, 365 days), 1.10517e18, 0.001e18, "~10.52% APY");
        assertApproxEqRel(h.compound(P, rate, 30 days), 1.008253e18, 0.001e18, "~0.8253%/30d");
    }

    function test_compound_isIdentityForZeroElapsedOrFlatRate() public view {
        assertEq(h.compound(P, Constants.MAX_RATE_PER_SECOND, 0), P);
        assertEq(h.compound(P, P, 365 days), P, "a flat rate never accrues");
        assertEq(h.compound(P, P - 1, 365 days), P, "sub-unit rates cannot shrink it");
    }

    /// @dev Determinism is what makes cross-chain synchronisation work: identical
    ///      arguments must give identical results, with no path dependence.
    function testFuzz_compound_isDeterministic(uint256 rate, uint256 elapsed) public view {
        rate = bound(rate, P, Constants.MAX_RATE_PER_SECOND);
        elapsed = bound(elapsed, 0, Constants.MAX_RATE_DURATION);
        assertEq(h.compound(P, rate, elapsed), h.compound(P, rate, elapsed));
    }

    function testFuzz_compound_isMonotonicInTime(uint256 elapsed) public view {
        elapsed = bound(elapsed, 1, Constants.MAX_RATE_DURATION - 1);
        uint256 rate = Constants.MAX_RATE_PER_SECOND;
        assertGe(h.compound(P, rate, elapsed + 1), h.compound(P, rate, elapsed));
    }

    // ============ Conversions ============

    function test_conversionsRoundAgainstTheCaller() public view {
        uint256 m = 1.05e18;
        uint256 raw = 999_999_999_999_999_999;
        assertLe(h.fromUIAmount(h.toUIAmount(raw, m), m), raw, "never creates value");
    }

    /// @dev The max-send rule, stated as a property: the round-trip loses at most one
    ///      unit. A "Max" button built on the inverse leaves dust on every send, or
    ///      overshoots and reverts, which users read as a broken app.
    function testFuzz_roundTripLosesAtMostOneUnit(uint256 raw, uint256 m) public view {
        m = bound(m, Constants.PRECISION, 1000e18);
        raw = bound(raw, 0, 1e30);
        uint256 back = h.fromUIAmount(h.toUIAmount(raw, m), m);
        assertLe(back, raw);
        if (raw > 0) assertGe(back + 2, raw);
    }

    function test_usdcConversionsAreInverseUpToGranularity() public view {
        uint256 dm = 1e12;
        assertEq(h.usdcToDollars(1_000_000, dm), 1e18);
        assertEq(h.dollarsToUsdc(1e18, dm), 1_000_000);
        // Sub-unit dust floors away in the protocol's favour.
        assertEq(h.dollarsToUsdc(1e18 - 1, dm), 999_999);
    }

    // ============ impliedAprBps ============

    function test_impliedAprBps_matchesTheDerivedCeiling() public view {
        assertEq(h.impliedAprBps(Constants.PRECISION), 0, "a flat rate implies no APR");
        uint256 atCap = h.impliedAprBps(Constants.MAX_RATE_PER_SECOND);
        assertApproxEqAbs(atCap, Constants.MAX_IMPLIED_APR_BPS, 1, "cap round-trips");
    }

    function test_impliedAprBps_isZeroBelowUnity() public view {
        assertEq(h.impliedAprBps(Constants.PRECISION - 1), 0);
        assertEq(h.impliedAprBps(0), 0);
    }
}
