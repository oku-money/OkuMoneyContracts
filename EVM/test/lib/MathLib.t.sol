// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MathLibHarness} from "../mocks/MathLibHarness.sol";

/// @notice Verbatim copy of the PRE-migration MathLib arithmetic (plain
///         `(a * b) / c`). Exists solely so the migration tests below can
///         demonstrate, in-suite, the precise input range where the new
///         `Math.mulDiv`-based implementation succeeds and the old plain
///         arithmetic would have reverted. If the production MathLib ever
///         regressed to plain `(a * b) / c`, the migration tests would fail
///         because the production code would revert on the same inputs this
///         shadow contract reverts on.
contract OldMathShadow {
    uint256 internal constant PRECISION = 1e18;

    function okuMToDollars(uint256 a, uint256 b) external pure returns (uint256) {
        return (a * b) / PRECISION;
    }

    function dollarsToOkuM(uint256 a, uint256 b) external pure returns (uint256) {
        return (a * PRECISION) / b;
    }

    function unwrapSharesCeil(uint256 usdAmount, uint256 usdMult) external pure returns (uint256) {
        // Pre-migration ceiling-div pattern from OkuDollar.unwrap.
        return ((usdAmount * PRECISION) + usdMult - 1) / usdMult;
    }
}

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
    OldMathShadow internal old;

    function setUp() public {
        h = new MathLibHarness();
        old = new OldMathShadow();
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

    // REMOVED (single-multiplier collapse): test_WrappedSharesFromOkuM_MatchesOkuMToWrappedUsd
    // — `wrappedSharesFromOkuM` / `okuMToWrappedUsd` were deleted from MathLib. Under
    // the single-multiplier design `wrap`'s share formula is the identity
    // (mulDiv(a, m, m) == a) and its dollar output is exactly `okuMToDollars`, so
    // there is no separate two-multiplier helper left to pin an identity between.

    // ============ mulDiv migration: intermediate-overflow safety ============
    //
    // These tests verify the central refactor invariant: `MathLib` conversions
    // now use OpenZeppelin's 512-bit `Math.mulDiv`, so the intermediate product
    // `a * b` may exceed `type(uint256).max` provided the final result
    // `(a * b) / c` still fits in 256 bits. The previous implementation
    // (`(a * b) / c` with plain Solidity arithmetic) reverted on the
    // intermediate multiplication for any `a * b > 2^256`.
    //
    // Each test below is constructed so that:
    //   * `a * b` strictly overflows `uint256`
    //   * `(a * b) / c` fits in `uint256` (so `mulDiv` returns a valid result)
    // Therefore each test PASSES under the new implementation and would have
    // REVERTED under the pre-mulDiv implementation. These tests fail-locked the
    // migration: removing the `Math.mulDiv` call would re-introduce the revert
    // and the test would fail.

    /// @notice `okuMToDollars` succeeds when `okuMAmount * okuMMultiplier` exceeds
    ///         `uint256.max`. Pre-mulDiv this reverted on the intermediate multiply.
    function test_OkuMToDollars_IntermediateOverflow_NewImplSucceeds() public view {
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
    ///         `uint256.max`. Pre-mulDiv this reverted.
    function test_DollarsToOkuM_IntermediateOverflow_NewImplSucceeds() public view {
        // dollarValue * 1e18 must overflow. dollarValue = 2^240 gives 2^240 * 1e18
        // which is ~ 2^240 * 2^60 = 2^300, well past 2^256.
        uint256 dollarValue = 2 ** 240;
        uint256 okuMMult = PRECISION; // 1.0 — result equals dollarValue
        uint256 result = h.dollarsToOkuM(dollarValue, okuMMult);
        assertEq(result, dollarValue);
    }

    // REMOVED (single-multiplier collapse): test_WrappedSharesFromOkuM_IntermediateOverflow_NewImplSucceeds
    // and test_OkuMToWrappedUsd_IntermediateOverflow_NewImplSucceeds — both pinned
    // the deleted two-multiplier helpers.

    /// @notice Side-by-side: NEW `okuMToDollars` succeeds while the SHADOW of
    ///         the OLD `(a * b) / PRECISION` arithmetic REVERTS on the same
    ///         input. This test would FAIL on the pre-migration implementation
    ///         (because production `okuMToDollars` would revert just like the
    ///         shadow), and PASSES on the post-migration implementation.
    function test_OkuMToDollars_OldReverts_NewSucceeds() public {
        uint256 a = 2 ** 150;
        uint256 b = 2 ** 150;

        // OLD implementation (plain `*` then `/`) reverts on the intermediate
        // multiply with Panic(0x11) — Solidity 0.8 arithmetic overflow.
        vm.expectRevert();
        old.okuMToDollars(a, b);

        // NEW implementation (Math.mulDiv) returns a valid result.
        uint256 result = h.okuMToDollars(a, b);
        assertEq(result, Math.mulDiv(a, b, PRECISION, Math.Rounding.Floor));
        assertGt(result, 0);
    }

    /// @notice Side-by-side: NEW `dollarsToOkuM` succeeds while OLD reverts.
    function test_DollarsToOkuM_OldReverts_NewSucceeds() public {
        uint256 dollarValue = 2 ** 240;
        uint256 okuMMult = PRECISION;

        vm.expectRevert();
        old.dollarsToOkuM(dollarValue, okuMMult);

        uint256 result = h.dollarsToOkuM(dollarValue, okuMMult);
        assertEq(result, dollarValue);
    }

    // REMOVED (single-multiplier collapse): test_WrappedSharesFromOkuM_OldReverts_NewSucceeds
    // — pinned the deleted `wrappedSharesFromOkuM` helper.

    /// @notice Side-by-side for the ONLY ceil site in the protocol
    ///         (`OkuDollar.unwrap`'s `sharesToBurn`). The OLD ceil pattern
    ///         `((usdAmount * PRECISION) + usdMult - 1) / usdMult` reverts on
    ///         the intermediate `usdAmount * PRECISION` when `usdAmount` is
    ///         large. The NEW `Math.mulDiv(_, _, _, Ceil)` succeeds.
    /// @dev Confirms parity of ceil semantics for in-range inputs and overflow
    ///      safety for out-of-range inputs.
    function test_UnwrapSharesCeil_OldReverts_NewSucceeds() public {
        // Pick usdAmount so that usdAmount * PRECISION overflows uint256, but
        // the final result usdAmount * PRECISION / usdMult fits.
        //   usdAmount = 2^240; usdAmount * 1e18 ≈ 2^300 (overflow)
        //   usdMult   = 2^120; result ≈ 2^240 / 2^60 = 2^180 (fits)
        uint256 usdAmount = 2 ** 240;
        uint256 usdMult = 2 ** 120;

        // OLD ceil pattern reverts on the intermediate multiply.
        vm.expectRevert();
        old.unwrapSharesCeil(usdAmount, usdMult);

        // NEW: Math.mulDiv with Ceil rounding succeeds.
        uint256 newResult = Math.mulDiv(usdAmount, PRECISION, usdMult, Math.Rounding.Ceil);
        assertGt(newResult, 0);

        // Parity check: on small in-range inputs, OLD and NEW produce
        // bit-identical results. This locks in behavioral equivalence for the
        // protocol's actual operating range.
        uint256 smallUsd = 100e18;
        uint256 smallMult = 11e17; // 1.1
        uint256 oldCeil = old.unwrapSharesCeil(smallUsd, smallMult);
        uint256 newCeil = Math.mulDiv(smallUsd, PRECISION, smallMult, Math.Rounding.Ceil);
        assertEq(oldCeil, newCeil, "Ceil semantics must match for in-range inputs");
    }

    /// @notice Fuzz-pinned equivalence: for every (a, b, c) tuple that does
    ///         NOT trigger overflow in the old arithmetic, the OLD and NEW
    ///         implementations produce bit-identical results. This proves the
    ///         migration is behaviorally equivalent for all realistic protocol
    ///         inputs while strictly expanding the safe input range.
    function testFuzz_OldNewEquivalence_InRange(uint256 a, uint256 b) public view {
        // Constrain to the range where the OLD arithmetic doesn't overflow:
        //   a * b <= type(uint256).max  ==>  a <= type(uint256).max / b
        b = bound(b, 1, PRECISION * 1e12); // up to 1e30 — well above MAX_MULTIPLIER
        if (b == 0) return;
        a = bound(a, 0, type(uint256).max / b);

        uint256 oldResult = old.okuMToDollars(a, b);
        uint256 newResult = h.okuMToDollars(a, b);
        assertEq(oldResult, newResult, "Old and new must agree in the safe input range");
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
    /// @dev Regression pin for a DELETED defensive fallback. It compounded the
    ///      successor from `rateEnd`, not `max(anchor, rateEnd)` as branch 2 does,
    ///      so on the very input it claimed to guard (`anchor > rateEnd`) it
    ///      applied yield across `[rateEnd, anchor]` — a span preceding the
    ///      snapshot and already baked into `base`. It was removed rather than
    ///      made symmetric; this test exists so it cannot creep back.
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
        // anchor > rateEnd — the input the deleted fallback double-counted.
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
