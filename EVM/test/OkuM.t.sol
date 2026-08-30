// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {OkuM} from "../src/token/OkuM.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Errors} from "../src/lib/Errors.sol";
import {Roles} from "../src/lib/Roles.sol";
import {MathLib} from "../src/lib/MathLib.sol";
import {IScaledUIAmount} from "../src/interfaces/erc8056/IScaledUIAmount.sol";
import {
    IScaledUIAmountNewUIMultiplier
} from "../src/interfaces/erc8056/IScaledUIAmountNewUIMultiplier.sol";
import {IScaledUIAmountConversion} from "../src/interfaces/erc8056/IScaledUIAmountConversion.sol";
import {IScaledUIAmountBalances} from "../src/interfaces/erc8056/IScaledUIAmountBalances.sol";

contract OkuMTest is BaseTest {
    // ============ ERC-8056 conformance ============

    /// @dev The interface IDs are published in the EIP as literals. Asserting the
    ///      computed IDs against our constants means a drifting interface breaks the
    ///      build rather than silently breaking wallet detection.
    function test_interfaceIdsMatchThePublishedEip() public view {
        assertEq(type(IScaledUIAmount).interfaceId, Constants.IID_SCALED_UI_AMOUNT);
        assertEq(
            type(IScaledUIAmountNewUIMultiplier).interfaceId, Constants.IID_SCALED_UI_NEW_MULTIPLIER
        );
        assertEq(type(IScaledUIAmountConversion).interfaceId, Constants.IID_SCALED_UI_CONVERSION);
        assertEq(type(IScaledUIAmountBalances).interfaceId, Constants.IID_SCALED_UI_BALANCES);

        assertTrue(okuM.supportsInterface(Constants.IID_SCALED_UI_AMOUNT));
        assertTrue(okuM.supportsInterface(Constants.IID_SCALED_UI_NEW_MULTIPLIER));
        assertTrue(okuM.supportsInterface(Constants.IID_SCALED_UI_CONVERSION));
        assertTrue(okuM.supportsInterface(Constants.IID_SCALED_UI_BALANCES));
        assertFalse(okuM.supportsInterface(0xdeadbeef));
    }

    /// @dev REGRESSION. A freshly deployed token must not report a zero multiplier.
    ///      The EIP's reference implementation shape resolves
    ///      `timestamp >= effectiveAt ? newMultiplier : multiplier`, so seeding only
    ///      one of the two fields returns 0 from block one — every conversion
    ///      returning zero or dividing by zero, i.e. bricked from deployment.
    function test_freshDeployHasLiveMultiplier() public {
        OkuM fresh = OkuM(
            address(
                new ERC1967Proxy(
                    address(new OkuM()),
                    abi.encodeCall(OkuM.initialize, ("Oku Money", "OkuM", admin, 1e27))
                )
            )
        );
        assertEq(fresh.uiMultiplier(), Constants.PRECISION, "must be 1.0, never 0");
        assertEq(fresh.toUIAmount(1e18), 1e18);
        assertEq(fresh.fromUIAmount(1e18), 1e18);
        assertEq(fresh.balanceOfUI(alice), 0);
        assertEq(fresh.totalSupplyUI(), 0);
    }

    /// @dev The boundary contract: at `effectiveAt` exactly, the pending multiplier
    ///      IS the live one.
    function test_pendingBecomesLiveExactlyAtEffectiveAt() public {
        uint64 start = uint64(block.timestamp + 1 days);
        uint256 base = okuM.uiMultiplier();

        vm.prank(gatekeeper);
        psm.closeWindow();
        vm.prank(rateSetter);
        okuM.setOkuMRate(base, _rateFor(500), start, start + uint64(30 days), 0);

        assertEq(okuM.effectiveAt(), start);
        assertEq(okuM.newUIMultiplier(), base);

        vm.warp(start - 1);
        assertEq(okuM.uiMultiplier(), base, "flat before the anchor");

        vm.warp(start);
        assertEq(okuM.uiMultiplier(), okuM.newUIMultiplier(), "equal AT the anchor");

        vm.warp(start + 1 days);
        assertGt(okuM.uiMultiplier(), okuM.newUIMultiplier(), "accruing after");
    }

    function test_accrualFlatlinesPastRateEnd() public {
        _setOkuMRate(500, 7 days);
        vm.warp(block.timestamp + 7 days);
        uint256 atEnd = okuM.uiMultiplier();

        vm.warp(block.timestamp + 365 days);
        assertEq(okuM.uiMultiplier(), atEnd, "a missed renewal freezes, never compounds on");
    }

    function test_conversionsRoundAgainstTheCaller() public {
        _setOkuMRate(500, 30 days);
        vm.warp(block.timestamp + 11 days);

        uint256 raw = 123_456_789_012_345_678;
        uint256 back = okuM.fromUIAmount(okuM.toUIAmount(raw));
        assertLe(back, raw, "round-trip never creates value");
        assertGe(back + 2, raw, "and loses at most dust");
    }

    // ============ Rate declaration bounds ============

    function test_rateSetterIsRoleGated() public {
        uint256 base = okuM.uiMultiplier();
        vm.prank(gatekeeper);
        psm.closeWindow();

        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        okuM.setOkuMRate(
            base, _rateFor(500), uint64(block.timestamp), uint64(block.timestamp + 1), 0
        );
    }

    function test_rejectsRateAboveTheAprCeiling() public {
        uint256 base = okuM.uiMultiplier();
        uint256 tooHigh = Constants.MAX_RATE_PER_SECOND + 1;
        uint64 s = uint64(block.timestamp);
        vm.prank(gatekeeper);
        psm.closeWindow();

        vm.prank(rateSetter);
        vm.expectRevert(OkuM.RateOutOfBounds.selector);
        okuM.setOkuMRate(base, tooHigh, s, s + 1 days, 0);
    }

    function test_rejectsWindowLongerThanMaxDuration() public {
        uint256 base = okuM.uiMultiplier();
        uint256 rate = _rateFor(500);
        uint64 s = uint64(block.timestamp);
        uint64 tooLong = s + uint64(Constants.MAX_RATE_DURATION) + 1;
        vm.prank(gatekeeper);
        psm.closeWindow();

        vm.prank(rateSetter);
        vm.expectRevert(OkuM.InvalidRateWindow.selector);
        okuM.setOkuMRate(base, rate, s, tooLong, 0);
    }

    function test_rejectsSchedulingTooFarAhead() public {
        uint256 base = okuM.uiMultiplier();
        uint256 rate = _rateFor(500);
        uint64 s = uint64(block.timestamp + Constants.MAX_SCHEDULE_LEAD + 1);
        vm.prank(gatekeeper);
        psm.closeWindow();

        vm.prank(rateSetter);
        vm.expectRevert(OkuM.ScheduledTooFarAhead.selector);
        okuM.setOkuMRate(base, rate, s, s + 1 days, 0);
    }

    function test_multiplierCannotDecrease() public {
        _setOkuMRate(500, 30 days);
        vm.warp(block.timestamp + 5 days);

        uint256 live = okuM.uiMultiplier();
        uint256 rate = _rateFor(500);
        uint64 s = uint64(block.timestamp);
        vm.prank(gatekeeper);
        psm.closeWindow();

        vm.prank(rateSetter);
        vm.expectRevert(OkuM.MultiplierCannotDecrease.selector);
        okuM.setOkuMRate(live - 1, rate, s, s + 1 days, 0);
    }

    /// @dev The bound that makes "no step arbitrage" contract-enforced rather than
    ///      procedural: even a fully compromised rate setter cannot manufacture a
    ///      jump larger than `MAX_REANCHOR_BPS`.
    function test_reanchorIsBoundedEvenForACompromisedKey() public {
        _setOkuMRate(500, 30 days);
        vm.warp(block.timestamp + 5 days);

        uint256 live = okuM.uiMultiplier();
        uint256 rate = _rateFor(500);
        uint64 s = uint64(block.timestamp);
        uint256 maxAllowed = live + (live * Constants.MAX_REANCHOR_BPS) / Constants.BASIS_POINTS;

        vm.prank(gatekeeper);
        psm.closeWindow();

        // A doubling attempt is refused.
        vm.prank(rateSetter);
        vm.expectPartialRevert(OkuM.ReanchorTooLarge.selector);
        okuM.setOkuMRate(live * 2, rate, s, s + 1 days, 0);

        // Exactly at the bound is allowed — this is the catch-up path.
        vm.prank(rateSetter);
        okuM.setOkuMRate(maxAllowed, rate, s, s + uint64(1 days), 0);
        assertEq(okuM.uiMultiplier(), maxAllowed);
    }

    /// @dev Stopping accrual must never be blocked by the checks that bound raising
    ///      it — otherwise the contract can lock itself out of the one action needed
    ///      to recover.
    function test_flatSegmentIsAlwaysPermitted() public {
        _setOkuMRate(1000, 30 days);
        vm.warp(block.timestamp + 10 days);

        uint256 live = okuM.uiMultiplier();
        uint64 s = uint64(block.timestamp);
        vm.prank(gatekeeper);
        psm.closeWindow();

        vm.prank(rateSetter);
        okuM.setOkuMRate(live, Constants.PRECISION, s, s + uint64(30 days), 0);

        vm.warp(block.timestamp + 30 days);
        assertEq(okuM.uiMultiplier(), live, "a flat segment stops accrual dead");
    }

    // ============ The closed-window precondition ============

    function test_rateCannotBePublishedWhileTheWindowIsOpen() public {
        assertTrue(psm.conversionsOpen(), "fixture: window is open");
        uint256 base = okuM.uiMultiplier();
        uint256 rate = _rateFor(500);
        uint64 s = uint64(block.timestamp);

        vm.prank(rateSetter);
        vm.expectRevert(OkuM.ConversionsStillOpen.selector);
        okuM.setOkuMRate(base, rate, s, s + 1 days, 0);

        vm.prank(gatekeeper);
        psm.closeWindow();

        vm.prank(rateSetter);
        okuM.setOkuMRate(base, rate, s, s + uint64(1 days), 0);
    }

    /// @dev A paused PSM is a closed window — pausing must not block rate publication.
    function test_pausedPsmCountsAsClosed() public {
        vm.prank(admin);
        psm.pause();
        assertFalse(psm.conversionsOpen());

        uint256 base = okuM.uiMultiplier();
        uint256 rate = _rateFor(500);
        uint64 s = uint64(block.timestamp);
        vm.prank(rateSetter);
        okuM.setOkuMRate(base, rate, s, s + uint64(1 days), 0);
    }

    function test_gateUnsetSkipsTheCheck() public {
        vm.prank(admin);
        okuM.setConversionGate(address(0));

        uint256 base = okuM.uiMultiplier();
        uint256 rate = _rateFor(500);
        uint64 s = uint64(block.timestamp);
        vm.prank(rateSetter);
        okuM.setOkuMRate(base, rate, s, s + uint64(1 days), 0);
    }

    // ============ Halt ============

    function test_haltBlocksDeclarationsButNotTheLiveSegment() public {
        _setOkuMRate(500, 30 days);
        vm.warp(block.timestamp + 1 days);
        uint256 atHalt = okuM.uiMultiplier();

        vm.prank(admin);
        okuM.haltAccrual();
        assertTrue(okuM.accrualHalted());

        // The in-flight segment continues — rewinding it would move the price DOWN
        // for everyone holding.
        vm.warp(block.timestamp + 1 days);
        assertGt(okuM.uiMultiplier(), atHalt, "live segment runs on");

        uint256 base = okuM.uiMultiplier();
        uint256 rate = _rateFor(500);
        uint64 s = uint64(block.timestamp);
        vm.prank(gatekeeper);
        psm.closeWindow();
        vm.prank(rateSetter);
        vm.expectRevert(OkuM.AccrualIsHalted.selector);
        okuM.setOkuMRate(base, rate, s, s + 1 days, 0);

        // And exposure is bounded: past rateEnd it flatlines regardless.
        vm.warp(s + 40 days);
        uint256 frozen = okuM.uiMultiplier();
        vm.warp(block.timestamp + 365 days);
        assertEq(okuM.uiMultiplier(), frozen, "halt + flatline bounds the exposure");
    }

    function test_haltResumeIsRoleAsymmetric() public {
        address warm = makeAddr("warm");
        vm.startPrank(admin);
        okuM.grantRole(Roles.OKUM_PAUSER, warm);
        vm.stopPrank();

        vm.prank(warm);
        okuM.haltAccrual();

        // The warm key can stop but cannot restart.
        vm.prank(warm);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        okuM.resumeAccrual();

        vm.prank(admin);
        okuM.resumeAccrual();
        assertFalse(okuM.accrualHalted());
    }

    // ============ Supply controls ============

    function test_mintIsBoundedByAllowanceAndCap() public {
        vm.prank(admin);
        okuM.configureMinterAllowance(admin, 100e18);

        vm.prank(admin);
        vm.expectRevert(OkuM.ExceedsAllowance.selector);
        okuM.mint(alice, 101e18);

        vm.prank(admin);
        okuM.mint(alice, 100e18);
        assertEq(okuM.minterAllowance(admin), 0, "allowance decrements");

        // Hoisted: an inline `okuM.totalSupply()` here would consume the prank.
        uint256 supplyNow = okuM.totalSupply();
        vm.prank(admin);
        okuM.setMaxSupply(supplyNow);
        vm.prank(admin);
        okuM.configureMinterAllowance(admin, 100e18);
        vm.prank(admin);
        vm.expectRevert(OkuM.ExceedsSupplyCap.selector);
        okuM.mint(alice, 1);
    }

    function test_maxSupplyIsCappedAtMaxTotalSupply() public {
        vm.prank(admin);
        vm.expectRevert(OkuM.ExceedsMaxTotalSupply.selector);
        okuM.setMaxSupply(Constants.MAX_TOTAL_SUPPLY + 1);
    }

    function test_allowanceUiSaturatesOnInfiniteApproval() public {
        vm.prank(alice);
        okuM.approve(bob, type(uint256).max);
        assertEq(okuM.allowanceUI(alice, bob), type(uint256).max, "must not revert or wrap");

        vm.prank(alice);
        okuM.approve(bob, 1000e18);
        _setOkuMRate(500, 30 days);
        vm.warp(block.timestamp + 30 days);

        // A raw-denominated approval GROWS in dollar value — the opposite drift to a
        // USDOku approval, and a real integration hazard.
        assertGt(okuM.allowanceUI(alice, bob), 1000e18);
    }

    function test_pauseBlocksTransfersNotBurn() public {
        _fundBuffer(100_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 1000 * USDC_UNIT);

        vm.prank(admin);
        okuM.pause();

        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        okuM.transfer(bob, 1);

        // Burn still works while paused, so a blacklisted holder can be burned down
        // during an incident.
        vm.prank(admin);
        okuM.configureMinterAllowance(admin, raw);
        vm.prank(admin);
        okuM.unpause();
        vm.prank(admin);
        okuM.mint(admin, 1e18);
        vm.prank(admin);
        okuM.pause();
        vm.prank(admin);
        okuM.burn(1e18);
    }

    function test_blacklistBlocksBothSidesAndWorksWhilePaused() public {
        vm.prank(admin);
        okuM.pause();
        vm.prank(admin);
        okuM.blacklist(alice);
        assertTrue(okuM.isBlacklisted(alice));

        vm.prank(admin);
        vm.expectRevert(OkuM.AlreadyBlacklisted.selector);
        okuM.blacklist(alice);

        vm.prank(admin);
        okuM.unblacklist(alice);
        vm.prank(admin);
        vm.expectRevert(OkuM.NotBlacklisted.selector);
        okuM.unblacklist(alice);
    }

    function test_initializeRejectsZeroAdminAndOversizedCap() public {
        OkuM impl = new OkuM();
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl), abi.encodeCall(OkuM.initialize, ("Oku Money", "OkuM", address(0), 1e27))
        );

        vm.expectRevert(OkuM.ExceedsMaxTotalSupply.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuM.initialize, ("Oku Money", "OkuM", admin, Constants.MAX_TOTAL_SUPPLY + 1)
            )
        );
    }
}
