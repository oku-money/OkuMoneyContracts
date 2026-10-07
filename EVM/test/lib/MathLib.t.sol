// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
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
 *         multipliers to catch off-by-one drift.
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

    /// @notice Drives the `add(xx, half)` rounding-overflow guard — the one
    ///         case where the squaring itself is fine but adding the rounding
    ///         term crosses 2**256.
    /// @dev Reaching it needs `x*x` to land just under 2**256 while `half`
    ///      (= b/2) is large enough to push it over, so the two inputs pull in
    ///      opposite directions: x must be < 2**128 or the SQUARING guard fires
    ///      first and this one is never reached. `x = 2**128 - 1` gives
    ///      `xx = 2**256 - 2**129 + 1`, the largest non-overflowing square, and
    ///      `b = 2**255` gives `half = 2**254`, comfortably more than the
    ///      `2**129 - 1` of headroom left.
    ///
    ///      Unreachable in production: `b` is always `PRECISION` (1e18), making
    ///      `half` 5e17 — around 2**59 — so `xx` would have to fall inside a
    ///      2**59-wide window immediately below 2**256, which the `x < 2**128`
    ///      precondition already excludes.
    function test_Rpow_RoundingTermOverflowReverts() public {
        vm.expectRevert();
        h.rpow(2 ** 128 - 1, 2, 2 ** 255);
    }

    /// @notice Drives the `add(zx, half)` rounding-overflow guard on the
    ///         accumulator leg — the last of the four `rpow` overflow rails.
    /// @dev The tightest of the four to reach. It needs `z*x` to sit inside
    ///      `[2**256 - half, 2**256)`: any lower and the add does not wrap, any
    ///      higher and the ACCUMULATOR guard on the line above fires instead.
    ///      Both `half` and the window are set by the same `b`, so widening the
    ///      target also shrinks the product that has to land in it. The values
    ///      below were found by search, not derivation — `n = 3` so the loop
    ///      runs exactly one iteration with `z` still equal to the original `x`.
    ///
    ///      Unreachable in production for the same reason as the test above:
    ///      `b == PRECISION` makes the target window ~2**59 wide out of 2**256.
    function test_Rpow_AccumulatorRoundingTermOverflowReverts() public {
        vm.expectRevert();
        h.rpow(2 ** 128 - 1, 3, 2 ** 128 - 3);
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

    // ============ Intermediate-overflow safety ============
    //
    // `MathLib` conversions use OpenZeppelin's 512-bit `Math.mulDiv`, so the
    // intermediate product `a * b` may exceed `type(uint256).max` provided the
    // final result `(a * b) / c` fits in 256 bits. Each input below makes `a * b`
    // overflow uint256 while the quotient still fits.

    /// @notice `okuMToDollars` succeeds when `okuMAmount * okuMMultiplier` exceeds
    ///         `uint256.max`.
    function test_OkuMToDollars_NoIntermediateOverflow() public view {
        // a * b = 2^150 * 2^150 = 2^300 > 2^256 (would overflow plain `*`)
        // result = 2^300 / 1e18 ≈ 2^240 (fits in uint256)
        uint256 a = 2 ** 150;
        uint256 b = 2 ** 150;
        uint256 expected = Math.mulDiv(a, b, PRECISION, Math.Rounding.Floor);
        assertEq(h.okuMToDollars(a, b), expected);
        // Sanity: result is large but fits in uint256.
        assertGt(expected, 2 ** 240);
        assertLt(expected, type(uint256).max);
    }

    /// @notice `dollarsToOkuM` succeeds when `dollarValue * PRECISION` exceeds
    ///         `uint256.max`.
    function test_DollarsToOkuM_NoIntermediateOverflow() public view {
        // dollarValue * 1e18 must overflow. dollarValue = 2^240 gives 2^240 * 1e18
        // which is ~ 2^240 * 2^60 = 2^300, well past 2^256.
        uint256 dollarValue = 2 ** 240;
        uint256 okuMMult = PRECISION; // 1.0 — result equals dollarValue
        uint256 result = h.dollarsToOkuM(dollarValue, okuMMult);
        assertEq(result, dollarValue);
    }

    /// @notice Wherever `a * b` fits in uint256, `okuMToDollars` is bit-identical
    ///         to plain floor arithmetic `(a * b) / PRECISION`.
    function testFuzz_OkuMToDollars_MatchesPlainArithmetic_InRange(
        uint256 a,
        uint256 b
    )
        public
        view
    {
        // Constrain to a * b <= type(uint256).max  ==>  a <= type(uint256).max / b
        b = bound(b, 1, PRECISION * 1e12); // up to 1e30 — well above MAX_MULTIPLIER
        a = bound(a, 0, type(uint256).max / b);

        assertEq(h.okuMToDollars(a, b), (a * b) / PRECISION, "must match plain arithmetic");
    }

    // ============ compoundFor / computeMultiplier ============
    // Direct branch coverage — exercised only transitively through OkuMoney's
    // own tests otherwise, which never drive the degenerate states below
    // (OkuMoney's writers never produce `rate <= PRECISION && rateEnd != 0`,
    // nor `anchor > rateEnd`), leaving those inputs untested despite being
    // reachable via the library's own public contract (any future caller).

    /// @notice compoundFor is the identity when elapsed == 0.
    function test_CompoundFor_ZeroElapsed_IsIdentity() public view {
        assertEq(h.compoundFor(12_345e17, PRECISION + 1e10, 0), 12_345e17);
    }

    /// @notice compoundFor clamps at MAX_MULTIPLIER rather than returning an
    ///         uncapped (but not-yet-overflowing) compounded value.
    function test_CompoundFor_ClampsAtMaxMultiplier() public view {
        uint256 MAX_MULTIPLIER = 1_000_000e18; // Constants.MAX_MULTIPLIER
        // A long elapsed time at a real (bounded) rate compounds well past the cap.
        uint256 result = h.compoundFor(1e18, PRECISION + 1e11, 365 days * 20);
        assertEq(result, MAX_MULTIPLIER);
    }

    /// @notice Branch 1 (halted): rate <= PRECISION with rateEnd == 0 (the
    ///         ONLY state OkuMoney's writers ever produce for a halted rate)
    ///         returns the flat base, ignoring anchor/nowTs entirely.
    function test_ComputeMultiplier_Branch1_Halted_ReturnsFlatBase() public view {
        uint256 result = h.computeMultiplier(15e17, PRECISION, 1000, 0, PRECISION, 0, 500_000);
        assertEq(result, 15e17);
    }

    /// @notice Branch 1 carries NO overhang leg: a halted active rate returns the
    ///         flat base even in the degenerate `rateEnd != 0` + successor-armed
    ///         state, which OkuMoney's writers cannot produce (setOkuMMultiplier
    ///         and the initializer zero rateEnd when halted; setOkuMYieldRate
    ///         rejects a non-zero endTimestamp for a halted rate; and
    ///         setNextOkuMYieldRate needs rateEnd != 0 to arm at all).
    /// @dev Branch 1 must not compound a successor: doing so from `rateEnd` when
    ///      `anchor > rateEnd` would apply yield across `[rateEnd, anchor]`, a span
    ///      already baked into `base`.
    function test_ComputeMultiplier_Branch1_HaltedWithArmedSuccessor_StillFlatBase() public view {
        uint256 base = 1e18;
        uint256 rateEnd = 1000;
        uint256 pendingRate = PRECISION + 1e11;
        uint256 pendingRateEnd = 2000;

        // anchor < rateEnd, past rateEnd but before pendingRateEnd.
        assertEq(
            h.computeMultiplier(base, PRECISION, 500, rateEnd, pendingRate, pendingRateEnd, 1500),
            base,
            "halted rate must not accrue a successor"
        );
        // anchor > rateEnd — compounding a successor here would double-count.
        assertEq(
            h.computeMultiplier(base, PRECISION, 1500, rateEnd, pendingRate, pendingRateEnd, 1800),
            base,
            "no retroactive yield across [rateEnd, anchor]"
        );
        // Far past pendingRateEnd.
        assertEq(
            h.computeMultiplier(
                base, PRECISION, 500, rateEnd, pendingRate, pendingRateEnd, 999_999
            ),
            base,
            "still flat regardless of how far past the pending window"
        );
    }

    /// @notice Branch 2 (yielding, window closed): compounds the active rate
    ///         through rateEnd, no pending rate armed.
    function test_ComputeMultiplier_Branch2_WindowClosed_NoSuccessor() public view {
        uint256 base = 1e18;
        uint256 rate = PRECISION + 1e11;
        uint256 anchor = 0;
        uint256 rateEnd = 1000;
        uint256 nowTs = 5000; // well past rateEnd

        uint256 result = h.computeMultiplier(base, rate, anchor, rateEnd, PRECISION, 0, nowTs);
        uint256 expected = h.compoundFor(base, rate, rateEnd - anchor);
        assertEq(result, expected, "must NOT keep compounding past rateEnd with no successor armed");
    }

    /// @notice Branch 2 with an armed successor: compounds to rateEnd at the
    ///         active rate, then the overhang at the pending rate.
    function test_ComputeMultiplier_Branch2_WindowClosed_WithSuccessor() public view {
        uint256 base = 1e18;
        uint256 rate = PRECISION + 1e11;
        uint256 anchor = 0;
        uint256 rateEnd = 1000;
        uint256 pendingRate = PRECISION + 2e11;
        uint256 nowTs = 1500;

        uint256 result = h.computeMultiplier(base, rate, anchor, rateEnd, pendingRate, 0, nowTs);
        uint256 atRateEnd = h.compoundFor(base, rate, rateEnd - anchor);
        uint256 expected = h.compoundFor(atRateEnd, pendingRate, nowTs - rateEnd);
        assertEq(result, expected);
    }

    /// @notice Branch 2's defensive underflow guard: if `anchor` were ever
    ///         past `rateEnd` (a state OkuMoney's writers never produce — see
    ///         NatSpec), the elapsed-in-window computation clamps to 0 instead
    ///         of underflowing.
    function test_ComputeMultiplier_Branch2_DefensiveAnchorPastRateEnd_DoesNotUnderflow()
        public
        view
    {
        uint256 base = 1e18;
        uint256 rate = PRECISION + 1e11;
        uint256 anchor = 2000; // PAST rateEnd — the defensive case
        uint256 rateEnd = 1000;
        uint256 nowTs = 3000;

        // Must not revert (would underflow without the `anchor < rateEnd` guard).
        uint256 result = h.computeMultiplier(base, rate, anchor, rateEnd, PRECISION, 0, nowTs);
        // elapsedInWindow clamps to 0, so the active-rate leg contributes nothing.
        assertEq(result, base);
    }

    /// @notice Branch 3 (still running): compounds the active rate from
    ///         anchor to nowTs, bounded because nowTs <= rateEnd here.
    function test_ComputeMultiplier_Branch3_StillRunning() public view {
        uint256 base = 1e18;
        uint256 rate = PRECISION + 1e11;
        uint256 anchor = 100;
        uint256 rateEnd = 1000;
        uint256 nowTs = 600; // before rateEnd

        uint256 result = h.computeMultiplier(base, rate, anchor, rateEnd, PRECISION, 0, nowTs);
        uint256 expected = h.compoundFor(base, rate, nowTs - anchor);
        assertEq(result, expected);
    }

    /// @notice computeMultiplier is continuous across nowTs == anchor (branch 3, zero elapsed).
    function test_ComputeMultiplier_Branch3_AtAnchor_IsIdentity() public view {
        uint256 base = 12_345e14;
        uint256 result = h.computeMultiplier(base, PRECISION + 1e11, 1000, 2000, PRECISION, 0, 1000);
        assertEq(result, base);
    }
}
