// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";

import {Constants} from "../../src/lib/Constants.sol";
import {MathLibHarness} from "../mocks/MathLibHarness.sol";

/**
 * @title MulDivBoundsTest
 * @notice Establishes what `Math.mulDiv` actually buys us, and corrects a claim
 *         that was wrong in an earlier draft of this refactor.
 *
 * @dev ============ THE CORRECTED CLAIM ============
 *
 *      An earlier draft asserted that the ERC-8056 reference implementation's
 *      naive `(raw * multiplier) / 1e18` "reverts on intermediate overflow for
 *      large balances at high multipliers — reachable inside the parameter space
 *      our own constants permit."
 *
 *      **That is false, and the constants prove it.** `MAX_TOTAL_SUPPLY *
 *      MAX_MULTIPLIER == 1e57`, roughly 1e20x below `type(uint256).max`
 *      (~1.158e77). Any balance of this token, at any legal multiplier, is safe
 *      under a naive multiply. The supply bound *is* the overflow proof.
 *
 *      A test written against the false claim could never have passed, because
 *      nothing would have reverted.
 *
 *      What `mulDiv` genuinely buys, asserted below:
 *
 *        1. EXPLICIT ROUNDING. The rounding policy cannot be expressed as `*` and
 *           `/` in one reviewable place. (Covered by the round-trip suites.)
 *        2. ARBITRARY-INPUT PUBLIC VIEWS. `toUIAmount`/`fromUIAmount` accept any
 *           `uint256`; no supply bound constrains them.
 *        3. HOSTILE COUNTERPARTIES. `MathLib` is shared with
 *           `OkuMultiplierAdapter`, which may read a third-party ERC-8056 token
 *           whose multiplier is unbounded.
 *
 *      And the honest limit: `mulDiv` extends the safe input domain by exactly
 *      `PRECISION` (1e18x) relative to naive. It does NOT make it unbounded.
 */
contract MulDivBoundsTest is Test {
    MathLibHarness internal math;

    function setUp() public {
        math = new MathLibHarness();
    }

    // ============ The supply bound is the overflow proof ============

    function test_SupplyBound_KeepsEvenNaiveMultiplySafe() public pure {
        // 1e33 * 1e24 = 1e57, vs ~1.158e77.
        uint256 product = Constants.MAX_TOTAL_SUPPLY * Constants.MAX_MULTIPLIER;
        assertEq(product, 1e57);
        assertLt(product, type(uint256).max);
        // ~1e20x of headroom.
        assertGt(type(uint256).max / product, 1e19);
    }

    /// @notice At the absolute corner of the legal envelope, naive and `mulDiv`
    ///         agree exactly — so `mulDiv` is not papering over a real overflow.
    function test_AtMaxSupplyAndMaxMultiplier_NaiveAndMulDivAgree() public view {
        uint256 raw = Constants.MAX_TOTAL_SUPPLY;
        uint256 m = Constants.MAX_MULTIPLIER;
        assertEq(math.toUiAmount(raw, m), math.naiveToUiAmount(raw, m));
    }

    function testFuzz_InsideEnvelope_NaiveAndMulDivAgree(uint256 raw, uint256 m) public view {
        raw = bound(raw, 0, Constants.MAX_TOTAL_SUPPLY);
        m = bound(m, 1, Constants.MAX_MULTIPLIER);
        assertEq(math.toUiAmount(raw, m), math.naiveToUiAmount(raw, m));
    }

    // ============ Outside the envelope: mulDiv survives where naive dies ============

    /// @notice The genuine justification. A hostile third-party ERC-8056 token can
    ///         report any multiplier; `mulDiv` keeps the shared conversion usable
    ///         for inputs where the naive form reverts.
    function test_OutsideEnvelope_MulDivSurvivesWhereNaiveReverts() public {
        // Chosen so `raw * m` overflows but `raw * m / 1e18` does not.
        uint256 raw = type(uint256).max / 1e12;
        uint256 m = 1e18;

        vm.expectRevert();
        math.naiveToUiAmount(raw, m);

        // Same inputs, no revert.
        assertEq(math.toUiAmount(raw, m), raw);
    }

    /// @notice `mulDiv` extends the domain by exactly `PRECISION`, no more.
    ///         Overclaiming "no overflow possible" would be wrong in both forms.
    function test_MulDivDomainIsExtendedByPrecision_ButStillBounded() public {
        uint256 m = Constants.MAX_MULTIPLIER;

        // Just inside the mulDiv domain: result must fit in uint256.
        uint256 safe = type(uint256).max / (m / Constants.PRECISION) - 1;
        math.toUiAmount(safe, m); // no revert

        // The absolute maximum input at the maximum multiplier still reverts.
        vm.expectRevert();
        math.toUiAmount(type(uint256).max, m);
    }

    function test_ToUiAmountAtUnitMultiplier_IsIdentityEvenAtUintMax() public view {
        assertEq(math.toUiAmount(type(uint256).max, Constants.PRECISION), type(uint256).max);
    }

    // ============ rpow branch coverage ============

    function test_Rpow_ZeroBaseZeroExponent_ReturnsBase() public view {
        assertEq(math.rpow(0, 0, Constants.PRECISION), Constants.PRECISION);
    }

    function test_Rpow_ZeroBaseNonZeroExponent_ReturnsZero() public view {
        assertEq(math.rpow(0, 5, Constants.PRECISION), 0);
    }

    function test_Rpow_ExponentZero_ReturnsBase() public view {
        assertEq(math.rpow(2e18, 0, Constants.PRECISION), Constants.PRECISION);
    }

    function test_Rpow_ExponentOne_ReturnsX() public view {
        assertEq(math.rpow(2e18, 1, Constants.PRECISION), 2e18);
    }

    function test_Rpow_Squaring() public view {
        assertEq(math.rpow(2e18, 2, Constants.PRECISION), 4e18);
        assertEq(math.rpow(2e18, 3, Constants.PRECISION), 8e18);
    }

    /// @notice MakerDAO's assembly overflow guard on the squaring path.
    function test_Rpow_OverflowReverts() public {
        vm.expectRevert();
        math.rpow(type(uint256).max, 2, Constants.PRECISION);
    }

    // ============ Decimal conversion ============

    function test_UsdcRoundTrip_IsLossyByGranularity() public view {
        uint256 dm = 1e12;
        // 1 USDC unit survives.
        assertEq(math.dollarsToUsdc(math.usdcToDollars(1, dm), dm), 1);
        // Sub-unit dollar dust does not.
        assertEq(math.dollarsToUsdc(dm - 1, dm), 0);
    }
}
