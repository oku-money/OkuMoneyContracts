// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {USDOku} from "../src/token/USDOku.sol";
import {OkuM} from "../src/token/OkuM.sol";
import {USDOkuWrapper} from "../src/wrapper/USDOkuWrapper.sol";
import {SubscriptionModule} from "../src/subscription/SubscriptionModule.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Errors} from "../src/lib/Errors.sol";
import {Roles} from "../src/lib/Roles.sol";
import {ReentrancyGuardHarness} from "./mocks/ReentrancyGuardHarness.sol";
import {USDOkuUpdateHarness} from "./mocks/USDOkuUpdateHarness.sol";

/**
 * @title CoverageTest
 * @notice Accessors, admin paths and defensive branches that the behavioural
 *         suites do not naturally reach. Kept separate so the intent of those
 *         suites stays readable.
 */
contract CoverageTest is BaseTest {
    // ============ Accessors ============

    function test_moduleAccessors() public view {
        assertEq(address(module.okuM()), address(okuM));
        assertEq(address(module.usdc()), address(usdc));
        assertEq(module.treasury(), treasury);
        assertEq(module.tinBps(), 0);
        assertEq(module.toutBps(), 0);
        assertEq(module.totalEscrowedUsdc(), 0);
        assertEq(module.totalEscrowedOkuM(), 0);
        assertEq(module.getRequest(999).user, address(0));
        assertFalse(module.paused());
    }

    function test_usdOkuAccessors() public view {
        assertEq(usdOku.wrapper(), address(wrapper));
        assertFalse(usdOku.isBlacklisted(alice));
        assertEq(usdOku.usdBaseIndex(), Constants.PRECISION);
        assertEq(usdOku.usdRatePerSecond(), Constants.PRECISION);
        assertGt(usdOku.usdLastAccrualTime(), 0);
        assertFalse(usdOku.accrualHalted());
        assertEq(usdOku.totalShares(), 0);
    }

    function test_okuMAccessors() public view {
        assertFalse(okuM.isBlacklisted(alice));
        assertEq(okuM.maxSupply(), MAX_SUPPLY);
        assertEq(okuM.syncEpoch(), 0);
        assertFalse(okuM.accrualHalted());
    }

    /// @dev Falls through to AccessControl's ERC-165 for an unknown id.
    function test_supportsInterfaceFallthrough() public view {
        assertTrue(module.supportsInterface(type(IAccessControl).interfaceId));
        assertFalse(module.supportsInterface(0xdeadbeef));
        assertTrue(okuM.supportsInterface(type(IAccessControl).interfaceId));
        assertFalse(okuM.supportsInterface(0xdeadbeef));
    }

    // ============ projectedIndexAtRateEnd ============

    function test_projectedIndexDuringLiveSegment() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();
        _prefundWrapper(50 * USDC_UNIT);

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(1000), block.timestamp + 30 days);

        // Mid-segment the projection must lead the live index.
        vm.warp(block.timestamp + 5 days);
        assertGt(usdOku.projectedIndexAtRateEnd(), usdOku.usdOkuIndex(), "leads mid-segment");

        // Past rateEnd they converge.
        vm.warp(block.timestamp + 30 days);
        assertEq(usdOku.projectedIndexAtRateEnd(), usdOku.usdOkuIndex(), "converges after end");
    }

    // ============ USDOku permit ============

    function test_usdOkuPermit() public {
        uint256 pk = 0xB0B;
        address owner = vm.addr(pk);
        uint256 deadline = block.timestamp + 1 days;

        bytes32 structHash = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                alice,
                1e18,
                usdOku.nonces(owner),
                deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", usdOku.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        usdOku.permit(owner, alice, 1e18, deadline, v, r, s);
        assertEq(usdOku.allowance(owner, alice), 1e18);

        // Blacklisted spender is rejected.
        vm.prank(admin);
        usdOku.blacklist(alice);
        bytes32 h2 = keccak256(
            abi.encode(
                keccak256(
                    "Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"
                ),
                owner,
                alice,
                1e18,
                usdOku.nonces(owner),
                deadline
            )
        );
        bytes32 d2 = keccak256(abi.encodePacked("\x19\x01", usdOku.DOMAIN_SEPARATOR(), h2));
        (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(pk, d2);
        vm.expectRevert(USDOku.RecipientBlacklisted.selector);
        usdOku.permit(owner, alice, 1e18, deadline, v2, r2, s2);
    }

    // ============ Blacklist on mint/burn paths ============

    function test_usdOkuMintRejectsBlacklistedRecipient() public {
        vm.prank(admin);
        usdOku.blacklist(bob);
        vm.prank(admin);
        vm.expectRevert(USDOku.RecipientBlacklisted.selector);
        usdOku.mint(bob, 1e18);
    }

    function test_usdOkuBurnRejectsBlacklistedSource() public {
        uint256 raw = _subscribe(alice, 100 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        vm.prank(admin);
        usdOku.blacklist(alice);
        vm.prank(admin);
        vm.expectRevert(USDOku.SenderBlacklisted.selector);
        usdOku.burn(alice, 1e18);
    }

    // ============ Solvency sentinel branch ============

    /// @dev backing == 0 with a non-zero projected liability. Unreachable under
    ///      pre-funding, but the setter must still fail closed rather than
    ///      divide by zero.
    function test_setRateRevertsWhenBackingIsZeroButLiabilityIsNot() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        uint256 reserves = okuM.balanceOf(address(wrapper));
        vm.prank(address(wrapper));
        // forge-lint: disable-next-line(erc20-unchecked-transfer)
        okuM.transfer(bob, reserves);

        assertEq(wrapper.realizedBacking(), 0);
        vm.prank(rateSetter);
        vm.expectPartialRevert(USDOku.SolvencyGapExceeded.selector);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(100), block.timestamp + 1 days);
    }

    // ============ Fee bound: tout leg ============

    function test_setFeesRejectsToutAboveMaximum() public {
        vm.prank(admin);
        vm.expectPartialRevert(SubscriptionModule.FeeAboveMaximum.selector);
        module.setFees(0, Constants.MAX_FEE_BPS + 1);
    }

    // ============ Pause / unpause round trip ============

    function test_modulePauseUnpauseRoundTrip() public {
        vm.startPrank(admin);
        module.pause();
        assertTrue(module.paused());
        module.unpause();
        assertFalse(module.paused());
        vm.stopPrank();
    }

    // ============ Upgrade authorization ============

    function test_upgradeAuthorizationIsRoleGatedOnEveryProxy() public {
        address newOkuM = address(new OkuM());
        address newUsdOku = address(new USDOku());
        address newWrapper = address(new USDOkuWrapper());
        address newModule = address(new SubscriptionModule());

        vm.startPrank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        okuM.upgradeToAndCall(newOkuM, "");
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        usdOku.upgradeToAndCall(newUsdOku, "");
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        wrapper.upgradeToAndCall(newWrapper, "");
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        module.upgradeToAndCall(newModule, "");
        vm.stopPrank();

        // The holder can upgrade, and state survives.
        uint256 supplyBefore = okuM.totalSupply();
        vm.prank(admin);
        okuM.upgradeToAndCall(newOkuM, "");
        assertEq(okuM.totalSupply(), supplyBefore, "state preserved across upgrade");
        assertEq(okuM.uiMultiplier(), Constants.PRECISION);
    }

    // ============ ReentrancyGuard ============

    function test_reentrancyGuardBlocksReentry() public {
        ReentrancyGuardHarness h = new ReentrancyGuardHarness();
        h.initialize();
        h.safeCall();
        assertEq(h.counter(), 1);

        vm.expectRevert();
        h.reenter();
    }

    // ============ Defensive branches unreachable from production paths ============

    /// @dev `USDOku._update` reverts unconditionally: every supply change goes
    ///      through mint/burn, which manage `usdShares` directly, and the ERC-20
    ///      write paths are all overridden. The guard exists so a future refactor
    ///      that routes through `_mint`/`_burn`/`_transfer` fails loudly instead
    ///      of silently diverging the share ledger from the balance mapping.
    ///      Unreachable by design, hence the harness.
    function test_usdOkuUpdateHookAlwaysReverts() public {
        USDOkuUpdateHarness h = new USDOkuUpdateHarness();

        // All three shapes the inherited hook is called with: mint, burn, transfer.
        vm.expectRevert(USDOku.UsePrivilegedMintBurn.selector);
        h.exposedUpdate(address(0), alice, 1e18);

        vm.expectRevert(USDOku.UsePrivilegedMintBurn.selector);
        h.exposedUpdate(alice, address(0), 1e18);

        vm.expectRevert(USDOku.UsePrivilegedMintBurn.selector);
        h.exposedUpdate(alice, bob, 1e18);

        // Zero-value is not an exemption.
        vm.expectRevert(USDOku.UsePrivilegedMintBurn.selector);
        h.exposedUpdate(alice, bob, 0);
    }

    /// @dev `permit` checks owner and spender separately. Each token's suite
    ///      covered one side; these cover the other, so neither check can be
    ///      dropped without a failure.
    function test_okuMPermitRejectsBlacklistedSpender() public {
        uint256 pk = 0xA11CE;
        address owner = vm.addr(pk);
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(admin);
        okuM.blacklist(bob);

        (uint8 v, bytes32 r, bytes32 s) =
            _signPermit(pk, okuM.DOMAIN_SEPARATOR(), owner, bob, 1e18, okuM.nonces(owner), deadline);

        vm.expectRevert(OkuM.RecipientBlacklisted.selector);
        okuM.permit(owner, bob, 1e18, deadline, v, r, s);
    }

    function test_usdOkuPermitRejectsBlacklistedOwner() public {
        uint256 pk = 0xB0B5;
        address owner = vm.addr(pk);
        uint256 deadline = block.timestamp + 1 days;

        vm.prank(admin);
        usdOku.blacklist(owner);

        (uint8 v, bytes32 r, bytes32 s) = _signPermit(
            pk, usdOku.DOMAIN_SEPARATOR(), owner, alice, 1e18, usdOku.nonces(owner), deadline
        );

        vm.expectRevert(USDOku.SenderBlacklisted.selector);
        usdOku.permit(owner, alice, 1e18, deadline, v, r, s);
    }

    /// @dev `projectedLiabilityAtRateEnd` is only ever reached internally in
    ///      production (`wrap`, `withdrawSurplus`, `withdrawableSurplus`), so the
    ///      external dispatch path is untested and the file misses its 100% gate.
    ///      It is also a published view an operator reads directly, so the
    ///      external call is worth asserting on its own terms.
    function test_projectedLiabilityAtRateEnd_externalCall() public {
        // No shares outstanding: nothing is owed at rateEnd.
        assertEq(wrapper.projectedLiabilityAtRateEnd(), 0, "zero shares owes nothing");

        // Pre-fund, wrap so shares exist, then declare a forward rate.
        _prefundWrapper(10_000e6);
        uint256 raw = _subscribe(alice, 1000e6);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(500), block.timestamp + 30 days);
        vm.warp(block.timestamp + 1 days);

        uint256 spot = wrapper.declaredLiability();
        uint256 projected = wrapper.projectedLiabilityAtRateEnd();

        // The fixture must be non-degenerate, or the assertion below is vacuous.
        assertGt(spot, 0, "fixture has liability");
        assertGt(projected, spot, "projection must exceed spot mid-segment");

        // And the projection is what backing is actually required to cover.
        assertGe(wrapper.realizedBacking(), projected, "pre-funded to rateEnd");
    }
}
