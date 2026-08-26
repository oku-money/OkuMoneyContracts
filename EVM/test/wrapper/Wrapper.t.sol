// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {MathLib} from "../../src/lib/MathLib.sol";
import {USDOkuWrapper} from "../../src/wrapper/USDOkuWrapper.sol";

/**
 * @title WrapperTest
 * @notice OkuM <-> USDOku conversion, and the one rule the whole two-token
 *         design rests on.
 *
 * @dev **BOTH DIRECTIONS PRICE AT `M_oku`, NEVER `M_usd`.**
 *
 *      This is not a style preference, it is the solvency boundary. `M_usd`
 *      determines how fast a USDOku *balance* grows; it must never determine a
 *      conversion rate. If unwrap priced at `M_usd`, a USDOku holder could
 *      extract the smoothing gap directly from the OkuM backing pool at will,
 *      turning a bounded accounting gap into an unbounded drain on senior
 *      holders. `test_PricesAtMOkuNotMUsd` is the differential test that would
 *      fail against that mutation, and it is the single most important assertion
 *      in this file.
 */
contract WrapperTest is BaseTest {
    function setUp() public override {
        super.setUp();
        _seedBuffer(10_000_000e6);
    }

    function _position(address user, uint256 usdcAmount) internal returns (uint256 raw) {
        return _psmMint(user, usdcAmount);
    }

    // ============ The load-bearing rule ============

    /// @notice Unwrap output tracks `M_oku` and is INDEPENDENT of `M_usd`.
    ///
    /// @dev Constructed so the two indices are far apart and a mutant that
    ///      substituted `M_usd` would be off by orders of magnitude, not by
    ///      rounding. A test where both indices happen to be near 1.0 proves
    ///      nothing — which is why so much of this suite runs at an elevated
    ///      multiplier.
    function test_PricesAtMOkuNotMUsd() public {
        uint256 raw = _position(user1, 1000e6);

        // Push M_oku to ~1.05 and M_usd far above it.
        _stepToAtLeast(1.05e18);
        uint256 mOku = token.uiMultiplier();
        uint256 usdOkuOut = _wrap(user1, raw);

        _accrueUsd(RATE_10_PCT_APY, Constants.MAX_RATE_DURATION);
        uint256 mUsd = usdOku.usdOkuIndex();
        assertGt(mUsd, Constants.PRECISION, "M_usd has moved");
        assertTrue(mUsd != mOku, "and the two indices genuinely differ");

        // Fund the gap so the unwrap can settle in full, then unwrap the
        // ORIGINAL dollar amount and check the OkuM returned is priced at M_oku.
        _donateOkuMToWrapper(1000e18);
        uint256 okuMOut = _unwrap(user1, usdOkuOut);

        assertApproxEqAbs(
            okuMOut, MathLib.fromUiAmount(usdOkuOut, mOku), 2, "priced at M_oku, not M_usd"
        );
        assertTrue(
            okuMOut != MathLib.fromUiAmount(usdOkuOut, mUsd), "and demonstrably not at M_usd"
        );
    }

    // ============ Wrap ============

    function test_Wrap_AtUnitMultiplierIsOneToOne() public {
        uint256 raw = _position(user1, 100e6);
        uint256 out = _wrap(user1, raw);

        assertEq(out, raw, "at M_oku = 1.00, one raw OkuM is one dollar");
        assertEq(usdOku.balanceOf(user1), out);
        assertEq(token.balanceOf(address(wrapper)), raw, "backing is escrowed");
        assertEq(token.balanceOf(user1), 0);
    }

    /// @notice At an elevated `M_oku` one raw OkuM is worth more than a dollar,
    ///         so wrapping mints MORE USDOku than the raw count.
    function test_Wrap_AtElevatedMultiplierMintsMoreDollarsThanRaw() public {
        uint256 raw = _position(user1, 1000e6);
        _stepToAtLeast(1.05e18);

        uint256 out = _wrap(user1, raw);
        assertGt(out, raw);
        assertEq(out, MathLib.toUiAmount(raw, token.uiMultiplier()));
    }

    /// @notice Wrapping is value-neutral: the dollar value of what goes in
    ///         equals the dollar value of what comes out, to flooring. That is
    ///         why wrap cannot open a solvency gap.
    function test_Wrap_IsValueNeutral() public {
        uint256 raw = _position(user1, 1000e6);
        _stepToAtLeast(1.05e18);

        uint256 valueIn = token.toUIAmount(raw);
        uint256 out = _wrap(user1, raw);
        assertEq(out, valueIn);
    }

    function test_Wrap_ZeroReverts() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        wrapper.wrap(0);
    }

    function test_Wrap_BlockedWhilePaused() public {
        uint256 raw = _position(user1, 100e6);
        vm.prank(wrapperPauser);
        wrapper.pause();

        vm.startPrank(user1);
        token.approve(address(wrapper), raw);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        wrapper.wrap(raw);
        vm.stopPrank();
    }

    // ============ Unwrap ============

    function test_Unwrap_ReturnsOkuMAtMOku() public {
        uint256 raw = _position(user1, 1000e6);
        _stepToAtLeast(1.05e18);
        uint256 out = _wrap(user1, raw);

        uint256 back = _unwrap(user1, out);
        assertApproxEqAbs(back, raw, 2, "round trip returns the position, less dust");
        assertEq(usdOku.sharesOf(user1), 0, "and burns every share delivered");
    }

    /// @notice Round-trip dust is bounded and always in the protocol's favour.
    function testFuzz_RoundTripDustIsBoundedAndFavoursProtocol(
        uint256 usdcAmount,
        uint256 stepSeed
    )
        public
    {
        usdcAmount = _bound(usdcAmount, 1e6, 100_000e6);
        uint256 raw = _position(user1, usdcAmount);
        _stepBy(_bound(stepSeed, 1, Constants.MAX_STEP_BPS));

        uint256 out = _wrap(user1, raw);
        uint256 back = _unwrap(user1, out);

        assertLe(back, raw, "a round trip never creates OkuM");
        assertGe(back + 2, raw, "and loses at most dust");
    }

    /// @notice Unwrap fails only when the buffer genuinely cannot cover it. That
    ///         is the gap being realized faster than it is funded — a treasury
    ///         event, not a rounding one.
    function test_Unwrap_RevertsOnInsufficientBacking() public {
        uint256 raw = _position(user1, 1000e6);
        uint256 out = _wrap(user1, raw);

        // Let the declared index outrun realized backing, then try to take out
        // the inflated balance with no top-up.
        _accrueUsd(RATE_5_PCT_APY, Constants.MAX_RATE_DURATION);
        uint256 inflated = usdOku.balanceOf(user1);
        assertGt(inflated, out, "the balance has grown past the backing");

        vm.startPrank(user1);
        usdOku.approve(address(wrapper), inflated);
        vm.expectPartialRevert(USDOkuWrapper.InsufficientBacking.selector);
        wrapper.unwrap(inflated);
        vm.stopPrank();
    }

    /// @notice A partial unwrap still works while the gap is positive — the
    ///         wrapper is not all-or-nothing, and a holder is never blocked
    ///         merely because the pool is short in aggregate.
    function test_Unwrap_PartialSucceedsWithPositiveGap() public {
        uint256 raw = _position(user1, 1000e6);
        _wrap(user1, raw);
        _accrueUsd(RATE_5_PCT_APY, Constants.MAX_RATE_DURATION);

        assertGt(wrapper.solvencyGapBps(), 0, "there is a gap");
        uint256 got = _unwrap(user1, usdOku.balanceOf(user1) / 2);
        assertGt(got, 0);
    }

    function test_Unwrap_ZeroReverts() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        wrapper.unwrap(0);
    }

    function test_Unwrap_BlockedWhilePaused() public {
        uint256 raw = _position(user1, 100e6);
        uint256 out = _wrap(user1, raw);
        vm.prank(wrapperPauser);
        wrapper.pause();

        vm.startPrank(user1);
        usdOku.approve(address(wrapper), out);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        wrapper.unwrap(out);
        vm.stopPrank();
    }

    // ============ Quotes ============

    function test_Quotes_MatchActuals() public {
        uint256 raw = _position(user1, 1000e6);
        _stepToAtLeast(1.05e18);

        uint256 quoted = wrapper.quoteWrap(raw);
        uint256 actual = _wrap(user1, raw);
        assertEq(quoted, actual, "quoteWrap is exact");

        uint256 quotedBack = wrapper.quoteUnwrap(actual);
        uint256 actualBack = _unwrap(user1, actual);
        assertApproxEqAbs(quotedBack, actualBack, 1, "quoteUnwrap is exact to 1 wei");
    }

    // ============ Sunset ============

    /// @notice SUNSET STEP 1: `wrap` closes, `unwrap` stays open indefinitely.
    ///
    /// @dev There is deliberately NO code path that disables `unwrap`. Winding
    ///      down by draining the wrapper's backing to force insolvency
    ///      terminates the liability by making redemption fail for whoever is
    ///      last in line — a bank run with a published starting gun, and a
    ///      materially different act for a licensed issuer than a noticed
    ///      wind-down. Same outcome, no one stranded.
    function test_Sunset_WrapDisabledUnwrapStaysOpen() public {
        uint256 raw = _position(user1, 1000e6);
        uint256 out = _wrap(user1, raw);

        vm.expectEmit(false, false, false, true, address(wrapper));
        emit USDOkuWrapper.WrapEnabledSet(false);
        vm.prank(wrapperAdmin);
        wrapper.setWrapEnabled(false);

        uint256 more = _position(user2, 100e6);
        vm.startPrank(user2);
        token.approve(address(wrapper), more);
        vm.expectRevert(USDOkuWrapper.WrapDisabled.selector);
        wrapper.wrap(more);
        vm.stopPrank();

        // The exit remains open.
        uint256 back = _unwrap(user1, out);
        assertGt(back, 0, "unwrap must survive the sunset");
    }

    function test_Sunset_IsReversible() public {
        vm.prank(wrapperAdmin);
        wrapper.setWrapEnabled(false);
        assertFalse(wrapper.wrapEnabled());

        vm.prank(wrapperAdmin);
        wrapper.setWrapEnabled(true);
        assertTrue(wrapper.wrapEnabled());

        uint256 raw = _position(user1, 100e6);
        assertGt(_wrap(user1, raw), 0);
    }

    function test_Sunset_RequiresWrapperAdmin() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        wrapper.setWrapEnabled(false);
    }

    // ============ Events ============

    function test_Events_WrappedAndUnwrapped() public {
        uint256 raw = _position(user1, 100e6);
        uint256 m = token.uiMultiplier();

        vm.startPrank(user1);
        token.approve(address(wrapper), raw);
        vm.expectEmit(true, false, false, true, address(wrapper));
        emit USDOkuWrapper.Wrapped(user1, raw, raw, m);
        uint256 out = wrapper.wrap(raw);

        usdOku.approve(address(wrapper), out);
        vm.expectEmit(true, false, false, true, address(wrapper));
        emit USDOkuWrapper.Unwrapped(user1, out, raw, m);
        wrapper.unwrap(out);
        vm.stopPrank();
    }

    /// @notice `SolvencyGapUpdated` fires on every conversion. This is the
    ///         series monitoring alarms on, so it must be emitted from both
    ///         paths — a gap that only surfaces on wrap would go unobserved
    ///         through exactly the period when holders are exiting.
    function test_Events_SolvencyGapUpdatedOnBothPaths() public {
        uint256 raw = _position(user1, 100e6);

        vm.startPrank(user1);
        token.approve(address(wrapper), raw);
        vm.expectEmit(false, false, false, false, address(wrapper));
        emit USDOkuWrapper.SolvencyGapUpdated(0, 0, 0);
        uint256 out = wrapper.wrap(raw);

        usdOku.approve(address(wrapper), out);
        vm.expectEmit(false, false, false, false, address(wrapper));
        emit USDOkuWrapper.SolvencyGapUpdated(0, 0, 0);
        wrapper.unwrap(out);
        vm.stopPrank();
    }

    // ============ Pause admin ============

    function test_Pause_RoleSplitIsOneWayForWarmKey() public {
        vm.prank(wrapperPauser);
        wrapper.pause();
        vm.prank(wrapperPauser);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        wrapper.unpause();

        vm.prank(wrapperUnpauser);
        wrapper.unpause();
        assertFalse(wrapper.paused());
    }

    // ============ Helpers ============

    /// @dev Fund the wrapper's OkuM buffer. This is the on-chain shape of an
    ///      issuer top-up: the gap is funded by donating backing, not by
    ///      diluting OkuM holders.
    function _donateOkuMToWrapper(uint256 amount) internal {
        _mintRaw(treasury, amount);
        vm.prank(treasury);
        token.transfer(address(wrapper), amount);
    }
}
