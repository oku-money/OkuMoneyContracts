// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {OkuM} from "../src/token/OkuM.sol";
import {USDOku} from "../src/token/USDOku.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Errors} from "../src/lib/Errors.sol";
import {Roles} from "../src/lib/Roles.sol";
import {IScaledUIAmount} from "../src/interfaces/erc8056/IScaledUIAmount.sol";
import {
    IScaledUIAmountNewUIMultiplier
} from "../src/interfaces/erc8056/IScaledUIAmountNewUIMultiplier.sol";
import {IScaledUIAmountConversion} from "../src/interfaces/erc8056/IScaledUIAmountConversion.sol";
import {IScaledUIAmountBalances} from "../src/interfaces/erc8056/IScaledUIAmountBalances.sol";

/**
 * @title RegressionTest
 * @notice Locks in the five defects fixed after the initial contract pass, plus
 *         the ERC-7540 surface alignment. Each test here corresponds to a bug
 *         that was actually present in the tree, not a hypothetical.
 */
contract RegressionTest is BaseTest {
    // =====================================================================
    // uiMultiplier() == 0 on a freshly deployed token
    //
    // `__ScaledUIAmount_init` seeded only `multiplier`, leaving `newMultiplier`
    // and `effectiveAt` at zero. Because `uiMultiplier()` resolves
    // `block.timestamp >= effectiveAt ? newMultiplier : multiplier`, and
    // `timestamp >= 0` is always true, a fresh token reported a multiplier of
    // ZERO. Every conversion returned zero or divided by zero — the token was
    // bricked from deployment. This is the highest-severity bug found.
    // =====================================================================

    function test_freshDeploy_uiMultiplierIsOne() public view {
        assertEq(okuM.uiMultiplier(), Constants.PRECISION, "live multiplier");
        assertEq(okuM.newUIMultiplier(), Constants.PRECISION, "pending multiplier");
        assertEq(okuM.effectiveAt(), block.timestamp, "effectiveAt seeded to now");
    }

    function test_freshDeploy_conversionsAreIdentity() public view {
        assertEq(okuM.toUIAmount(5e18), 5e18, "raw->UI at 1.0");
        assertEq(okuM.fromUIAmount(5e18), 5e18, "UI->raw at 1.0");
        // 1000 OkuM is worth 1000 USDC at M_oku = 1.0, in 6dp.
        assertEq(okuM.convertToAssets(1000e18), 1000 * USDC_UNIT, "convertToAssets");
        assertEq(okuM.convertToShares(1000 * USDC_UNIT), 1000e18, "convertToShares");
    }

    /// @dev End-to-end proof: with the bug, `convertToShares` divided by a zero
    ///      multiplier and this reverted, so no one could ever subscribe.
    function test_freshDeploy_subscriptionSucceeds() public {
        uint256 rawOut = _subscribe(alice, 1000 * USDC_UNIT);
        assertEq(rawOut, 1000e18, "1000 USDC buys 1000 OkuM at M_oku = 1.0");
    }

    /// @dev A fresh adapter must not read as stale. With `effectiveAt == 0`,
    ///      `block.timestamp - 0` exceeded any threshold immediately.
    function test_freshDeploy_effectiveAtIsNotEpochZero() public view {
        assertGt(okuM.effectiveAt(), 0, "effectiveAt must not be left at zero");
    }

    // =====================================================================
    // setUsdOkuRate locked itself out once the gap was breached
    //
    // The solvency check reverted for ANY rate once the projected gap exceeded
    // the bound. Since every rate >= PRECISION projects a liability >= current
    // against constant backing, a breached system could not even switch accrual
    // OFF — contradicting the README's "a rate write lowering the rate is still
    // permitted". Fix: skip the check when newRate == PRECISION (a full stop is
    // provably non-worsening, since rpow at PRECISION is the identity).
    // =====================================================================

    /// @dev Wrap a position, then pre-fund the wrapper so a forward rate is legal.
    function _wrapAndPrefund() internal returns (uint256 raw) {
        raw = _subscribe(alice, 1000 * USDC_UNIT);

        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        assertTrue(wrapper.backingCoversLiability(), "wrap alone must satisfy the invariant");
        _prefundWrapper(20 * USDC_UNIT);
    }

    /// @dev The core of the pre-funding model: you cannot promise yield you have
    ///      not already funded. A rate is legal only if the wrapper already holds
    ///      OkuM covering the liability projected to `rateEnd`.
    function test_unfundedRate_reverts() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        // Backing exactly equals liability, so ANY positive rate is unfunded.
        vm.prank(rateSetter);
        vm.expectPartialRevert(USDOku.SolvencyGapExceeded.selector);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(1000), block.timestamp + 30 days);
    }

    /// @dev The escape hatch must survive the zero bound: when funding lapses,
    ///      switching accrual OFF is the correct response and cannot itself be
    ///      blocked by a funding shortfall.
    function test_unfundedRate_fullStopStillPermitted() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        uint256 indexBefore = usdOku.usdOkuIndex();

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(Constants.PRECISION, block.timestamp + 1 days);

        assertEq(usdOku.usdRatePerSecond(), Constants.PRECISION, "rate switched off");
        vm.warp(block.timestamp + 12 hours);
        assertEq(usdOku.usdOkuIndex(), indexBefore, "index frozen by the stop");
    }

    /// @dev Once the forward yield is actually in the wrapper, the same rate that
    ///      was rejected becomes legal.
    function test_fundedRate_succeeds() public {
        _wrapAndPrefund();

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(1000), block.timestamp + 30 days);

        vm.warp(block.timestamp + 30 days);
        assertTrue(
            wrapper.backingCoversLiability(),
            "backing still covers liability after the funded segment fully accrues"
        );
    }

    // =====================================================================
    // setOkuMultiplier was pause-gated
    //
    // README: "Also not gated: setOkuMultiplier, haltAccrual, blacklist —
    // emergency levers that must remain callable during an incident." Raising
    // M_oku raises realized backing, so pause-gating it removed the solvency
    // remedy exactly when an incident made it necessary.
    // =====================================================================

    function test_paused_markStillWritable() public {
        _subscribe(alice, 1000 * USDC_UNIT);

        vm.prank(pauser);
        okuM.pause();

        uint256 before = okuM.uiMultiplier();
        _stepOkuMultiplier(50);
        assertGt(okuM.uiMultiplier(), before, "mark must land while paused");
    }

    /// @dev The other half of the property: pause must still do its actual job.
    function test_paused_transfersStillBlocked() public {
        _subscribe(alice, 1000 * USDC_UNIT);

        vm.prank(pauser);
        okuM.pause();

        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuM.transfer(bob, 1e18);
    }

    function test_haltAccrual_blocksMarksAndColdResumeRestores() public {
        vm.prank(guardian);
        okuM.haltAccrual();

        // Hoisted: an inline read would consume the expectRevert.
        uint256 target = okuM.uiMultiplier() + 1e15;

        vm.prank(rateSetter);
        vm.expectRevert(OkuM.AccrualIsHalted.selector);
        okuM.setOkuMultiplier(target, 1);

        // Warm guardian can stop but must NOT be able to restart.
        vm.prank(guardian);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        okuM.resumeAccrual();

        vm.prank(resumer);
        okuM.resumeAccrual();

        _stepOkuMultiplier(50);
        assertGt(okuM.uiMultiplier(), Constants.PRECISION, "marks resume after cold resume");
    }

    // =====================================================================
    // wrap checked slippage against the pre-rounding quote
    //
    // `minUsdOkuOut` was compared against the raw dollar value, but the share
    // conversion floors afterwards, so the balance actually credited could be a
    // wei less than the value the check approved.
    // =====================================================================

    function test_wrap_quoteMatchesCreditedBalanceExactly() public {
        // Drive M_usd to a non-round value so the share flooring actually bites.
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(731), block.timestamp + 17 days);
        vm.warp(block.timestamp + 17 days);
        _stepOkuMultiplier(37);

        uint256 raw = _subscribe(bob, 3337 * USDC_UNIT);
        assertEq(usdOku.balanceOf(bob), 0, "bob starts with no USDOku");

        uint256 quoted = wrapper.quoteWrap(raw);

        vm.startPrank(bob);
        okuM.approve(address(wrapper), raw);
        // Passing the quote straight back as minOut must not revert.
        uint256 returned = wrapper.wrap(raw, bob, quoted);
        vm.stopPrank();

        assertEq(returned, quoted, "return value matches quote");
        assertEq(usdOku.balanceOf(bob), quoted, "CREDITED balance matches quote");
    }

    // =====================================================================
    // allowanceUI reverted on an infinite approval
    //
    // toUIAmount overflows for an allowance near uint256 max once
    // M_oku > PRECISION. Infinite approval is the most common approval pattern
    // there is, so a drift-monitoring view that reverts on it is useless.
    // =====================================================================

    function test_allowanceUI_saturatesOnInfiniteApproval() public {
        vm.prank(alice);
        okuM.approve(bob, type(uint256).max);

        _stepOkuMultiplier(100);
        assertGt(okuM.uiMultiplier(), Constants.PRECISION, "multiplier above 1.0");

        assertEq(okuM.allowanceUI(alice, bob), type(uint256).max, "saturates, does not revert");
    }

    /// @dev The behaviour the view exists for: a bounded raw approval's DOLLAR
    ///      value silently grows as M_oku steps (README Limitation 7).
    function test_allowanceUI_showsDriftOnBoundedApproval() public {
        vm.prank(alice);
        okuM.approve(bob, 1000e18);

        assertEq(okuM.allowanceUI(alice, bob), 1000e18, "no drift at 1.0");

        _stepOkuMultiplier(100); // +1%
        assertEq(okuM.allowanceUI(alice, bob), 1010e18, "dollar value drifted up");
        assertEq(okuM.allowance(alice, bob), 1000e18, "raw allowance unchanged");
    }

    // =====================================================================
    // ERC-8056 / ERC-7540 interface surface
    // =====================================================================

    /// @dev Guards against signature drift: if any interface function changes,
    ///      the computed ID stops matching the ID pinned in Constants, which is
    ///      what we advertise via supportsInterface.
    function test_erc8056_pinnedIdsMatchInterfaces() public pure {
        assertEq(type(IScaledUIAmount).interfaceId, Constants.IID_SCALED_UI_AMOUNT, "core id");
        assertEq(
            type(IScaledUIAmountNewUIMultiplier).interfaceId,
            Constants.IID_SCALED_UI_AMOUNT_NEW_MULTIPLIER,
            "pending id"
        );
        assertEq(
            type(IScaledUIAmountConversion).interfaceId,
            Constants.IID_SCALED_UI_AMOUNT_CONVERSION,
            "conversion id"
        );
        assertEq(
            type(IScaledUIAmountBalances).interfaceId,
            Constants.IID_SCALED_UI_AMOUNT_BALANCES,
            "balances id"
        );
    }

    function test_okuM_claimsAllFourScaledUIInterfaces() public view {
        assertTrue(okuM.supportsInterface(Constants.IID_SCALED_UI_AMOUNT));
        assertTrue(okuM.supportsInterface(Constants.IID_SCALED_UI_AMOUNT_NEW_MULTIPLIER));
        assertTrue(okuM.supportsInterface(Constants.IID_SCALED_UI_AMOUNT_CONVERSION));
        assertTrue(okuM.supportsInterface(Constants.IID_SCALED_UI_AMOUNT_BALANCES));
    }

    /// @dev USDOku's balanceOf already returns dollars. An 8056 multiplier on top
    ///      would be a second scaling factor over an already-scaled balance, and
    ///      an aware wallet would apply it twice. Must never be claimed.
    function test_usdOku_neverClaimsScaledUI() public view {
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_AMOUNT));
    }

    function test_module_doesNotClaimErc7540() public view {
        assertFalse(module.supportsInterface(Constants.IID_ERC7540_OPERATOR), "operator");
        assertFalse(module.supportsInterface(Constants.IID_ERC7575), "7575");
        assertFalse(module.supportsInterface(Constants.IID_ERC7540_DEPOSIT), "async deposit");
        assertFalse(module.supportsInterface(Constants.IID_ERC7540_REDEEM), "async redeem");
    }

    function test_erc7540Views_trackPendingState() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        // requestId == 0 is ERC-7540's "aggregate for this controller" convention.
        assertEq(module.pendingDepositRequest(0, alice), 1000 * USDC_UNIT, "aggregate lookup");
        assertEq(module.pendingDepositRequest(requestId, alice), 1000 * USDC_UNIT, "exact lookup");
        assertEq(module.pendingDepositRequest(9999, alice), 0, "unknown id");
        assertEq(module.pendingRedeemRequest(0, alice), 0, "wrong direction");

        // We push on fulfillment, so nothing is ever claimable.
        assertEq(module.claimableDepositRequest(0, alice), 0, "no claimable state");
        assertEq(module.claimableRedeemRequest(0, alice), 0, "no claimable state");

        vm.prank(fulfiller);
        module.fulfillSubscription(requestId);

        assertEq(module.pendingDepositRequest(0, alice), 0, "cleared after fulfillment");
    }
}
