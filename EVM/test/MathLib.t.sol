// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MathLibHarness} from "./mocks/MathLibHarness.sol";
import {Constants} from "../src/lib/Constants.sol";

/**
 * @title MathLibTest
 * @notice Covers the rounding policy and the `rpow` assembly branches that no
 *         production path can reach.
 */
contract MathLibTest is Test {
    MathLibHarness internal h;
    uint256 constant P = 1e18;

    function setUp() public {
        h = new MathLibHarness();
    }

    // ============ rpow branches ============

    function test_rpow_zeroBaseZeroExponentIsOne() public view {
        assertEq(h.rpow(0, 0, P), P, "0^0 == b by convention");
    }

    function test_rpow_zeroBaseNonZeroExponentIsZero() public view {
        assertEq(h.rpow(0, 5, P), 0);
    }

    function test_rpow_identityAndOneStep() public view {
        assertEq(h.rpow(P, 0, P), P, "anything^0 == b");
        assertEq(h.rpow(P, 1, P), P, "1.0^n == 1.0");
        assertEq(h.rpow(2 * P, 1, P), 2 * P);
    }

    function test_rpow_evenAndOddExponentPaths() public view {
        // Both the `mod(n,2)==0` and `==1` branches of the squaring loop.
        assertEq(h.rpow(2 * P, 2, P), 4 * P);
        assertEq(h.rpow(2 * P, 3, P), 8 * P);
        assertEq(h.rpow(2 * P, 4, P), 16 * P);
    }

    /// @dev The `x * x` squaring guard.
    function test_rpow_squaringOverflowReverts() public {
        vm.expectRevert();
        h.rpow(type(uint256).max, 2, P);
    }

    /// @dev The `z * x` accumulator guard, which is a *different* revert site to
    ///      the squaring guard above and needs an odd exponent to reach — the
    ///      accumulator is only multiplied on odd iterations.
    ///
    ///      `b = 1` makes the squaring step lossless (`x := x*x`), so `x` grows
    ///      to 2^200 while `z` is still 2^100 and the accumulator product
    ///      overflows before the squaring guard would fire. Unreachable from
    ///      `USDOku`, which always passes `b == PRECISION` and a bounded rate,
    ///      but it is the guard standing between a rate-setter mistake and a
    ///      silently wrapped index.
    function test_rpow_accumulatorOverflowReverts() public {
        vm.expectRevert();
        h.rpow(2 ** 100, 3, 1);
    }

    /// @dev Same shape, one step short of overflow: proves the test above fails
    ///      for the intended reason rather than because `b == 1` is rejected.
    function test_rpow_accumulatorJustBelowOverflowSucceeds() public view {
        assertEq(h.rpow(2 ** 100, 1, 1), 2 ** 100, "odd exponent, loop never runs");
        assertEq(h.rpow(2 ** 20, 3, 1), 2 ** 60, "(2^20)^3 fits");
    }

    /// @dev The compounding actually used by USDOku, at the documented cap.
    function test_rpow_matchesDocumentedAccrual() public view {
        uint256 rate = Constants.MAX_USD_RATE_PER_SECOND;
        assertApproxEqRel(h.rpow(rate, 365 days, P), 1.10517e18, 0.001e18, "~10.52% APY");
        assertApproxEqRel(h.rpow(rate, 30 days, P), 1.008253e18, 0.001e18, "~0.8253% / 30d");
    }

    // ============ Rounding policy ============

    function testFuzz_conversionsRoundAgainstTheCaller(uint256 raw, uint256 m) public view {
        raw = bound(raw, 0, 1e30);
        m = bound(m, P, Constants.MAX_MULTIPLIER);

        uint256 ui = h.toUIAmount(raw, m);
        assertLe(ui, (raw * m) / P + 1, "floors");

        uint256 back = h.fromUIAmount(ui, m);
        assertLe(back, raw, "round trip never inflates");
    }

    function test_usdcConversionsAreInverseUpToGranularity() public view {
        uint256 dm = 1e12;
        assertEq(h.usdcToDollars(1_000_000, dm), 1e18);
        assertEq(h.dollarsToUsdc(1e18, dm), 1_000_000);
        // Sub-unit dust is dropped in the protocol's favour.
        assertEq(h.dollarsToUsdc(1e18 - 1, dm), 999_999);
    }

    // ============ Fees ============

    /// @dev Fees round UP, payouts round DOWN — the protocol never under-collects.
    function test_applyFeeCeil_roundsUpAgainstThePayer() public view {
        (uint256 net, uint256 fee) = h.applyFeeCeil(1000, 100); // 1%
        assertEq(fee, 10);
        assertEq(net, 990);

        // 1 wei at 1% must still charge a full unit rather than zero.
        (uint256 net2, uint256 fee2) = h.applyFeeCeil(1, 100);
        assertEq(fee2, 1, "ceil, not floor");
        assertEq(net2, 0);
    }

    function test_applyFeeCeil_zeroBpsIsIdentity() public view {
        (uint256 net, uint256 fee) = h.applyFeeCeil(12_345, 0);
        assertEq(net, 12_345);
        assertEq(fee, 0);
    }

    // ============ APR ============

    function test_impliedAprBps_matchesTheDerivedCeiling() public view {
        assertEq(h.impliedAprBps(P), 0, "no yield is 0 bps");
        uint256 atCap = h.impliedAprBps(Constants.MAX_USD_RATE_PER_SECOND);
        assertLe(atCap, Constants.MAX_IMPLIED_APR_BPS, "the derived constant is within its cap");
        assertApproxEqAbs(atCap, Constants.MAX_IMPLIED_APR_BPS, 1, "and essentially at it");
    }
}
