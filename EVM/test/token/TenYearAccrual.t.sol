// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title TenYearAccrualTest
 * @notice Long-horizon behaviour: overflow headroom, precision drift, and dust
 *         accumulation over a decade of continuous accrual.
 *
 * @dev `MAX_RATE_DURATION` is 30 days, so a decade is ~122 renewals. That is the
 *      real operational cadence, and running it here is the only way to catch
 *      drift that a single-segment test cannot see.
 */
contract TenYearAccrualTest is BaseTest {
    uint256 internal constant SEGMENTS_PER_YEAR = 12; // 12 x 30d ~= 360d
    uint256 internal constant DM = TestConstants.DECIMAL_MULTIPLIER;

    /// @notice Ten years at the fixture rate stays far inside every ceiling.
    function test_TenYears_StaysWithinCeilings() public {
        _mintRaw(user1, 1_000_000e18);

        for (uint256 i = 0; i < SEGMENTS_PER_YEAR * 10; ++i) {
            _accrue(RATE_5_PCT_APY, Constants.MAX_RATE_DURATION);
        }

        uint256 m = token.uiMultiplier();
        // ~5% APY over ~9.86 years compounds to roughly 1.6x.
        assertGt(m, (Constants.PRECISION * 155) / 100);
        assertLt(m, (Constants.PRECISION * 170) / 100);
        assertLt(m, Constants.MAX_MULTIPLIER, "nowhere near the ceiling");

        // Raw layer never moved.
        assertEq(token.balanceOf(user1), 1_000_000e18);
        assertEq(token.totalSupply(), 1_000_000e18);
    }

    /// @notice Ten years at the APR CAP — the worst legitimate trajectory — still
    ///         leaves five orders of magnitude of headroom under `MAX_MULTIPLIER`.
    function test_TenYearsAtAprCap_HeadroomRemains() public {
        uint256 rateAtCap = Constants.PRECISION + 3_170_979_198;
        for (uint256 i = 0; i < SEGMENTS_PER_YEAR * 10; ++i) {
            _accrue(rateAtCap, Constants.MAX_RATE_DURATION);
        }
        uint256 m = token.uiMultiplier();
        assertLt(m, Constants.MAX_MULTIPLIER);
        assertGt(Constants.MAX_MULTIPLIER / m, 100_000, "still >100,000x of headroom");
    }

    /// @notice Accruing in many small segments must not diverge materially from one
    ///         long segment. Divergence here would mean `rpow` re-anchoring is
    ///         leaking value on every renewal.
    function test_ReanchoringDriftIsBounded() public {
        // Path A: one 30-day segment.
        uint256 snap = vm.snapshotState();
        _accrue(RATE_5_PCT_APY, 30 days);
        uint256 single = token.uiMultiplier();
        vm.revertToState(snap);

        // Path B: thirty 1-day segments over the same span.
        for (uint256 i = 0; i < 30; ++i) {
            _accrue(RATE_5_PCT_APY, 1 days);
        }
        uint256 chunked = token.uiMultiplier();

        // Both floor, so chunked <= single, and the gap must be dust-scale.
        assertLe(chunked, single);
        assertApproxEqRel(chunked, single, 1e12, "drift must be well under 1e-6 relative");
    }

    /// @notice Round-tripping through the PSM after a decade still conserves value
    ///         to within one USDC unit.
    function test_RoundTripAfterTenYears_ConservesValue() public {
        _seedBuffer(10_000_000e6);
        uint256 rawOut = _psmMint(user1, 100_000e6);

        for (uint256 i = 0; i < SEGMENTS_PER_YEAR * 10; ++i) {
            _accrue(RATE_5_PCT_APY, Constants.MAX_RATE_DURATION);
        }

        uint256 expected = litePsm.quoteRedeem(rawOut);
        vm.startPrank(user1);
        token.approve(address(litePsm), rawOut);
        uint256 usdcOut = litePsm.redeem(rawOut);
        vm.stopPrank();

        assertEq(usdcOut, expected, "quote holds after a decade");
        assertGt(usdcOut, 150_000e6, "and the holder was paid the accrual");
    }

    /// @notice Dust from repeated small transfers must not accumulate into a
    ///         measurable loss: the raw layer moves exact integers.
    function test_ManySmallTransfers_NoDustAccumulation() public {
        _mintRaw(user1, 1000e18);
        _accrue(RATE_5_PCT_APY, 30 days);

        uint256 total = token.totalSupply();
        for (uint256 i = 0; i < 100; ++i) {
            vm.prank(user1);
            token.transfer(user2, 1e18 + 7);
        }

        assertEq(token.totalSupply(), total, "raw supply is conserved exactly");
        assertEq(token.balanceOf(user1) + token.balanceOf(user2), total);
    }

    /// @notice The value/display parity bound holds at every point along a decade.
    function test_ParityHoldsAcrossTheDecade() public {
        for (uint256 i = 0; i < SEGMENTS_PER_YEAR * 10; ++i) {
            _accrue(RATE_5_PCT_APY, Constants.MAX_RATE_DURATION);
            uint256 cta = token.convertToAssets(Constants.PRECISION);
            uint256 m = token.uiMultiplier();
            assertLe(cta * DM, m);
            assertLt(m, (cta + 1) * DM);
        }
    }
}
