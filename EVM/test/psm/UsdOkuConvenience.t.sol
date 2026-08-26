// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {SubscriptionModule} from "../../src/psm/SubscriptionModule.sol";
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title UsdOkuConvenienceTest
 * @notice `SubscriptionModule.mintUsdOku` / `redeemUsdOku` — USDC <-> USDOku in
 *         one transaction.
 *
 * @dev WHY THIS EXISTS. USDOku is the instrument for wallets that cannot yet
 *      render ERC-8056; without this, acquiring it is `mint` -> `approve` ->
 *      `wrap` (three transactions) and exiting is the four-transaction reverse.
 *      Making the fallback instrument the hardest one to use would defeat the
 *      whole reason it exists. `mintUsdOku`/`redeemUsdOku` chain the module's
 *      USDC leg through `USDOkuWrapper` directly, with the intermediate OkuM
 *      never touching the caller's balance.
 *
 *      THE ROUNDING HAZARD THIS SUITE EXISTS TO PIN. `redeemUsdOku` pulls a
 *      caller-specified dollar amount of USDOku, which floors to shares
 *      independently of what the wrapper's own unwrap does with whatever
 *      figure it is handed next. The module measures the SHARE DELTA of its
 *      own pull and re-derives the dollar figure it hands the wrapper from
 *      that, rather than passing the caller's nominal amount straight through
 *      — see `SubscriptionModule.redeemUsdOku` NatSpec for the proof this can
 *      never ask the wrapper to pull more than the module holds.
 */
