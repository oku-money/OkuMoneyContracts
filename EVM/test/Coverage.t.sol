// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {OkuM} from "../src/token/OkuM.sol";
import {USDOku} from "../src/token/USDOku.sol";
import {LitePSM} from "../src/psm/LitePSM.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Errors} from "../src/lib/Errors.sol";
import {Roles} from "../src/lib/Roles.sol";
import {ScaledUIAmountUpgradeable} from "../src/lib/ScaledUIAmountUpgradeable.sol";
import {ReentrancyGuardHarness} from "./mocks/ReentrancyGuardHarness.sol";
import {USDOkuUpdateHarness} from "./mocks/USDOkuUpdateHarness.sol";

/**
 * @title CoverageTest
 * @notice Accessors, admin paths, and defensive branches the behavioural suites do
 *         not reach naturally. Kept separate so those suites stay readable.
 */
contract CoverageTest is BaseTest {
    // ============ Accessors ============

    function test_accessors() public view {
        assertEq(address(psm.okuM()), address(okuM));
        assertEq(address(psm.usdc()), address(usdc));
        assertEq(address(usdOku.okuM()), address(okuM));
        assertEq(okuM.maxSupply(), INITIAL_MAX_SUPPLY);
        assertFalse(usdOku.isBlacklisted(alice));
        assertFalse(usdOku.accrualHalted());
        assertEq(usdOku.rateEnd(), block.timestamp);
        assertEq(usdOku.totalSupply(), 0);
        assertEq(usdOku.projectedIndexAtRateEnd(), Constants.PRECISION);
        assertEq(usdOku.projectedLiabilityAtRateEnd(), 0);
        assertEq(usdOku.realizedBacking(), 0);
        assertTrue(usdOku.backingCoversLiability());
        assertEq(usdOku.withdrawableSurplus(), 0);
    }

    function test_segmentAccessors() public {
        _setOkuMRate(500, 30 days);
        ScaledUIAmountUpgradeable.Segment memory active = okuM.activeSegment();
        ScaledUIAmountUpgradeable.Segment memory pending = okuM.pendingSegment();

        assertEq(active.ratePerSecond, _rateFor(500));
        assertEq(pending.ratePerSecond, _rateFor(500));
        assertEq(okuM.rateEnd(), active.endTime);
        assertEq(uint256(active.endTime), block.timestamp + 30 days);

        // A future segment is pending but not yet active. Its base must be the index
        // AT the future anchor, not at now — otherwise the curve would step DOWN when
        // it takes effect, which the continuity check correctly refuses.
        uint64 future = uint64(block.timestamp + 10 days);
        uint256 base = okuM.indexAt(future);
        assertGt(base, okuM.uiMultiplier(), "the anchor value is ahead of today's");
        vm.prank(rateSetter);
        okuM.setOkuMRate(base, _rateFor(800), future, future + uint64(20 days), 0);

        assertEq(okuM.pendingSegment().ratePerSecond, _rateFor(800), "pending is the new one");
        assertEq(okuM.activeSegment().ratePerSecond, _rateFor(500), "active is still the old one");
        assertEq(okuM.rateEnd(), okuM.activeSegment().endTime);
    }

    // ============ Permit on both tokens, both blacklist sides ============

    function test_okuMPermitAndBlacklistSides() public {
        uint256 pk = 0xA11CE;
        address owner = vm.addr(pk);
        uint256 deadline = block.timestamp + 1 days;

        (uint8 v, bytes32 r, bytes32 s) =
            _signPermit(pk, okuM.DOMAIN_SEPARATOR(), owner, bob, 1e18, okuM.nonces(owner), deadline);
        okuM.permit(owner, bob, 1e18, deadline, v, r, s);
        assertEq(okuM.allowance(owner, bob), 1e18);

        vm.prank(admin);
        okuM.blacklist(bob);
        (v, r, s) = _signPermit(
            pk, okuM.DOMAIN_SEPARATOR(), owner, bob, 2e18, okuM.nonces(owner), deadline
        );
        vm.expectRevert(OkuM.RecipientBlacklisted.selector);
        okuM.permit(owner, bob, 2e18, deadline, v, r, s);

        vm.prank(admin);
        okuM.blacklist(owner);
        (v, r, s) = _signPermit(
            pk, okuM.DOMAIN_SEPARATOR(), owner, alice, 1e18, okuM.nonces(owner), deadline
        );
        vm.expectRevert(OkuM.SenderBlacklisted.selector);
        okuM.permit(owner, alice, 1e18, deadline, v, r, s);
    }

    function test_usdOkuPermitAndBlacklistSides() public {
        uint256 pk = 0xB0B;
        address owner = vm.addr(pk);
        uint256 deadline = block.timestamp + 1 days;

        (uint8 v, bytes32 r, bytes32 s) = _signPermit(
            pk, usdOku.DOMAIN_SEPARATOR(), owner, alice, 1e18, usdOku.nonces(owner), deadline
        );
        usdOku.permit(owner, alice, 1e18, deadline, v, r, s);
        assertEq(usdOku.allowance(owner, alice), 1e18);

        vm.prank(admin);
        usdOku.blacklist(alice);
        (v, r, s) = _signPermit(
            pk, usdOku.DOMAIN_SEPARATOR(), owner, alice, 2e18, usdOku.nonces(owner), deadline
        );
        vm.expectRevert(USDOku.RecipientBlacklisted.selector);
        usdOku.permit(owner, alice, 2e18, deadline, v, r, s);

        vm.prank(admin);
        usdOku.blacklist(owner);
        (v, r, s) = _signPermit(
            pk, usdOku.DOMAIN_SEPARATOR(), owner, bob, 1e18, usdOku.nonces(owner), deadline
        );
        vm.expectRevert(USDOku.SenderBlacklisted.selector);
        usdOku.permit(owner, bob, 1e18, deadline, v, r, s);
    }

    // ============ USDOku blacklist on every value path ============

    function test_usdOkuBlacklistBlocksWrapUnwrapAndTransfer() public {
        _fundBuffer(200_000 * USDC_UNIT);
        _fundVault(20_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 10_000 * USDC_UNIT);
        _wrap(alice, raw);

        vm.prank(admin);
        usdOku.blacklist(alice);

        uint256 bal = usdOku.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(USDOku.SenderBlacklisted.selector);
        usdOku.unwrap(bal, alice);

        vm.prank(alice);
        vm.expectRevert(USDOku.SenderBlacklisted.selector);
        usdOku.transfer(bob, 1);

        uint256 raw2 = _mint(bob, 1000 * USDC_UNIT);
        vm.startPrank(bob);
        IERC20(address(okuM)).approve(address(usdOku), raw2);
        vm.expectRevert(USDOku.RecipientBlacklisted.selector);
        usdOku.wrap(raw2, alice, 0);
        vm.stopPrank();

        vm.prank(admin);
        vm.expectRevert(USDOku.AlreadyBlacklisted.selector);
        usdOku.blacklist(alice);

        vm.prank(admin);
        usdOku.unblacklist(alice);
        vm.prank(admin);
        vm.expectRevert(USDOku.NotBlacklisted.selector);
        usdOku.unblacklist(alice);
    }

    function test_usdOkuTransferFromSpendsAllowance() public {
        _fundBuffer(200_000 * USDC_UNIT);
        _fundVault(20_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 10_000 * USDC_UNIT);
        _wrap(alice, raw);

        uint256 send = usdOku.balanceOf(alice) / 2;
        vm.prank(alice);
        usdOku.approve(bob, send);

        vm.prank(bob);
        usdOku.transferFrom(alice, bob, send);
        assertEq(usdOku.allowance(alice, bob), 0, "allowance consumed");
        assertApproxEqAbs(usdOku.balanceOf(bob), send, 2);
    }

    // ============ USDOku privileged mint / burn ============

    function test_privilegedShareMintAndBurn() public {
        vm.startPrank(admin);
        usdOku.grantRole(Roles.OKUM_MINTER, admin);
        usdOku.grantRole(Roles.OKUM_BURNER, admin);
        usdOku.mint(alice, 1000e18);
        vm.stopPrank();
        assertEq(usdOku.sharesOf(alice), 1000e18);

        vm.prank(admin);
        usdOku.burn(alice, 400e18);
        assertEq(usdOku.sharesOf(alice), 600e18);

        vm.prank(admin);
        vm.expectRevert(Errors.InsufficientBalance.selector);
        usdOku.burn(alice, 1000e18);

        vm.prank(admin);
        usdOku.blacklist(bob);
        vm.prank(admin);
        vm.expectRevert(USDOku.RecipientBlacklisted.selector);
        usdOku.mint(bob, 1);

        vm.prank(admin);
        vm.expectRevert(USDOku.SenderBlacklisted.selector);
        usdOku.burn(bob, 1);
    }

    // ============ USDOku rate bounds + halt ============

    function test_usdOkuRateBoundsAndHalt() public {
        uint256 base = usdOku.usdOkuIndex();
        uint64 s = uint64(block.timestamp);

        vm.prank(rateSetter);
        vm.expectRevert(USDOku.RateOutOfBounds.selector);
        usdOku.setUsdOkuRate(base, Constants.MAX_RATE_PER_SECOND + 1, s, s + 1 days);

        vm.prank(rateSetter);
        vm.expectRevert(USDOku.InvalidRateWindow.selector);
        usdOku.setUsdOkuRate(
            base, Constants.PRECISION, s, s + uint64(Constants.MAX_RATE_DURATION) + 1
        );

        uint64 farOut = uint64(block.timestamp + Constants.MAX_SCHEDULE_LEAD + 1);
        vm.prank(rateSetter);
        vm.expectRevert(USDOku.ScheduledTooFarAhead.selector);
        usdOku.setUsdOkuRate(base, Constants.PRECISION, farOut, farOut + 1 days);

        vm.prank(rateSetter);
        vm.expectRevert(USDOku.IndexCannotDecrease.selector);
        usdOku.setUsdOkuRate(base - 1, Constants.PRECISION, s, s + 1 days);

        vm.prank(rateSetter);
        vm.expectRevert(USDOku.IndexTooHigh.selector);
        usdOku.setUsdOkuRate(Constants.MAX_MULTIPLIER + 1, Constants.PRECISION, s, s + 1 days);

        // Halt latch.
        vm.prank(admin);
        usdOku.haltAccrual();
        vm.prank(admin);
        vm.expectRevert(USDOku.AlreadyHalted.selector);
        usdOku.haltAccrual();

        vm.prank(rateSetter);
        vm.expectRevert(USDOku.AccrualIsHalted.selector);
        usdOku.setUsdOkuRate(base, Constants.PRECISION, s, s + 1 days);

        vm.prank(admin);
        usdOku.resumeAccrual();
        vm.prank(admin);
        vm.expectRevert(USDOku.NotHalted.selector);
        usdOku.resumeAccrual();
    }

    function test_usdOkuPauseBlocksWrapUnwrapAndTransfer() public {
        _fundBuffer(200_000 * USDC_UNIT);
        _fundVault(20_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 10_000 * USDC_UNIT);
        _wrap(alice, raw);
        uint256 bal = usdOku.balanceOf(alice);

        vm.prank(admin);
        usdOku.pause();

        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        usdOku.unwrap(bal, alice);

        vm.prank(alice);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        usdOku.transfer(bob, 1);

        vm.prank(admin);
        usdOku.unpause();
        vm.prank(alice);
        usdOku.unwrap(bal, alice);
    }

    function test_usdOkuZeroAndDustGuards() public {
        vm.prank(alice);
        vm.expectRevert(Errors.ZeroAmount.selector);
        usdOku.wrap(0, alice, 0);

        vm.prank(alice);
        vm.expectRevert(Errors.ZeroAddress.selector);
        usdOku.wrap(1e18, address(0), 0);

        vm.prank(alice);
        vm.expectRevert(Errors.ZeroAmount.selector);
        usdOku.unwrap(0, alice);

        vm.prank(alice);
        vm.expectRevert(Errors.ZeroAddress.selector);
        usdOku.unwrap(1e18, address(0));

        vm.prank(alice);
        vm.expectRevert(Errors.ZeroAmount.selector);
        usdOku.depositReserves(0);

        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        usdOku.withdrawSurplus(address(0), 1);

        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAmount.selector);
        usdOku.withdrawSurplus(treasury, 0);

        vm.prank(admin);
        vm.expectRevert(USDOku.InsufficientReserves.selector);
        usdOku.withdrawSurplus(treasury, 1e18);
    }

    function test_wrapSlippageFloorIsCheckedAfterRounding() public {
        _fundBuffer(200_000 * USDC_UNIT);
        _fundVault(20_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 10_000 * USDC_UNIT);

        uint256 dollars = okuM.toUIAmount(raw);
        vm.startPrank(alice);
        IERC20(address(okuM)).approve(address(usdOku), raw);
        vm.expectPartialRevert(USDOku.OutputBelowMinimum.selector);
        usdOku.wrap(raw, alice, dollars + 1e18);
        vm.stopPrank();
    }

    function test_unwrapRequiresSufficientShares() public {
        _fundBuffer(200_000 * USDC_UNIT);
        _fundVault(20_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 1000 * USDC_UNIT);
        _wrap(alice, raw);

        uint256 tooMuch = usdOku.balanceOf(alice) * 2;
        vm.prank(alice);
        vm.expectRevert(Errors.InsufficientBalance.selector);
        usdOku.unwrap(tooMuch, alice);
    }

    // ============ Unreachable-by-design guards ============

    /// @dev `USDOku._update` reverts unconditionally so a future refactor reaching
    ///      ERC20's inherited `_mint`/`_burn`/`_transfer` fails loudly rather than
    ///      silently diverging the share ledger from the balance mapping. Unreachable
    ///      by design, hence the harness.
    function test_usdOkuUpdateHookAlwaysReverts() public {
        USDOkuUpdateHarness h = new USDOkuUpdateHarness();

        vm.expectRevert(USDOku.UsePrivilegedMintBurn.selector);
        h.exposedUpdate(address(0), alice, 1e18);
        vm.expectRevert(USDOku.UsePrivilegedMintBurn.selector);
        h.exposedUpdate(alice, address(0), 1e18);
        vm.expectRevert(USDOku.UsePrivilegedMintBurn.selector);
        h.exposedUpdate(alice, bob, 1e18);
        vm.expectRevert(USDOku.UsePrivilegedMintBurn.selector);
        h.exposedUpdate(alice, bob, 0);
    }

    function test_reentrancyGuardBlocksReentry() public {
        ReentrancyGuardHarness h = new ReentrancyGuardHarness();
        h.initialize();
        h.safeCall();
        assertEq(h.counter(), 1);
        vm.expectRevert();
        h.reenter();
    }

    // ============ Upgrade authorization ============

    function test_upgradeIsRoleGatedOnEveryProxy() public {
        address newOkuM = address(new OkuM());
        address newUsdOku = address(new USDOku());
        address newPsm = address(new LitePSM());

        vm.startPrank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        okuM.upgradeToAndCall(newOkuM, "");
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.upgradeToAndCall(newUsdOku, "");
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        psm.upgradeToAndCall(newPsm, "");
        vm.stopPrank();

        uint256 supplyBefore = okuM.totalSupply();
        vm.prank(admin);
        okuM.upgradeToAndCall(newOkuM, "");
        assertEq(okuM.totalSupply(), supplyBefore, "state survives the upgrade");

        vm.prank(admin);
        usdOku.upgradeToAndCall(newUsdOku, "");
    }

    // ============ PSM remainder ============

    function test_psmUnpauseRoundTrip() public {
        vm.prank(admin);
        psm.pause();
        assertTrue(psm.paused());
        vm.prank(admin);
        psm.unpause();
        assertFalse(psm.paused());
    }

    function test_okuMMintRejectsBlacklistedRecipient() public {
        vm.prank(admin);
        okuM.blacklist(bob);
        vm.prank(admin);
        vm.expectRevert(OkuM.RecipientBlacklisted.selector);
        okuM.mint(bob, 1e18);
    }

    function test_okuMBurnRejectsBlacklistedCaller() public {
        vm.prank(admin);
        okuM.configureMinterAllowance(admin, 1e18);
        vm.prank(admin);
        okuM.mint(admin, 1e18);
        vm.prank(admin);
        okuM.blacklist(admin);
        vm.prank(admin);
        vm.expectRevert(OkuM.SenderBlacklisted.selector);
        okuM.burn(1e18);
    }

    function test_configureMinterAllowanceRejectsZeroAddress() public {
        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        okuM.configureMinterAllowance(address(0), 1);
    }

    function test_setMaxSupplyRejectsBelowCurrentSupply() public {
        _fundBuffer(100_000 * USDC_UNIT);
        _mint(alice, 1000 * USDC_UNIT);
        uint256 supply = okuM.totalSupply();
        vm.prank(admin);
        vm.expectRevert(OkuM.BelowCurrentSupply.selector);
        okuM.setMaxSupply(supply - 1);
    }

    /// @dev The remaining blacklist sides, plus `indexAt`'s external dispatch. Each
    ///      is only ever reached internally in production, so the external path and
    ///      the opposite-party branches go untested without deliberate coverage.
    function test_remainingBlacklistBranchesAndExternalIndexAt() public {
        _fundBuffer(200_000 * USDC_UNIT);
        _fundVault(20_000 * USDC_UNIT);

        // `indexAt` called externally, before and after the anchor.
        assertEq(usdOku.indexAt(block.timestamp - 1), Constants.PRECISION, "flat before anchor");
        _setUsdOkuRate(500, 30 days);
        assertGt(
            usdOku.indexAt(block.timestamp + 10 days),
            usdOku.indexAt(block.timestamp),
            "accrues forward"
        );

        uint256 raw = _mint(alice, 10_000 * USDC_UNIT);
        _wrap(alice, raw);

        // transfer -> blacklisted RECIPIENT (the sender-side branch is covered above).
        vm.prank(admin);
        usdOku.blacklist(bob);
        vm.prank(alice);
        vm.expectRevert(USDOku.RecipientBlacklisted.selector);
        usdOku.transfer(bob, 1e18);

        // wrap -> blacklisted CALLER.
        uint256 raw2 = _mint(bob, 1000 * USDC_UNIT);
        vm.startPrank(bob);
        IERC20(address(okuM)).approve(address(usdOku), raw2);
        vm.expectRevert(USDOku.SenderBlacklisted.selector);
        usdOku.wrap(raw2, bob, 0);
        vm.stopPrank();

        // unwrap -> blacklisted RECEIVER, distinct from a blacklisted caller. Without
        // this check a user blacklisted only on USDOku could still route OkuM to a
        // third party via `unwrap(amount, victim)`.
        uint256 bal = usdOku.balanceOf(alice);
        vm.prank(alice);
        vm.expectRevert(USDOku.RecipientBlacklisted.selector);
        usdOku.unwrap(bal, bob);
    }
}
