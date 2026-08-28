// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {MathLib} from "../src/lib/MathLib.sol";
import {Constants} from "../src/lib/Constants.sol";
import {UsdIndexPricedWrapperMutant} from "./mocks/Mutants.sol";

/**
 * @title DifferentialTest
 * @notice Proves the two load-bearing pricing rules by showing a mutant that
 *         breaks them produces a DIFFERENT answer.
 *
 * Every test here first asserts the fixture is non-degenerate — that the two
 * indices actually differ, and that a mark actually landed between request and
 * fulfilment. Without those guards the mutant would agree with the real
 * contract and the test would pass vacuously, which is the failure mode these
 * tests exist to rule out.
 */
contract DifferentialTest is BaseTest {
    UsdIndexPricedWrapperMutant internal mutant;

    function setUp() public override {
        super.setUp();
        mutant = new UsdIndexPricedWrapperMutant();
    }

    // =====================================================================
    // Rule 1: pricing happens at FULFILMENT, never at the request block.
    // =====================================================================

    function test_differential_subscriptionNotPricedAtRequestBlock() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        uint256 multiplierAtRequest = okuM.uiMultiplier();

        // What a request-priced implementation would have delivered.
        uint256 mutantOut = MathLib.fromUIAmount(
            MathLib.usdcToDollars(1000 * USDC_UNIT, DECIMAL_MULTIPLIER), multiplierAtRequest
        );

        // A mark MUST land in between, or the two prices coincide and this
        // test proves nothing.
        _stepOkuMultiplier(100);
        uint256 multiplierAtFulfilment = okuM.uiMultiplier();
        assertGt(multiplierAtFulfilment, multiplierAtRequest, "fixture must not be degenerate");

        vm.prank(fulfiller);
        module.fulfillSubscription(requestId);
        uint256 actualOut = okuM.balanceOf(alice);

        assertTrue(actualOut != mutantOut, "MUTANT AGREES - request-block pricing not ruled out");
        assertLt(actualOut, mutantOut, "fulfilment pricing must yield fewer, more valuable shares");
        assertEq(
            actualOut,
            MathLib.fromUIAmount(
                MathLib.usdcToDollars(1000 * USDC_UNIT, DECIMAL_MULTIPLIER), multiplierAtFulfilment
            ),
            "priced at the fulfilling block"
        );
    }

    /// @dev The concrete exploit the rule prevents: submit, watch, and settle at
    ///      a stale favourable price. Under request-pricing the user captures the
    ///      whole step for free; under fulfilment-pricing they capture nothing.
    function test_differential_freeOptionIsClosed() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        uint256 mAtRequest = okuM.uiMultiplier();
        _stepOkuMultiplier(100);

        vm.prank(fulfiller);
        module.fulfillSubscription(requestId);

        // Dollar value received, versus dollars paid in.
        uint256 valueOut = okuM.balanceOfUI(alice);
        uint256 valueIn = MathLib.usdcToDollars(1000 * USDC_UNIT, DECIMAL_MULTIPLIER);
        assertApproxEqAbs(valueOut, valueIn, 1e13, "no free value from waiting");

        // Under the mutant the user would have received strictly more value.
        uint256 mutantShares = MathLib.fromUIAmount(valueIn, mAtRequest);
        uint256 mutantValue = MathLib.toUIAmount(mutantShares, okuM.uiMultiplier());
        assertGt(mutantValue, valueOut, "request-pricing would have paid a free option");
    }

    // =====================================================================
    // Rule 2: the wrapper prices at M_oku, never at M_usd.
    // =====================================================================

    function test_differential_unwrapNotPricedAtUsdIndex() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        _prefundWrapper(20 * USDC_UNIT);
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(1000), block.timestamp + 30 days);
        vm.warp(block.timestamp + 30 days);

        uint256 mOku = okuM.uiMultiplier();
        uint256 mUsd = usdOku.usdOkuIndex();
        // Non-degenerate fixture: the indices must have actually diverged.
        assertGt(mUsd, mOku, "fixture must not be degenerate");

        uint256 exit = 500e18;
        uint256 mutantOut = mutant.mutantUnwrapAtUsdIndex(exit, mUsd);

        vm.prank(alice);
        uint256 actualOut = wrapper.unwrap(exit, alice);

        assertTrue(actualOut != mutantOut, "MUTANT AGREES - M_usd pricing not ruled out");
        assertEq(actualOut, MathLib.fromUIAmount(exit, mOku), "priced at M_oku");
        assertGt(actualOut, mutantOut, "M_usd pricing would under-pay the exiting holder here");
    }

    /// @dev The direction that actually drains: if `unwrap` priced at `M_usd`
    ///      while `M_usd < M_oku`, holders would extract more OkuM than their
    ///      dollars are worth, straight out of senior holders' backing.
    function test_differential_usdIndexPricingWouldDrainBacking() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        // Realized outruns declared: M_oku steps, M_usd stays put.
        _stepOkuMultiplier(100);

        uint256 mOku = okuM.uiMultiplier();
        uint256 mUsd = usdOku.usdOkuIndex();
        assertGt(mOku, mUsd, "fixture must not be degenerate");

        uint256 exit = 500e18;
        uint256 correct = MathLib.fromUIAmount(exit, mOku);
        uint256 mutantOut = mutant.mutantUnwrapAtUsdIndex(exit, mUsd);

        assertGt(mutantOut, correct, "M_usd pricing over-pays - this is the drain");

        vm.prank(alice);
        uint256 actualOut = wrapper.unwrap(exit, alice);
        assertEq(actualOut, correct, "real wrapper pays the correct, smaller amount");

        // And the invariant survives, which it would not under the mutant.
        assertTrue(wrapper.backingCoversLiability(), "backing intact");
    }

    function test_differential_wrapNotPricedAtUsdIndex() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        _stepOkuMultiplier(100);

        uint256 mOku = okuM.uiMultiplier();
        uint256 mUsd = usdOku.usdOkuIndex();
        assertGt(mOku, mUsd, "fixture must not be degenerate");

        uint256 mutantCredit = mutant.mutantWrapAtUsdIndex(raw, mUsd);

        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        uint256 actualCredit = wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        assertTrue(actualCredit != mutantCredit, "MUTANT AGREES - M_usd pricing not ruled out");
        assertEq(actualCredit, MathLib.toUIAmount(raw, mOku), "credited at M_oku");
    }
}
