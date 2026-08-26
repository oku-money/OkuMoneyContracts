// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title ValueDisplayParityTest
 * @notice Ties the ERC-8056 display layer to the ERC-4626 value layer.
 *
 * @dev THE PARITY RELATION IS A BOUND, NOT AN EQUALITY, and the bound is the
 *      point. `asset()` is USDC at 6 dp and `convertToAssets` must return
 *      asset-decimals to be ERC-4626-semantically correct, while
 *      `uiMultiplier()` is 18 dp. They differ by `usdcDecimalMultiplier` and a
 *      floor:
 *
 *        convertToAssets(1e18) * usdcDecimalMultiplier
 *            <= uiMultiplier()
 *            <  (convertToAssets(1e18) + 1) * usdcDecimalMultiplier
 *
 *      An earlier draft of this plan stated the bare equality
 *      `uiMultiplier() == convertToAssets(1e18)`. That is dimensionally
 *      impossible and would have bitten whoever wrote this file.
 *
 *      Corollary: the value layer's resolution is ONE USDC UNIT (1e12 in 18-dp
 *      terms) while the display layer's is one wei. `convertToAssets` and
 *      `convertToShares` are therefore not inverses.
 *
 *      The multiplier is now stepwise, so all fixtures drive it with `_step`
 *      rather than rates.
 */
contract ValueDisplayParityTest is BaseTest {
    uint256 internal constant DM = TestConstants.DECIMAL_MULTIPLIER; // 1e12

    // ============ The parity bound ============

    function _assertParity() internal view {
        uint256 cta = token.convertToAssets(Constants.PRECISION);
        uint256 m = token.uiMultiplier();
        assertLe(cta * DM, m, "convertToAssets floor is below the multiplier");
        assertLt(m, (cta + 1) * DM, "and within one USDC unit of it");
    }

    function test_Parity_AtUnitMultiplier() public view {
        assertEq(token.convertToAssets(Constants.PRECISION), 1e6);
        _assertParity();
    }

    function test_Parity_AcrossStepTrajectory() public {
        // Deliberately non-round targets, so the floor in `convertToAssets` is
        // genuinely exercised rather than landing on 1e12 boundaries.
        uint256[6] memory targets = [
            uint256(1_000_000_000_000_000_001),
            1_000_099_999_999_999_999,
            1_003_333_333_333_333_337,
            1_009_999_999_876_543_210,
            1_017_171_717_171_717_171,
            1_027_182_818_284_590_452
        ];
        for (uint256 i = 0; i < targets.length; ++i) {
            _step(targets[i]);
            _assertParity();
        }
    }

    function test_Parity_AtHighMultiplier() public {
        _stepToAtLeast(5 * Constants.PRECISION);
        _assertParity();
    }

    function testFuzz_Parity(uint256 bps, uint256 wobble) public {
        // A random step size with a random sub-bp wobble on top, so the fuzz
        // explores non-round multipliers rather than exact bp multiples.
        bps = _bound(bps, 1, Constants.MAX_STEP_BPS);
        uint256 current = token.uiMultiplier();
        uint256 stepSpan = (current * bps) / Constants.BASIS_POINTS;
        wobble = _bound(wobble, 1, stepSpan);
        _step(current + wobble);
        _assertParity();
    }

    // ============ Conversion directions ============

    function test_ConvertToShares_InverseWithinUsdcGranularity() public {
        _step(1_027_400_000_123_456_789);
        uint256 back = token.convertToShares(token.convertToAssets(Constants.PRECISION));
        assertLe(back, Constants.PRECISION, "round trip must not manufacture value");
        // Bounded by the value layer's granularity, not by 1 wei.
        assertGe(back + DM, Constants.PRECISION, "loss bounded by one USDC unit");
    }

    /// @notice Explicitly documents that the two conversions are NOT inverses.
    function test_Conversions_AreNotInverses() public {
        // A multiplier with 18-dp detail that cannot survive a 6-dp round trip.
        _step(1_012_345_678_901_234_567);
        uint256 m = token.uiMultiplier();
        assertTrue(m % DM != 0, "fixture must be non-round in USDC granularity");

        uint256 back = token.convertToShares(token.convertToAssets(Constants.PRECISION));
        assertLt(back, Constants.PRECISION, "strict loss expected at a non-round multiplier");
    }

    function test_TotalAssets_TracksSupplyAndMultiplier() public {
        _mintRaw(user1, 1000e18);
        assertEq(token.totalAssets(), 1000e6);

        _stepBy(40);
        assertGt(token.totalAssets(), 1000e6);
        assertEq(token.totalAssets(), token.convertToAssets(token.totalSupply()));
    }

    function test_Asset_IsUsdcAndMatchesDecimalMultiplier() public view {
        assertEq(token.asset(), address(usdc));
        assertEq(token.usdcDecimalMultiplier(), DM);
    }

    // ============ Single source of truth ============

    /// @notice The module and queue must agree with the token, not derive their
    ///         own. A misconfigured deployment would otherwise price divergently.
    function test_DecimalMultiplier_AgreesAcrossAllThreeContracts() public view {
        assertEq(token.usdcDecimalMultiplier(), module.usdcDecimalMultiplier());
        assertEq(token.usdcDecimalMultiplier(), queue.usdcDecimalMultiplier());
        assertEq(token.asset(), address(module.usdc()));
        assertEq(token.asset(), address(queue.usdc()));
    }

    // ============ Module pricing agrees with the value layer ============

    /// @dev `quoteMint`/`quoteRedeem` are fee-INCLUSIVE while `convertToShares`/
    ///      `convertToAssets` are the fee-free ERC-4626 value views. The identity
    ///      between them therefore runs through the fee, not around it.
    ///
    ///      This test previously asserted raw equality and used `_resetFees()` to
    ///      reach a zero-fee state first. Zero fees are no longer reachable —
    ///      the per-leg step-coverage floor is permanent — so the relationship is
    ///      now stated explicitly, which is strictly more informative: it pins
    ///      WHERE the fee enters the pipeline (on the USDC leg, before
    ///      conversion) rather than only that the two agree when it is absent.
    function test_ModuleQuoteAgreesWithConvertToShares() public {
        _step(1_027_400_000_000_000_001);
        _minFees();
        uint256 usdcIn = 1234e6;
        assertEq(module.quoteMint(usdcIn), token.convertToShares(_afterTin(usdcIn)));
    }

    function test_ModuleQuoteRedeemAgreesWithConvertToAssets() public {
        _step(1_027_400_000_000_000_001);
        _minFees();
        uint256 rawIn = 987e18;
        assertEq(module.quoteRedeem(rawIn), _afterTout(token.convertToAssets(rawIn)));
    }
}