contract UsdOkuConvenienceTest is BaseTest {
    function setUp() public override {
        super.setUp();
        _seedBuffer(10_000_000e6);
    }

    // ============ Fail-closed wiring ============

    /// @notice Fail-closed default: a fully-initialized module with
    ///         `setUsdOkuWrapper` never called rejects `mintUsdOku` /
    ///         `redeemUsdOku` with `UsdOkuWrapperNotSet`, before ever touching
    ///         the wrapper. A real, properly-wired `okuM`/`usdc`/`queue` set is
    ///         used deliberately — the point under test is the ONE missing
    ///         wire, not a broken deployment in general.
    function test_RevertsBeforeWrapperIsWired() public {
        SubscriptionModule freshModule = SubscriptionModule(
            address(
                new ERC1967Proxy(
                    address(new SubscriptionModule()),
                    abi.encodeCall(
                        SubscriptionModule.initialize,
                        (address(token), address(usdc), address(queue), admin)
                    )
                )
            )
        );

        vm.expectRevert(SubscriptionModule.UsdOkuWrapperNotSet.selector);
        freshModule.mintUsdOku(1);

        vm.expectRevert(SubscriptionModule.UsdOkuWrapperNotSet.selector);
        freshModule.redeemUsdOku(1);
    }

    // ============ mintUsdOku ============

    /// @notice One-to-one NET OF `tin`. Fees ship at the step-coverage floor
    ///         rather than at zero, so the identity is on the credited amount.
    function test_MintUsdOku_AtUnitMultiplierIsOneToOneNetOfTin() public {
        uint256 expected = _afterTin(100e6) * TestConstants.DECIMAL_MULTIPLIER;
        uint256 usdOkuOut = _mintUsdOku(user1, 100e6);
        assertEq(usdOkuOut, expected);
        assertEq(usdOku.balanceOf(user1), expected);
        assertEq(token.balanceOf(user1), 0, "no intermediate OkuM ever touches the caller");
        assertEq(token.balanceOf(address(module)), 0, "and none is left stuck in the module");
    }

    function test_MintUsdOku_AtElevatedMultiplier() public {
        _stepToAtLeast((Constants.PRECISION * 105) / 100);
        _minFees();

        uint256 usdcIn = 1000e6;
        uint256 usdOkuOut = _mintUsdOku(user1, usdcIn);
        // Value-neutral at the WRAP leg specifically: dollars out track the
        // post-`tin` dollars in, to USDC granularity. The wrap itself takes no
        // fee, which is the property under test; the module leg's `tin` is
        // accounted for rather than assumed away.
        assertApproxEqAbs(usdOkuOut, _afterTin(usdcIn) * TestConstants.DECIMAL_MULTIPLIER, 1e12);
    }

    function test_MintUsdOku_MatchesTwoStepPathWithinDust() public {
        _stepToAtLeast((Constants.PRECISION * 110) / 100);
        _minFees();

        uint256 viaConvenience = _mintUsdOku(user1, 500e6);

        uint256 raw = _psmMint(user2, 500e6);
        uint256 viaTwoStep = _wrap(user2, raw);

        assertApproxEqAbs(viaConvenience, viaTwoStep, 2);
    }

    function test_MintUsdOku_ZeroReverts() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        module.mintUsdOku(0);
    }

    function test_MintUsdOku_BlockedWhilePaused() public {
        vm.prank(psmPauser);
        module.pause();
        usdc.mint(user1, 100e6);
        vm.startPrank(user1);
        usdc.approve(address(module), 100e6);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        module.mintUsdOku(100e6);
        vm.stopPrank();
    }

    /// @notice NOT blocked immediately after a mark.
    /// @dev The one-transaction USDC->USDOku path must stay live at all times.
    ///      It was briefly gated by the sync window; that window is gone on EVM
    ///      entirely, and this is the regression guard against any time-based
    ///      gate reappearing on a user-facing path. The only thing time-gated in
    ///      this system now is the operator's mark.
    function test_MintUsdOku_NotBlockedImmediatelyAfterAMark() public {
        uint256 current = token.uiMultiplier();
        _stepNoWarp(current + current / Constants.BASIS_POINTS);

        usdc.mint(user1, 100e6);
        vm.startPrank(user1);
        usdc.approve(address(module), 100e6);
        uint256 out = module.mintUsdOku(100e6);
        vm.stopPrank();
        assertGt(out, 0);
    }

    function test_MintUsdOku_EmitsBothEvents() public {
        usdc.mint(user1, 100e6);
        vm.startPrank(user1);
        usdc.approve(address(module), 100e6);
        uint256 credited = _afterTin(100e6) * TestConstants.DECIMAL_MULTIPLIER;
        vm.expectEmit(true, false, false, true, address(module));
        emit SubscriptionModule.Minted(user1, 100e6, credited, Constants.PRECISION);
        vm.expectEmit(true, false, false, true, address(module));
        emit SubscriptionModule.UsdOkuMinted(user1, 100e6, credited, Constants.PRECISION);
        module.mintUsdOku(100e6);
        vm.stopPrank();
    }

    // ============ redeemUsdOku ============

    function test_RedeemUsdOku_AtUnitMultiplierIsOneToOne() public {
        uint256 usdOkuOut = _mintUsdOku(user1, 100e6);
        uint256 usdcOut = _redeemUsdOku(user1, usdOkuOut);
        assertApproxEqAbs(usdcOut, _afterBothFees(100e6), 1);
        assertEq(usdOku.balanceOf(user1), 0);
        assertEq(usdOku.sharesOf(address(module)), 0, "no dust stranded in the module");
    }

    function test_RedeemUsdOku_AtElevatedMultiplierAndIndex() public {
        uint256 usdOkuOut = _mintUsdOku(user1, 1000e6);

        // Elevate BOTH indices — this is where a mispriced round trip would
        // show up: OkuM realized marks moving one way, USDOku's declared index
        // moving another.
        _accrueUsd(RATE_5_PCT_APY, 10 days);
        // Realized marks must keep up with the declared index or the unwrap has
        // nothing to draw on (`InsufficientBacking`). At `MAX_STEP_BPS` = 5 a
        // single mark no longer covers 10 days of 5% APY (~13.7 bps), so walk
        // the realized index up to the declared one — which is what the
        // orchestrator does in production, and the minimum-cadence property
        // this bound exists to enforce.
        _stepToAtLeast(usdOku.usdOkuIndex());
        _minFees();

        uint256 grown = usdOku.balanceOf(user1);
        assertGt(grown, usdOkuOut, "declared index inflated the balance");

        uint256 usdcOut = _redeemUsdOku(user1, grown);
        assertGt(usdcOut, 0);
        // At most one wei of rebase dust may survive a full-balance redeem —
        // the exact hazard this suite exists for. Bounded, not assumed away.
        assertLe(usdOku.balanceOf(user1), 1, "at most a wei of dust remains");
    }

    /// @notice Redeeming the caller's FULL displayed balance must succeed and
    ///         leave no more than a wei of dust anywhere — this is the exact
    ///         shape of the rounding hazard the NatSpec describes.
    /// @dev Backing is funded generously before accruing `M_usd`, so the only
    ///      failure mode this fuzz run can hit is a rounding bug — an
    ///      `InsufficientBacking` revert from a genuinely under-funded gap is a
    ///      different property, already covered deterministically by
    ///      `WrapperTest.test_Unwrap_RevertsOnInsufficientBacking`, and would
    ///      otherwise make this fuzz test flaky against the wrong cause.
    function testFuzz_RedeemUsdOku_FullBalance_NeverReverts(
        uint256 usdcSeed,
        uint256 elapsedSeed
    )
        public
    {
        uint256 usdcIn = _bound(usdcSeed, 1e6, 1_000_000e6);
        _mintUsdOku(user1, usdcIn);
        _fundWrapperBacking(usdcIn * 1e12); // ample headroom in raw OkuM terms

        uint256 elapsed = _bound(elapsedSeed, 0, Constants.MAX_RATE_DURATION);
        if (elapsed > 0) _accrueUsd(RATE_5_PCT_APY, elapsed);

        uint256 full = usdOku.balanceOf(user1);
        if (full == 0) return;
        _redeemUsdOku(user1, full);

        assertLe(usdOku.sharesOf(user1), 1);
        assertLe(usdOku.sharesOf(address(module)), 1, "at most 1 wei of module-side dust");
    }

    function test_RedeemUsdOku_MatchesTwoStepPathWithinDust() public {
        uint256 out1 = _mintUsdOku(user1, 500e6);
        uint256 out2 = _mintUsdOku(user2, 500e6);
        _stepToAtLeast((Constants.PRECISION * 110) / 100);
        _minFees();

        uint256 viaConvenience = _redeemUsdOku(user1, out1);
        uint256 viaTwoStep = _unwrap(user2, out2);
        viaTwoStep = _redeem_directOkuM(user2, viaTwoStep);

        assertApproxEqAbs(viaConvenience, viaTwoStep, 2);
    }

    function test_RedeemUsdOku_FallsBackToQueueWhenBufferShort() public {
        uint256 usdOkuOut = _mintUsdOku(user1, 1000e6);

        // Drain the module's USDC buffer entirely.
        uint256 buffer = usdc.balanceOf(address(module));
        vm.prank(bufferWithdrawer);
        module.withdrawUsdc(treasury, buffer);

        vm.startPrank(user1);
        usdOku.approve(address(module), usdOkuOut);
        uint256 usdcOut = module.redeemUsdOku(usdOkuOut);
        vm.stopPrank();

        assertEq(usdcOut, 0, "queued, not paid");
        assertEq(usdOku.balanceOf(user1), 0, "USDOku is gone regardless");
        assertEq(queue.queueTail(), 1, "OkuM leg landed in the queue");
        assertGt(queue.totalQueuedRaw(), 0);
    }

    function test_RedeemUsdOku_ZeroReverts() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        module.redeemUsdOku(0);
    }

    function test_RedeemUsdOku_BlockedWhilePaused() public {
        uint256 out = _mintUsdOku(user1, 100e6);
        vm.prank(psmPauser);
        module.pause();
        vm.startPrank(user1);
        usdOku.approve(address(module), out);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        module.redeemUsdOku(out);
        vm.stopPrank();
    }

    /// @notice NOT blocked immediately after a mark. See the mint twin above.
    ///         This is the more important of the two: a holder must always be
    ///         able to exit.
    function test_RedeemUsdOku_NotBlockedImmediatelyAfterAMark() public {
        uint256 out = _mintUsdOku(user1, 100e6);
        uint256 current = token.uiMultiplier();
        _stepNoWarp(current + current / Constants.BASIS_POINTS);

        vm.startPrank(user1);
        usdOku.approve(address(module), out);
        module.redeemUsdOku(out);
        vm.stopPrank();
    }

    function test_RedeemUsdOku_EmitsBothEvents() public {
        uint256 out = _mintUsdOku(user1, 100e6);

        vm.startPrank(user1);
        usdOku.approve(address(module), out);
        vm.expectEmit(true, false, false, false, address(module));
        emit SubscriptionModule.Redeemed(user1, 0, 0, 0);
        vm.expectEmit(true, false, false, false, address(module));
        emit SubscriptionModule.UsdOkuRedeemed(user1, 0, 0, 0);
        module.redeemUsdOku(out);
        vm.stopPrank();
    }

    // ============ Quotes ============

    function test_QuoteMintUsdOku_ApproximatesActual() public {
        uint256 quoted = module.quoteMintUsdOku(1000e6);
        uint256 actual = _mintUsdOku(user1, 1000e6);
        assertApproxEqAbs(quoted, actual, 1);
    }

    function test_QuoteRedeemUsdOku_ApproximatesActual() public {
        uint256 out = _mintUsdOku(user1, 1000e6);
        uint256 quoted = module.quoteRedeemUsdOku(out);
        uint256 actual = _redeemUsdOku(user1, out);
        assertApproxEqAbs(quoted, actual, 2);
    }

    // ============ Admin wiring ============

    function test_SetUsdOkuWrapper_RequiresFeeManager() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        module.setUsdOkuWrapper(address(wrapper));
    }

    function test_SetUsdOkuWrapper_EmitsEvent() public {
        vm.expectEmit(true, true, false, false, address(module));
        emit SubscriptionModule.UsdOkuWrapperSet(address(wrapper), address(0xBEEF));
        vm.prank(capManager);
        module.setUsdOkuWrapper(address(0xBEEF));
        assertEq(address(module.usdOkuWrapper()), address(0xBEEF));

        // restore for any test ordering assumptions elsewhere
        vm.prank(capManager);
        module.setUsdOkuWrapper(address(wrapper));
    }

    // ============ Helpers ============

    /// @dev Two-step OkuM redemption, for the differential-path comparisons.
    function _redeem_directOkuM(address user, uint256 raw) internal returns (uint256 usdcOut) {
        vm.startPrank(user);
        token.approve(address(module), raw);
        usdcOut = module.redeem(raw);
        vm.stopPrank();
    }
}
