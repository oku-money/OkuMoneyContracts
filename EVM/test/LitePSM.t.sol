// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {
    PausableUpgradeable
} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {LitePSM} from "../src/psm/LitePSM.sol";
import {Constants} from "../src/lib/Constants.sol";
import {Errors} from "../src/lib/Errors.sol";
import {MockHighDecimalToken} from "./mocks/MockHighDecimalToken.sol";

contract LitePSMTest is BaseTest {
    // ============ The bound ============

    /// @dev THE property of this contract: exposure is the buffer, per chain. An
    ///      exhausted window reverts rather than queueing. That is the design, not a
    ///      degraded mode — it removes FIFO fairness, stranded users, and the flaw
    ///      where pausing to stop an outflow also froze payouts to those in line.
    function test_redemptionIsBoundedByTheBufferAndRevertsCleanly() public {
        _fundBuffer(100_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 500_000 * USDC_UNIT);

        // The buffer now holds its seed plus alice's mint proceeds.
        uint256 available = psm.availableToRedeem();
        assertEq(available, 600_000 * USDC_UNIT, "mint proceeds join the buffer");

        // Drain it, then confirm the next redemption fails loudly rather than queueing.
        vm.startPrank(alice);
        IERC20(address(okuM)).approve(address(psm), raw);
        psm.redeemOkuM(raw, 0);
        vm.stopPrank();

        uint256 rawB = _mint(bob, 10_000 * USDC_UNIT);
        // Hoisted above the prank: an inline read would consume it.
        uint256 toDrain = psm.availableToRedeem();
        vm.prank(admin);
        psm.withdrawBuffer(treasury, toDrain);

        vm.startPrank(bob);
        IERC20(address(okuM)).approve(address(psm), rawB);
        vm.expectPartialRevert(LitePSM.InsufficientBuffer.selector);
        psm.redeemOkuM(rawB, 0);
        vm.stopPrank();
    }

    function test_availableToRedeemReportsZeroWhenClosedOrPaused() public {
        _fundBuffer(100_000 * USDC_UNIT);
        assertGt(psm.availableToRedeem(), 0);

        vm.prank(gatekeeper);
        psm.setRedeemEnabled(false);
        assertEq(psm.availableToRedeem(), 0, "closed window advertises nothing");

        vm.prank(gatekeeper);
        psm.setRedeemEnabled(true);
        vm.prank(admin);
        psm.pause();
        assertEq(psm.availableToRedeem(), 0, "paused advertises nothing");
    }

    // ============ KMS gates ============

    function test_mintAndRedeemGateIndependently() public {
        _fundBuffer(100_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 10_000 * USDC_UNIT);

        // Close mint only. Redemption must stay open — never trap holders on the way
        // out just because entry is shut.
        vm.prank(gatekeeper);
        psm.setMintEnabled(false);

        usdc.mint(bob, 1000 * USDC_UNIT);
        vm.startPrank(bob);
        usdc.approve(address(psm), 1000 * USDC_UNIT);
        vm.expectRevert(LitePSM.MintDisabled.selector);
        psm.mintOkuM(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.startPrank(alice);
        IERC20(address(okuM)).approve(address(psm), raw);
        psm.redeemOkuM(raw, 0);
        vm.stopPrank();

        // And the converse.
        vm.startPrank(gatekeeper);
        psm.setMintEnabled(true);
        psm.setRedeemEnabled(false);
        vm.stopPrank();

        uint256 raw2 = _mint(bob, 1000 * USDC_UNIT);
        vm.startPrank(bob);
        IERC20(address(okuM)).approve(address(psm), raw2);
        vm.expectRevert(LitePSM.RedeemDisabled.selector);
        psm.redeemOkuM(raw2, 0);
        vm.stopPrank();
    }

    function test_gatesAreRoleGated() public {
        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        psm.setMintEnabled(false);

        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        psm.closeWindow();
    }

    /// @dev A fresh deployment starts CLOSED so the first rate segment can be
    ///      published before anyone can trade against a default multiplier.
    function test_freshDeploymentStartsClosed() public {
        LitePSM fresh = LitePSM(
            address(
                new ERC1967Proxy(
                    address(new LitePSM()),
                    abi.encodeCall(LitePSM.initialize, (address(okuM), address(usdc), admin))
                )
            )
        );
        assertFalse(fresh.mintEnabled());
        assertFalse(fresh.redeemEnabled());
        assertFalse(fresh.conversionsOpen());
    }

    function test_conversionsOpenTracksEitherSide() public {
        vm.prank(gatekeeper);
        psm.closeWindow();
        assertFalse(psm.conversionsOpen());

        vm.prank(gatekeeper);
        psm.setMintEnabled(true);
        assertTrue(psm.conversionsOpen(), "either side open counts as open");

        vm.prank(gatekeeper);
        psm.closeWindow();
        vm.prank(gatekeeper);
        psm.setRedeemEnabled(true);
        assertTrue(psm.conversionsOpen());
    }

    // ============ Pricing ============

    function test_quotesMatchExecution() public {
        _fundBuffer(200_000 * USDC_UNIT);
        _setOkuMRate(500, 30 days);
        vm.warp(block.timestamp + 9 days);

        uint256 spend = 12_345 * USDC_UNIT;
        uint256 quotedMint = psm.quoteMint(spend);
        uint256 actualMint = _mint(alice, spend);
        assertEq(actualMint, quotedMint, "quoteMint is exact");

        uint256 quotedRedeem = psm.quoteRedeem(actualMint);
        vm.startPrank(alice);
        IERC20(address(okuM)).approve(address(psm), actualMint);
        uint256 actualRedeem = psm.redeemOkuM(actualMint, 0);
        vm.stopPrank();
        assertEq(actualRedeem, quotedRedeem, "quoteRedeem is exact");
    }

    function test_slippageFloorsAreEnforced() public {
        _fundBuffer(200_000 * USDC_UNIT);
        uint256 spend = 1000 * USDC_UNIT;
        uint256 quoted = psm.quoteMint(spend);

        usdc.mint(alice, spend);
        vm.startPrank(alice);
        usdc.approve(address(psm), spend);
        vm.expectPartialRevert(LitePSM.OutputBelowMinimum.selector);
        psm.mintOkuM(spend, quoted + 1);
        vm.stopPrank();
    }

    function test_dustRoundsToZeroAndReverts() public {
        _setOkuMRate(500, 30 days);
        vm.warp(block.timestamp + 30 days);

        // One raw wei of OkuM is worth far less than one USDC unit.
        _fundBuffer(1000 * USDC_UNIT);
        uint256 raw = _mint(alice, 1000 * USDC_UNIT);
        assertGt(raw, 0);

        vm.startPrank(alice);
        IERC20(address(okuM)).approve(address(psm), 1);
        vm.expectRevert(LitePSM.AmountTooSmall.selector);
        psm.redeemOkuM(1, 0);
        vm.stopPrank();
    }

    function test_zeroAmountsRevert() public {
        vm.prank(alice);
        vm.expectRevert(Errors.ZeroAmount.selector);
        psm.mintOkuM(0, 0);

        vm.prank(alice);
        vm.expectRevert(Errors.ZeroAmount.selector);
        psm.redeemOkuM(0, 0);
    }

    // ============ Buffer administration ============

    function test_bufferDepositIsPermissionlessWithdrawIsNot() public {
        usdc.mint(alice, 5000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(psm), 5000 * USDC_UNIT);
        psm.depositBuffer(5000 * USDC_UNIT);
        vm.stopPrank();
        assertEq(psm.availableToRedeem(), 5000 * USDC_UNIT);

        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        psm.withdrawBuffer(alice, 1);
    }

    /// @dev Not pause-gated on purpose: during an incident the buffer withdrawer may
    ///      need to move USDC to safety precisely while the PSM is paused. Safe here
    ///      because there is no queue obligation to strand.
    function test_bufferWithdrawWorksWhilePaused() public {
        _fundBuffer(10_000 * USDC_UNIT);
        vm.prank(admin);
        psm.pause();

        vm.prank(admin);
        psm.withdrawBuffer(treasury, 10_000 * USDC_UNIT);
        assertEq(usdc.balanceOf(treasury), 10_000 * USDC_UNIT);
    }

    function test_pauseBlocksBothConversions() public {
        _fundBuffer(100_000 * USDC_UNIT);
        uint256 raw = _mint(alice, 1000 * USDC_UNIT);

        vm.prank(admin);
        psm.pause();

        usdc.mint(bob, 100 * USDC_UNIT);
        vm.startPrank(bob);
        usdc.approve(address(psm), 100 * USDC_UNIT);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        psm.mintOkuM(100 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.startPrank(alice);
        IERC20(address(okuM)).approve(address(psm), raw);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        psm.redeemOkuM(raw, 0);
        vm.stopPrank();
    }

    // ============ Deployment guards ============

    function test_rejectsTokenWithMoreThan18Decimals() public {
        MockHighDecimalToken weird = new MockHighDecimalToken(19);
        LitePSM impl = new LitePSM();
        vm.expectPartialRevert(LitePSM.UsdcDecimalsTooLarge.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(LitePSM.initialize, (address(okuM), address(weird), admin))
        );
    }

    function test_rejectsZeroAddresses() public {
        LitePSM impl = new LitePSM();
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl), abi.encodeCall(LitePSM.initialize, (address(0), address(usdc), admin))
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(LitePSM.initialize, (address(okuM), address(usdc), address(0)))
        );
    }

    function test_decimalMultiplierResolvedFromTheToken() public view {
        assertEq(psm.usdcDecimalMultiplier(), 1e12, "6dp USDC -> 1e12");
    }

    function test_upgradeIsRoleGated() public {
        address newImpl = address(new LitePSM());
        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        psm.upgradeToAndCall(newImpl, "");

        vm.prank(admin);
        psm.upgradeToAndCall(newImpl, "");
    }
}
