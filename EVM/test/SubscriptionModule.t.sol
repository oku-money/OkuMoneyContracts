// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {SubscriptionModule} from "../src/subscription/SubscriptionModule.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Errors} from "../src/lib/Errors.sol";
import {Roles} from "../src/lib/Roles.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/**
 * @title SubscriptionModuleTest
 * @notice Request lifecycle, escrow integrity, and the admin surface. The
 *         pricing rules themselves live in Differential.t.sol.
 */
contract SubscriptionModuleTest is BaseTest {
    // ============ Initialization ============

    function test_initialize_rejectsZeroAddresses() public {
        SubscriptionModule impl = new SubscriptionModule();

        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                SubscriptionModule.initialize, (address(0), address(usdc), admin, treasury)
            )
        );

        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                SubscriptionModule.initialize, (address(okuM), address(usdc), admin, address(0))
            )
        );
    }

    /// @dev Independent derivation of the decimal binding in more than one
    ///      contract is a silent pricing-divergence bug waiting to happen. The
    ///      module proves it agrees with OkuM rather than deriving its own.
    function test_initialize_rejectsAssetMismatch() public {
        MockUSDC other = new MockUSDC();
        SubscriptionModule impl = new SubscriptionModule();

        vm.expectPartialRevert(SubscriptionModule.AssetMismatch.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                SubscriptionModule.initialize, (address(okuM), address(other), admin, treasury)
            )
        );
    }

    // ============ Request bounds ============

    function test_request_rejectsZeroAmount() public {
        vm.startPrank(alice);
        vm.expectRevert(Errors.ZeroAmount.selector);
        module.requestSubscription(0, 0);

        vm.expectRevert(Errors.ZeroAmount.selector);
        module.requestRedemption(0, 0);
        vm.stopPrank();
    }

    /// @dev `amountIn`/`minOut` are uint96 for two-slot packing, but
    ///      MAX_TOTAL_SUPPLY (1e33) exceeds uint96 (~7.9e28) — so the bound is
    ///      checked explicitly rather than allowed to truncate silently.
    function test_request_rejectsAmountsExceedingUint96() public {
        uint256 tooBig = uint256(type(uint96).max) + 1;

        vm.prank(alice);
        vm.expectPartialRevert(SubscriptionModule.AmountExceedsRequestField.selector);
        module.requestRedemption(tooBig, 0);

        vm.prank(alice);
        vm.expectPartialRevert(SubscriptionModule.AmountExceedsRequestField.selector);
        module.requestRedemption(1e18, tooBig);
    }

    function test_request_blockedWhilePaused() public {
        vm.prank(admin);
        module.grantRole(Roles.SUB_PAUSER, pauser);
        vm.prank(pauser);
        module.pause();

        usdc.mint(alice, 100 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 100 * USDC_UNIT);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        module.requestSubscription(100 * USDC_UNIT, 0);
        vm.stopPrank();
    }

    /// @dev Pause blocks NEW requests only. Already-escrowed funds must stay
    ///      resolvable or an incident traps user money.
    function test_pausedStillAllowsFulfilAndReject() public {
        usdc.mint(alice, 100 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 100 * USDC_UNIT);
        uint256 id = module.requestSubscription(100 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.prank(admin);
        module.grantRole(Roles.SUB_PAUSER, pauser);
        vm.prank(pauser);
        module.pause();

        vm.prank(fulfiller);
        module.fulfillSubscription(id);
        assertGt(okuM.balanceOf(alice), 0, "escrow still resolvable while paused");
    }

    // ============ Lifecycle guards ============

    function test_fulfil_rejectsWrongDirection() public {
        usdc.mint(alice, 100 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 100 * USDC_UNIT);
        uint256 id = module.requestSubscription(100 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.prank(fulfiller);
        vm.expectRevert(SubscriptionModule.WrongDirection.selector);
        module.fulfillRedemption(id);
    }

    function test_fulfil_requiresFulfillerRole() public {
        usdc.mint(alice, 100 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 100 * USDC_UNIT);
        uint256 id = module.requestSubscription(100 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        module.fulfillSubscription(id);
    }

    function test_cancel_rejectsNonOwner() public {
        usdc.mint(alice, 100 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 100 * USDC_UNIT);
        uint256 id = module.requestSubscription(100 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.warp(block.timestamp + Constants.MIN_CANCEL_DELAY);
        vm.prank(bob);
        vm.expectRevert(SubscriptionModule.NotRequestOwner.selector);
        module.cancelRequest(id);
    }

    function test_redemptionExpiryBlocksFulfilment() public {
        uint256 raw = _subscribe(alice, 100 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(module), raw);
        uint256 id = module.requestRedemption(raw, 0);
        vm.stopPrank();

        vm.warp(block.timestamp + Constants.MAX_REQUEST_AGE + 1);
        vm.prank(fulfiller);
        vm.expectPartialRevert(SubscriptionModule.RequestExpired.selector);
        module.fulfillRedemption(id);
    }

    /// @dev An expired request is not stuck — the user reclaims it themselves.
    function test_expiredRequestIsStillCancellable() public {
        usdc.mint(alice, 100 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 100 * USDC_UNIT);
        uint256 id = module.requestSubscription(100 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.warp(block.timestamp + Constants.MAX_REQUEST_AGE + 1);
        vm.prank(alice);
        module.cancelRequest(id);
        assertEq(usdc.balanceOf(alice), 100 * USDC_UNIT, "refunded in full");
    }

    function test_redemptionSlippageEnforced() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        uint256 quoted = module.quoteRedemption(raw);

        vm.startPrank(alice);
        okuM.approve(address(module), raw);
        uint256 id = module.requestRedemption(raw, quoted + 1e6);
        vm.stopPrank();

        vm.prank(fulfiller);
        vm.expectPartialRevert(SubscriptionModule.SlippageExceeded.selector);
        module.fulfillRedemption(id);
    }

    // ============ Escrow ============

    function test_redemptionCancelRefundsOkuMExactly() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(module), raw);
        uint256 id = module.requestRedemption(raw, 0);
        vm.stopPrank();

        assertEq(okuM.balanceOf(alice), 0);
        assertEq(module.totalEscrowedOkuM(), raw);

        vm.warp(block.timestamp + Constants.MIN_CANCEL_DELAY);
        vm.prank(alice);
        module.cancelRequest(id);

        assertEq(okuM.balanceOf(alice), raw, "OkuM refunded to the wei");
        assertEq(module.totalEscrowedOkuM(), 0);
    }

    function test_sweep_ofForeignTokenIsUnrestricted() public {
        MockUSDC stray = new MockUSDC();
        stray.mint(address(module), 500e6);

        vm.prank(admin);
        module.sweepToken(address(stray), admin, 500e6);
        assertEq(stray.balanceOf(admin), 500e6);
    }

    function test_sweep_rejectsZeroRecipientAndRequiresRole() public {
        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        module.sweepToken(address(usdc), address(0), 0);

        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        module.sweepToken(address(usdc), alice, 0);
    }

    function test_sweep_cannotReachEscrowedOkuM() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(module), raw);
        module.requestRedemption(raw, 0);
        vm.stopPrank();

        vm.prank(admin);
        vm.expectPartialRevert(SubscriptionModule.CannotSweepBelowEscrow.selector);
        module.sweepToken(address(okuM), admin, 1);
    }

    // ============ Admin ============

    function test_setTreasury_rejectsZeroAndRequiresRole() public {
        vm.prank(admin);
        vm.expectRevert(Errors.ZeroAddress.selector);
        module.setTreasury(address(0));

        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        module.setTreasury(bob);

        vm.prank(admin);
        module.setTreasury(bob);
        assertEq(module.treasury(), bob);
    }

    function test_setFees_requiresRole() public {
        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        module.setFees(10, 10);
    }

    function test_feesAppliedOnRedemptionPayout() public {
        vm.prank(admin);
        module.setFees(0, 100); // 1% tout

        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(module), raw);
        uint256 id = module.requestRedemption(raw, 0);
        vm.stopPrank();

        vm.prank(fulfiller);
        module.fulfillRedemption(id);

        // 1% withheld from the payout; fees round UP against the caller.
        assertEq(usdc.balanceOf(alice), 990 * USDC_UNIT, "1% tout withheld");
    }

    function test_quotesAreFeeInclusive() public {
        vm.prank(admin);
        module.setFees(100, 100);

        // A fee-free quote would over-state output and mis-size every downstream
        // trade, so the quotes must already carry the fee.
        assertEq(module.quoteSubscription(1000 * USDC_UNIT), 990e18);
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        assertLt(module.quoteRedemption(raw), okuM.convertToAssets(raw));
    }

    // ============ Views ============

    function test_pendingRequestOfClearsOnEveryTerminalTransition() public {
        usdc.mint(alice, 300 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 300 * USDC_UNIT);

        uint256 a = module.requestSubscription(100 * USDC_UNIT, 0);
        vm.stopPrank();
        vm.prank(fulfiller);
        module.fulfillSubscription(a);
        assertEq(module.pendingRequestOf(alice, SubscriptionModule.Direction.Subscribe), 0);

        vm.prank(alice);
        uint256 b = module.requestSubscription(100 * USDC_UNIT, 0);
        vm.prank(fulfiller);
        module.rejectRequest(b, bytes32(0));
        assertEq(module.pendingRequestOf(alice, SubscriptionModule.Direction.Subscribe), 0);

        vm.prank(alice);
        uint256 c = module.requestSubscription(100 * USDC_UNIT, 0);
        vm.warp(block.timestamp + Constants.MIN_CANCEL_DELAY);
        vm.prank(alice);
        module.cancelRequest(c);
        assertEq(module.pendingRequestOf(alice, SubscriptionModule.Direction.Subscribe), 0);
    }

    function test_bothDirectionsCanBePendingSimultaneously() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        usdc.mint(alice, 100 * USDC_UNIT);

        vm.startPrank(alice);
        usdc.approve(address(module), 100 * USDC_UNIT);
        okuM.approve(address(module), raw);
        module.requestSubscription(100 * USDC_UNIT, 0);
        module.requestRedemption(raw, 0);
        vm.stopPrank();

        assertGt(module.pendingRequestOf(alice, SubscriptionModule.Direction.Subscribe), 0);
        assertGt(module.pendingRequestOf(alice, SubscriptionModule.Direction.Redeem), 0);
    }
}
