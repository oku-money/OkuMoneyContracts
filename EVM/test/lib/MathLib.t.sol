// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MathLibHarness} from "../mocks/MathLibHarness.sol";

/**
 * @title MathLibTest
 * @notice Branch-coverage tests for `MathLib`. Drives the `rpow` assembly
 *         branches that are unreachable from production callers operating in
 *         normal input ranges:
 *           * `x == 0, n == 0` -> z := b
 *           * `x == 0, n  > 0` -> z := 0
 *           * inner-loop `mul(z, x)` overflow revert
 *         Also pins the unit-conversion helpers at both even and non-even
 *         multipliers so a future refactor cannot silently re-introduce
 *         off-by-one drift.
 * @dev `rpow` is MakerDAO's battle-tested exponentiation; these tests exist
 *      purely for branch coverage of the assembly and to document the
 *      mathematical invariants in unit form.
 */
contract MathLibTest is Test {
    uint256 internal constant PRECISION = 1e18;

    MathLibHarness internal h;

    function setUp() public {
        h = new MathLibHarness();
    }

    // ============ rpow zero-base branches ============

    /// @notice `0^0` is defined as the precision base `b` (matches MakerDAO convention).
    function test_Rpow_ZeroBaseZeroExp_ReturnsB() public view {
        assertEq(h.rpow(0, 0, PRECISION), PRECISION);
        assertEq(h.rpow(0, 0, 1e27), 1e27);
        assertEq(h.rpow(0, 0, 1), 1);
    }

    /// @notice `0^n` for `n > 0` is `0`.
    function test_Rpow_ZeroBaseNonzeroExp_ReturnsZero() public view {
        assertEq(h.rpow(0, 1, PRECISION), 0);
        assertEq(h.rpow(0, 5, PRECISION), 0);
        assertEq(h.rpow(0, type(uint256).max, PRECISION), 0);
    }

    // ============ rpow happy paths ============

    /// @notice `x^1` with `b == 1` returns `x` unchanged.
    function test_Rpow_OneExp_ReturnsX() public view {
        assertEq(h.rpow(7, 1, 1), 7);
        assertEq(h.rpow(PRECISION, 1, PRECISION), PRECISION);
    }

    /// @notice `b^n / b^(n-1) == b` for any `n` when `x == b`.
    function test_Rpow_BaseEqualsBase_IsIdempotent() public view {
        assertEq(h.rpow(PRECISION, 10, PRECISION), PRECISION);
    }

    // ============ rpow overflow revert ============
    //
    // The inner `mul(z, x)` overflow check (line 46) requires `mul(z, x)` to
    // overflow inside the loop *after* the initial squaring. We use `b == 1`
    // (no normalization) and a base/exponent pair chosen so the loop runs
    // multiple iterations and the accumulated product crosses 2**256.

    /// @notice Drives the inner `mul(z, x)` overflow guard (the `if and(iszero...
    ///         ...) { revert(0,0) }` path). With b == 1 (no normalization) and
    ///         the chosen (x, n) pair, the squaring step `xx = x*x` stays
    ///         under 2**256 but the subsequent `z*x` accumulator multiply
    ///         overflows.
    ///         (x=2^100, n=3): z := x = 2^100, then in the loop iter x becomes
    ///         x*x = 2^200, and zx := z*x = 2^300 -> overflow.
    function test_Rpow_AccumulatorOverflowReverts() public {
        vm.expectRevert();
        h.rpow(2 ** 100, 3, 1);
    }

    /// @notice Drives the squaring `mul(x, x)` overflow guard. With x ≥ 2**128
    ///         and any n that triggers a squaring iteration, the inner xx
    ///         multiplication overflows first.
    function test_Rpow_SquareOverflowReverts() public {
        vm.expectRevert();
        h.rpow(2 ** 200, 4, 1);
    }

    // ============ Unit-conversion helpers ============

    function test_OkuMToDollars_EvenMultiplier() public view {
        assertEq(h.okuMToDollars(100e18, PRECISION), 100e18);
    }

    function test_OkuMToDollars_NonEvenMultiplier() public view {
        // 100 OkuM at $1.05 -> $105.
        assertEq(h.okuMToDollars(100e18, 105e16), 105e18);
    }

    function test_DollarsToOkuM_RoundTripFloor() public view {
        uint256 okuM = h.dollarsToOkuM(105e18, 105e16);
        // dollarsToOkuM floors; round trip back is bounded above by input.
        assertLe(h.okuMToDollars(okuM, 105e16), 105e18);
        // And within 1 wei of input (truncation is at most 1 unit in the floor direction).
        assertGe(h.okuMToDollars(okuM, 105e16), 105e18 - 1);
    }

    function test_UsdcToDollars_AndBack() public view {
        uint256 usdc = 1_000_000; // 1 USDC, 6 decimals
        uint256 dm = 1e12;
        uint256 dollars = h.usdcToDollars(usdc, dm);
        assertEq(dollars, 1e18);
        assertEq(h.dollarsToUsdc(dollars, dm), usdc);
    }

    function test_WrappedSharesFromOkuM_MatchesOkuMToWrappedUsd() public view {
        // Tight identity: okuMToWrappedUsd is wrappedSharesFromOkuM rescaled by
        // usdMult/PRECISION. Both helpers must agree on the same truncation path.
        uint256 okuM = 100e18;
        uint256 okuMMult = 105e16;
        uint256 usdMult = 11e17; // 1.1
        uint256 shares = h.wrappedSharesFromOkuM(okuM, okuMMult, usdMult);
        uint256 expectedUsd = (shares * usdMult) / PRECISION;
        assertEq(h.okuMToWrappedUsd(okuM, okuMMult, usdMult), expectedUsd);
    }
}
