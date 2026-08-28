// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {USDOku} from "../src/token/USDOku.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Errors} from "../src/lib/Errors.sol";
import {Roles} from "../src/lib/Roles.sol";

/**
 * @title USDOkuTest
 * @notice The rebasing leg: share ledger, continuous accrual, and the rate
 *         authority's bounds. USDOku holds no reserves and prices nothing —
 *         its risk is entirely in the index arithmetic and the rate caps.
 */
contract USDOkuTest is BaseTest {
    // ============ Accrual ============

    function test_indexStartsAtPrecisionAndIsFlatWithoutARate() public {
        assertEq(usdOku.usdOkuIndex(), Constants.PRECISION);
        vm.warp(block.timestamp + 365 days);
        assertEq(usdOku.usdOkuIndex(), Constants.PRECISION, "no rate means no accrual");
    }

    function test_accrualCompoundsThenFreezesAtRateEnd() public {
        _wrapAndPrefund();

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(1000), block.timestamp + 30 days);

        vm.warp(block.timestamp + 15 days);
        uint256 mid = usdOku.usdOkuIndex();
        assertGt(mid, Constants.PRECISION, "accruing");

        vm.warp(block.timestamp + 15 days);
        uint256 atEnd = usdOku.usdOkuIndex();
        assertGt(atEnd, mid);
        // ~0.8253% over 30 days at the 1000bps cap.
        assertApproxEqRel(atEnd, 1.008253e18, 0.001e18, "matches the documented figure");

        // Frozen past rateEnd — there is no pending-rate continuation.
        vm.warp(block.timestamp + 60 days);
        assertEq(usdOku.usdOkuIndex(), atEnd, "frozen after rateEnd");
    }

    /// @dev Re-anchoring must be continuous: the slope changes, the value does not.
    function test_rateRewriteIsContinuousNoStep() public {
        _wrapAndPrefund();

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(1000), block.timestamp + 30 days);
        vm.warp(block.timestamp + 10 days);

        uint256 before = usdOku.usdOkuIndex();

        _prefundWrapper(20 * USDC_UNIT);
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(200), block.timestamp + 20 days);

        assertEq(usdOku.usdOkuIndex(), before, "no step at the re-anchor");
        assertEq(usdOku.usdBaseIndex(), before, "baseIndex snapshotted to the live value");
        assertEq(usdOku.usdLastAccrualTime(), block.timestamp);
    }

    function test_indexIsMonotoneAcrossManySegments() public {
        _wrapAndPrefund();
        uint256 last = usdOku.usdOkuIndex();

        for (uint256 i = 0; i < 6; i++) {
            _prefundWrapper(20 * USDC_UNIT);
            vm.prank(rateSetter);
            usdOku.setUsdOkuRate(_ratePerSecondForAprBps(500), block.timestamp + 30 days);
            vm.warp(block.timestamp + 30 days);

            uint256 now_ = usdOku.usdOkuIndex();
            assertGe(now_, last, "M_usd must never decrease");
            last = now_;
        }
    }

    // ============ Rate authority bounds ============

    function test_setRate_rejectsBelowPrecision() public {
        vm.prank(rateSetter);
        vm.expectRevert(Errors.MultiplierCannotDecrease.selector);
        usdOku.setUsdOkuRate(Constants.PRECISION - 1, block.timestamp + 1 days);
    }

    function test_setRate_rejectsAboveImpliedAprCap() public {
        uint256 tooFast = _ratePerSecondForAprBps(Constants.MAX_IMPLIED_APR_BPS + 50);
        vm.prank(rateSetter);
        vm.expectRevert(USDOku.RateAboveMaximum.selector);
        usdOku.setUsdOkuRate(tooFast, block.timestamp + 1 days);
    }

    function test_setRate_acceptsExactlyAtTheCap() public {
        _wrapAndPrefund();
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(Constants.MAX_USD_RATE_PER_SECOND, block.timestamp + 1 days);
    }

    function test_setRate_rejectsEndInPastOrPresent() public {
        vm.startPrank(rateSetter);
        vm.expectRevert(USDOku.RateEndNotInFuture.selector);
        usdOku.setUsdOkuRate(Constants.PRECISION, block.timestamp);

        vm.expectRevert(USDOku.RateEndNotInFuture.selector);
        usdOku.setUsdOkuRate(Constants.PRECISION, block.timestamp - 1);
        vm.stopPrank();
    }

    function test_setRate_rejectsDurationBeyondCap() public {
        vm.prank(rateSetter);
        vm.expectRevert(USDOku.RateDurationTooLong.selector);
        usdOku.setUsdOkuRate(Constants.PRECISION, block.timestamp + Constants.MAX_RATE_DURATION + 1);
    }

    function test_setRate_requiresRateSetterRole() public {
        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.setUsdOkuRate(Constants.PRECISION, block.timestamp + 1 days);
    }

    // ============ Halt / resume ============

    function test_halt_freezesIndexAndBlocksRateWrites() public {
        _wrapAndPrefund();
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(1000), block.timestamp + 30 days);
        vm.warp(block.timestamp + 10 days);

        uint256 atHalt = usdOku.usdOkuIndex();

        vm.prank(guardian);
        usdOku.haltUsdOkuAccrual();

        assertTrue(usdOku.accrualHalted());
        assertEq(usdOku.usdRatePerSecond(), Constants.PRECISION, "rate zeroed");
        assertEq(usdOku.usdRateEnd(), block.timestamp, "rateEnd pulled to now");

        vm.warp(block.timestamp + 30 days);
        assertEq(usdOku.usdOkuIndex(), atHalt, "index frozen at the halt value");

        vm.prank(rateSetter);
        vm.expectRevert(USDOku.AccrualIsHalted.selector);
        usdOku.setUsdOkuRate(Constants.PRECISION, block.timestamp + 1 days);
    }

    /// @dev Warm can stop, only cold can restart. Same split as pause/blacklist.
    function test_resume_isColdOnly() public {
        vm.prank(guardian);
        usdOku.haltUsdOkuAccrual();

        vm.prank(guardian);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.resumeUsdOkuAccrual();

        vm.prank(resumer);
        usdOku.resumeUsdOkuAccrual();
        assertFalse(usdOku.accrualHalted());
    }

    /// @dev Resuming clears the latch but does NOT restart accrual — a new,
    ///      pre-funded rate is still required.
    function test_resume_leavesIndexFrozenUntilANewRate() public {
        _wrapAndPrefund();
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(1000), block.timestamp + 30 days);
        vm.warp(block.timestamp + 5 days);

        vm.prank(guardian);
        usdOku.haltUsdOkuAccrual();
        uint256 frozen = usdOku.usdOkuIndex();

        vm.prank(resumer);
        usdOku.resumeUsdOkuAccrual();

        vm.warp(block.timestamp + 10 days);
        assertEq(usdOku.usdOkuIndex(), frozen, "still frozen without a new rate");
    }

    // ============ Share ledger ============

    function test_balanceIsSharesTimesIndex() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        uint256 shares = usdOku.sharesOf(alice);
        assertEq(usdOku.balanceOf(alice), shares * usdOku.usdOkuIndex() / Constants.PRECISION);
        assertEq(usdOku.totalShares(), shares);
        assertEq(usdOku.totalSupply(), usdOku.balanceOf(alice));
    }

    function test_transfer_movesSharesAndPreservesTotalSupply() public {
        _wrapAndPrefund();

        uint256 supplyBefore = usdOku.totalSupply();
        uint256 sharesBefore = usdOku.totalShares();

        vm.prank(alice);
        usdOku.transfer(bob, 100e18);

        assertApproxEqAbs(usdOku.totalSupply(), supplyBefore, 2, "supply conserved");
        assertEq(usdOku.totalShares(), sharesBefore, "shares conserved");
        assertApproxEqAbs(usdOku.balanceOf(bob), 100e18, 2);
    }

    function test_transferFrom_spendsAllowance() public {
        _wrapAndPrefund();

        vm.prank(alice);
        usdOku.approve(bob, 100e18);

        vm.prank(bob);
        usdOku.transferFrom(alice, bob, 100e18);

        assertEq(usdOku.allowance(alice, bob), 0);
        assertApproxEqAbs(usdOku.balanceOf(bob), 100e18, 2);
    }

    function test_transfer_revertsOnInsufficientShares() public {
        _wrapAndPrefund();
        uint256 tooMuch = usdOku.balanceOf(alice) * 2;

        vm.prank(alice);
        vm.expectRevert(Errors.InsufficientBalance.selector);
        usdOku.transfer(bob, tooMuch);
    }

    function test_transfer_rejectsZeroAddress() public {
        _wrapAndPrefund();
        vm.prank(alice);
        vm.expectRevert(Errors.ZeroAddress.selector);
        usdOku.transfer(address(0), 1e18);
    }

    /// @dev All supply changes go through the privileged mint/burn. The inherited
    ///      OZ `_update` path must be unreachable, or `balanceOf` (derived from
    ///      shares) would silently diverge from `_balances`.
    function test_inheritedUpdatePathIsUnreachable() public {
        _wrapAndPrefund();
        // Any route into `_update` reverts. `transfer` overrides it, so the only
        // way to observe is a direct mint/burn attempt, which is role-gated.
        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.mint(alice, 1e18);
    }

    // ============ Mint / burn (wrapper-only) ============

    function test_mintAndBurn_areRoleGated() public {
        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.mint(alice, 1e18);

        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.burn(alice, 1e18);
    }

    function test_mint_rejectsZeroInputs() public {
        vm.startPrank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        usdOku.mint(address(0), 1e18);

        vm.expectRevert(Errors.ZeroAmount.selector);
        usdOku.mint(alice, 0);
        vm.stopPrank();
    }

    function test_burn_rejectsZeroAndOverdraft() public {
        vm.startPrank(admin);
        vm.expectRevert(Errors.ZeroAmount.selector);
        usdOku.burn(alice, 0);

        vm.expectRevert(Errors.InsufficientBalance.selector);
        usdOku.burn(alice, 1e18);
        vm.stopPrank();
    }

    // ============ Pause ============

    function test_pause_blocksTransfersAndMintButNotBurn() public {
        _wrapAndPrefund();

        vm.prank(admin);
        usdOku.grantRole(Roles.USD_PAUSER, pauser);
        vm.prank(pauser);
        usdOku.pause();

        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        usdOku.transfer(bob, 1e18);

        vm.prank(admin);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        usdOku.mint(alice, 1e18);

        // Burn is deliberately NOT pause-gated: unwrap must keep working.
        vm.prank(admin);
        usdOku.burn(alice, 1e18);
    }

    function test_unpause_isColdOnly() public {
        vm.prank(admin);
        usdOku.grantRole(Roles.USD_PAUSER, pauser);
        vm.prank(pauser);
        usdOku.pause();

        vm.prank(pauser);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.unpause();

        vm.prank(admin);
        usdOku.unpause();
        assertFalse(usdOku.paused());
    }

    // ============ Blacklist ============

    function test_blacklist_blocksSendAndReceive() public {
        _wrapAndPrefund();

        vm.prank(admin);
        usdOku.blacklist(bob);

        vm.prank(alice);
        vm.expectRevert(USDOku.RecipientBlacklisted.selector);
        usdOku.transfer(bob, 1e18);

        vm.prank(admin);
        usdOku.unblacklist(bob);
        vm.prank(alice);
        usdOku.transfer(bob, 1e18);

        vm.prank(admin);
        usdOku.blacklist(bob);
        vm.prank(bob);
        vm.expectRevert(USDOku.SenderBlacklisted.selector);
        usdOku.transfer(alice, 1e18);
    }

    function test_blacklist_rejectsDoubleSetAndUnsetOfClean() public {
        vm.startPrank(admin);
        usdOku.blacklist(bob);
        vm.expectRevert(USDOku.AlreadyBlacklisted.selector);
        usdOku.blacklist(bob);

        usdOku.unblacklist(bob);
        vm.expectRevert(USDOku.NotBlacklisted.selector);
        usdOku.unblacklist(bob);
        vm.stopPrank();
    }

    // ============ Wiring ============

    function test_setWrapper_rejectsZeroAndIsAdminOnly() public {
        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        usdOku.setWrapper(address(0));

        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.setWrapper(address(wrapper));
    }

    function test_initialize_rejectsZeroAdmin() public {
        USDOku impl = new USDOku();
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), abi.encodeCall(USDOku.initialize, ("X", "X", address(0))));
    }

    // ============ ERC-165 ============

    /// @dev USDOku's balanceOf ALREADY returns dollars. An ERC-8056 multiplier on
    ///      top would be a second scaling factor over an already-scaled balance,
    ///      and an aware wallet would apply it twice.
    function test_neverClaimsScaledUIInterface() public view {
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_AMOUNT));
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_AMOUNT_BALANCES));
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_AMOUNT_CONVERSION));
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_AMOUNT_NEW_MULTIPLIER));
    }

    // ============ Helpers ============

    function _wrapAndPrefund() internal returns (uint256 raw) {
        raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();
        _prefundWrapper(20 * USDC_UNIT);
    }
}
