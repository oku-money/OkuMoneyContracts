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
import {OkuM} from "../../src/token/OkuM.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {Roles} from "../../src/lib/Roles.sol";
import {TestConstants} from "../shared/Constants.sol";
import {MockUSDC} from "../mocks/MockUSDC.sol";
import {MockHighDecimalToken} from "../mocks/MockHighDecimalToken.sol";

contract SubscriptionModuleTest is BaseTest {
    uint256 internal constant DM = TestConstants.DECIMAL_MULTIPLIER;

    // ============ Mint ============

    function test_Mint_AtUnitMultiplier_IsOneToOne() public {
        uint256 rawOut = _psmMint(user1, 100e6);
        assertEq(rawOut, 100e18);
        assertEq(token.balanceOf(user1), 100e18);
        assertEq(token.balanceOfUI(user1), 100e18);
        assertEq(usdc.balanceOf(address(module)), 100e6);
    }

    /// @notice The README's worked example: at $1.05, 100 USDC buys ~95.24 raw,
    ///         which displays as $100.
    function test_Mint_AtElevatedMultiplier_BuysFewerRawSameDollars() public {
        _accrueToAtLeast((Constants.PRECISION * 105) / 100);
        // Fee-free math below: reaching an elevated multiplier requires steps,
        // and every step ratchets the `tin + tout` floor. `_resetFees` clears it
        // via the cold escape hatch so this test measures pure multiplier
        // conversion. Fee-inclusive behaviour is `FeesTest`'s job.
        _resetFees();
        uint256 m = token.uiMultiplier();

        uint256 rawOut = _psmMint(user1, 100e6);
        assertLt(rawOut, 100e18, "fewer raw tokens at a higher multiplier");
        assertApproxEqAbs(token.balanceOfUI(user1), 100e18, DM, "but the same dollar value");
        assertEq(rawOut, (100e18 * Constants.PRECISION) / m);
    }

    function test_Mint_ZeroReverts() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        module.mint(0);
    }

    /// @notice Documents that `AmountTooSmall` on the MINT path is UNREACHABLE with
    ///         6-decimal USDC, and why.
    /// @dev One USDC unit is worth `1e12` dollar-wei, so flooring it to zero raw
    ///      would need a multiplier above `1e30`; `MAX_MULTIPLIER` is `1e24`. The
    ///      guard is defensive for the 18-decimal asset case that
    ///      `MAX_USDC_DECIMALS` explicitly permits — exercised in
    ///      `test_Mint_DustFloorsToZero_With18DecimalAsset`.
    ///
    ///      Asserted rather than commented so that raising `MAX_MULTIPLIER` past
    ///      `1e30` turns this into a visible failure instead of a silent change in
    ///      reachability.
    function test_Mint_OneUsdcUnitAlwaysYieldsNonZeroRaw() public {
        _accrueToAtLeast(1000 * Constants.PRECISION);
        // Fee-free math below: reaching an elevated multiplier requires steps,
        // and every step ratchets the `tin + tout` floor. `_resetFees` clears it
        // via the cold escape hatch so this test measures pure multiplier
        // conversion. Fee-inclusive behaviour is `FeesTest`'s job.
        _resetFees();
        assertGt(module.quoteMint(1), 0, "6dp USDC cannot floor to zero raw");
        assertLt(Constants.MAX_MULTIPLIER, DM * Constants.PRECISION, "1e24 < 1e30");
    }

    /// @notice The reachable case: an 18-decimal asset makes
    ///         `usdcDecimalMultiplier == 1`, so a 1-wei input floors to zero raw
    ///         at any multiplier above `PRECISION`.
    function test_Mint_DustFloorsToZero_With18DecimalAsset() public {
        MockHighDecimalToken asset18 = new MockHighDecimalToken(18);

        OkuM t = OkuM(
            address(
                new ERC1967Proxy(
                    address(new OkuM()),
                    abi.encodeCall(
                        OkuM.initialize,
                        ("Oku Dollar", "OkuM", address(asset18), admin, INITIAL_MAX_SUPPLY)
                    )
                )
            )
        );
        RedemptionQueue q = RedemptionQueue(
            address(
                new ERC1967Proxy(
                    address(new RedemptionQueue()),
                    abi.encodeCall(
                        RedemptionQueue.initialize, (address(t), address(asset18), admin)
                    )
                )
            )
        );
        SubscriptionModule p = SubscriptionModule(
            address(
                new ERC1967Proxy(
                    address(new SubscriptionModule()),
                    abi.encodeCall(
                        SubscriptionModule.initialize,
                        (address(t), address(asset18), address(q), admin)
                    )
                )
            )
        );

        assertEq(t.usdcDecimalMultiplier(), 1, "18dp asset => multiplier of 1");

        vm.startPrank(admin);
        t.grantRole(Roles.OKU_MINTER, address(p));
        t.configureMinterAllowance(address(p), MINTER_ALLOWANCE);
        t.grantRole(Roles.OKU_RATE_SETTER, rateSetter);
        // Step coverage is fail-closed: without the fee source wired and a
        // covering fee set, `setOkuMultiplier` below would revert
        // `StepNotCovered`. Wiring it here rather than working around it keeps
        // this fixture honest about the production precondition.
        t.setStepFeeSource(address(p));
        p.setFees(50, 50);
        vm.stopPrank();

        vm.prank(rateSetter);
        t.setOkuMultiplier((Constants.PRECISION * 10_050) / 10_000);
        vm.warp(block.timestamp + t.syncWindowDuration());
        assertGt(t.uiMultiplier(), Constants.PRECISION);

        asset18.mint(user1, 10);
        vm.startPrank(user1);
        asset18.approve(address(p), 10);
        vm.expectRevert(SubscriptionModule.AmountTooSmall.selector);
        p.mint(1);
        vm.stopPrank();
    }

    function test_Mint_WhenPausedReverts() public {
        vm.prank(psmPauser);
        module.pause();
        usdc.mint(user1, 100e6);
        vm.startPrank(user1);
        usdc.approve(address(module), 100e6);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        module.mint(100e6);
        vm.stopPrank();
    }

    function test_Mint_RespectsTokenSupplyCap() public {
        vm.prank(capManager);
        token.setMaxSupply(50e18);
        usdc.mint(user1, 100e6);
        vm.startPrank(user1);
        usdc.approve(address(module), 100e6);
        vm.expectPartialRevert(OkuM.ExceedsSupplyCap.selector);
        module.mint(100e6);
        vm.stopPrank();
    }

    function test_Mint_RespectsMinterAllowance() public {
        vm.prank(allowanceManager);
        token.configureMinterAllowance(address(module), 10e18);
        usdc.mint(user1, 100e6);
        vm.startPrank(user1);
        usdc.approve(address(module), 100e6);
        vm.expectPartialRevert(OkuM.ExceedsAllowance.selector);
        module.mint(100e6);
        vm.stopPrank();
    }

    // ============ Redeem: instant path ============

    function test_Redeem_InstantWhenBufferSufficient() public {
        _seedBuffer(1000e6);
        uint256 rawOut = _psmMint(user1, 100e6);

        vm.startPrank(user1);
        token.approve(address(module), rawOut);
        uint256 usdcOut = module.redeem(rawOut);
        vm.stopPrank();

        assertEq(usdcOut, 100e6);
        assertEq(token.balanceOf(user1), 0);
        assertEq(token.totalSupply(), 0, "redeemed tokens are burned");
    }

    function test_Redeem_RoundTripPreservesValueWithinDust() public {
        _seedBuffer(1_000_000e6);
        _accrue(RATE_5_PCT_APY, 20 days);
        // Fee-free math below: reaching an elevated multiplier requires steps,
        // and every step ratchets the `tin + tout` floor. `_resetFees` clears it
        // via the cold escape hatch so this test measures pure multiplier
        // conversion. Fee-inclusive behaviour is `FeesTest`'s job.
        _resetFees();

        uint256 rawOut = _psmMint(user1, 12_345e6);
        vm.startPrank(user1);
        token.approve(address(module), rawOut);
        uint256 usdcOut = module.redeem(rawOut);
        vm.stopPrank();

        assertLe(usdcOut, 12_345e6, "round trip must never gain");
        assertGe(usdcOut + 1, 12_345e6, "and loses at most one USDC unit");
    }

    /// @notice Yield earned between mint and redeem is paid out.
    function test_Redeem_PaysAccruedYield() public {
        _seedBuffer(1_000_000e6);
        uint256 rawOut = _psmMint(user1, 10_000e6);
        _accrue(RATE_5_PCT_APY, Constants.MAX_RATE_DURATION);

        vm.startPrank(user1);
        token.approve(address(module), rawOut);
        uint256 usdcOut = module.redeem(rawOut);
        vm.stopPrank();

        assertGt(usdcOut, 10_000e6, "holder should be paid the accrual");
    }

    function test_Redeem_WhenPausedReverts() public {
        _seedBuffer(1000e6);
        uint256 rawOut = _psmMint(user1, 100e6);
        vm.prank(psmPauser);
        module.pause();
        vm.startPrank(user1);
        token.approve(address(module), rawOut);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        module.redeem(rawOut);
        vm.stopPrank();
    }

    /// @notice `redeemUiAmount` carries `whenNotPaused` too, and previously had
    ///         no test covering it — the sibling `redeem` case above was the only
    ///         pause assertion on the redemption surface. Pinned here so the
    ///         second entrypoint cannot silently lose its gate.
    function test_RedeemUiAmount_WhenPausedReverts() public {
        _seedBuffer(1000e6);
        uint256 rawOut = _psmMint(user1, 100e6);
        uint256 uiBalance = token.balanceOfUI(user1);

        vm.prank(psmPauser);
        module.pause();

        vm.startPrank(user1);
        token.approve(address(module), rawOut);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        module.redeemUiAmount(uiBalance);
        vm.stopPrank();
    }

    // ============ Redeem: queue path ============

    function test_Redeem_QueuesWhenBufferEmpty() public {
        uint256 rawOut = _psmMint(user1, 100e6);
        // Drain the buffer that the mint just filled.
        vm.prank(bufferWithdrawer);
        module.withdrawUsdc(treasury, 100e6);

        vm.startPrank(user1);
        token.approve(address(module), rawOut);
        uint256 usdcOut = module.redeem(rawOut);
        vm.stopPrank();

        assertEq(usdcOut, 0, "queued, not paid");
        assertEq(queue.totalQueuedRaw(), rawOut);
        assertEq(token.balanceOf(address(queue)), rawOut, "escrowed in the queue");
        assertEq(queue.queueLength(), 1);
    }

    /// @notice A queued holder keeps earning: the escrowed raw amount is fixed but
    ///         appreciates with the multiplier.
    function test_Queue_EntryAppreciatesWhileWaiting() public {
        uint256 rawOut = _psmMint(user1, 1000e6);
        vm.prank(bufferWithdrawer);
        module.withdrawUsdc(treasury, 1000e6);

        vm.startPrank(user1);
        token.approve(address(module), rawOut);
        module.redeem(rawOut);
        vm.stopPrank();

        uint256 owedBefore = queue.totalQueuedUsdc();
        _accrue(RATE_5_PCT_APY, Constants.MAX_RATE_DURATION);
        assertGt(queue.totalQueuedUsdc(), owedBefore, "queued value must accrue");
        assertEq(queue.totalQueuedRaw(), rawOut, "but the raw count is fixed");
    }

    function test_ProcessQueue_PaysUserAndBurns() public {
        uint256 rawOut = _psmMint(user1, 1000e6);
        vm.prank(bufferWithdrawer);
        module.withdrawUsdc(treasury, 1000e6);

        vm.startPrank(user1);
        token.approve(address(module), rawOut);
        module.redeem(rawOut);
        vm.stopPrank();

        _seedBuffer(2000e6);
        uint256 owed = queue.totalQueuedUsdc();

        vm.prank(queueProcessor);
        module.processQueue(0, 1, owed);

        assertEq(usdc.balanceOf(user1), owed);
        assertEq(queue.totalQueuedRaw(), 0);
        assertEq(token.totalSupply(), 0, "burned on processing");
    }

    /// @notice Pause must not lock users into the queue.
    function test_ProcessQueue_WorksWhilePaused() public {
        uint256 rawOut = _psmMint(user1, 1000e6);
        vm.prank(bufferWithdrawer);
        module.withdrawUsdc(treasury, 1000e6);
        vm.startPrank(user1);
        token.approve(address(module), rawOut);
        module.redeem(rawOut);
        vm.stopPrank();

        _seedBuffer(2000e6);
        vm.prank(psmPauser);
        module.pause();

        // Hoisted: an inline call argument would consume the prank.
        uint256 owed = queue.totalQueuedUsdc();
        vm.prank(queueProcessor);
        module.processQueue(0, 1, owed);
        assertEq(queue.totalQueuedRaw(), 0);
    }

    function test_ProcessQueue_RequiresRole() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        module.processQueue(0, 1, 0);
    }

    // ============ Buffer management ============

    function test_WithdrawUsdc_CannotStrandQueue() public {
        uint256 rawOut = _psmMint(user1, 1000e6);
        vm.prank(bufferWithdrawer);
        module.withdrawUsdc(treasury, 1000e6);
        vm.startPrank(user1);
        token.approve(address(module), rawOut);
        module.redeem(rawOut);
        vm.stopPrank();

        _seedBuffer(2000e6);
        uint256 obligation = queue.totalQueuedUsdc();

        vm.prank(bufferWithdrawer);
        vm.expectPartialRevert(SubscriptionModule.WouldStrandQueue.selector);
        module.withdrawUsdc(treasury, 2000e6);

        // Leaving exactly the obligation is fine.
        vm.prank(bufferWithdrawer);
        module.withdrawUsdc(treasury, 2000e6 - obligation);
    }

    function test_WithdrawUsdc_NotPauseGated() public {
        _seedBuffer(1000e6);
        vm.prank(psmPauser);
        module.pause();
        vm.prank(bufferWithdrawer);
        module.withdrawUsdc(treasury, 1000e6);
        assertEq(usdc.balanceOf(treasury), 1000e6);
    }

    function test_WithdrawUsdc_ZeroAddressReverts() public {
        _seedBuffer(1e6);
        vm.prank(bufferWithdrawer);
        vm.expectRevert(Errors.ZeroAddress.selector);
        module.withdrawUsdc(address(0), 1e6);
    }

    function test_WithdrawUsdc_AboveBalanceReverts() public {
        _seedBuffer(1e6);
        vm.prank(bufferWithdrawer);
        vm.expectPartialRevert(SubscriptionModule.InsufficientBuffer.selector);
        module.withdrawUsdc(treasury, 2e6);
    }

    function test_DepositBuffer_NotPauseGated() public {
        vm.prank(psmPauser);
        module.pause();
        _seedBuffer(500e6);
        assertEq(usdc.balanceOf(address(module)), 500e6);
    }

    function test_DepositBuffer_ZeroReverts() public {
        vm.prank(bufferDepositor);
        vm.expectRevert(Errors.ZeroAmount.selector);
        module.depositBuffer(0);
    }

    // ============ Donation sweep ============

    /// @notice Anyone can transfer tokens to the PSM for free. Without a sweep
    ///         they would be stranded, and an equality-shaped invariant on the
    ///         PSM's token balance would be permanently griefable.
    function test_SweepToken_RecoversDonatedTokens() public {
        _mintRaw(user1, 100e18);
        vm.prank(user1);
        token.transfer(address(module), 100e18);
        assertEq(token.balanceOf(address(module)), 100e18);

        vm.prank(bufferWithdrawer);
        module.sweepToken(address(token), treasury);

        assertEq(token.balanceOf(address(module)), 0);
        assertEq(token.balanceOf(treasury), 100e18);
    }

    /// @notice Sweeping must not become a back door around `WouldStrandQueue`.
    function test_SweepToken_CannotTakeUsdc() public {
        _seedBuffer(1000e6);
        vm.prank(bufferWithdrawer);
        vm.expectRevert(SubscriptionModule.CannotSweepAsset.selector);
        module.sweepToken(address(usdc), treasury);
    }

    function test_SweepToken_RequiresRole() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        module.sweepToken(address(token), treasury);
    }

    function test_SweepToken_NothingToSweepReverts() public {
        vm.prank(bufferWithdrawer);
        vm.expectRevert(Errors.ZeroAmount.selector);
        module.sweepToken(address(token), treasury);
    }

    // ============ Init cross-assertions (single source of truth) ============

    /// @notice A PSM pointed at a different USDC than the token's `asset()` must
    ///         fail at deploy, not price divergently in production.
    function test_Initialize_AssetMismatchReverts() public {
        MockUSDC other = new MockUSDC();
        SubscriptionModule impl = new SubscriptionModule();
        vm.expectPartialRevert(SubscriptionModule.AssetMismatch.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                SubscriptionModule.initialize,
                (address(token), address(other), address(queue), admin)
            )
        );
    }

    function test_Initialize_ZeroAddressesRevert() public {
        SubscriptionModule impl = new SubscriptionModule();
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                SubscriptionModule.initialize, (address(0), address(usdc), address(queue), admin)
            )
        );
    }

    /// @notice >18-decimal assets are rejected: the decimal multiplier would need
    ///         a negative exponent.
    function test_Initialize_HighDecimalAssetRejectedByToken() public {
        MockHighDecimalToken weird = new MockHighDecimalToken(19);
        OkuM impl = new OkuM();
        vm.expectPartialRevert(OkuM.AssetDecimalsTooLarge.selector);
        new ERC1967Proxy(
            address(impl),
            abi.encodeCall(
                OkuM.initialize, ("Oku Dollar", "OkuM", address(weird), admin, INITIAL_MAX_SUPPLY)
            )
        );
    }

    // ============ Pause access control ============

    function test_Pause_RequiresPauserAndUnpauseRequiresUnpauser() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        module.pause();

        vm.prank(psmPauser);
        module.pause();

        // A pauser must NOT be able to unpause — that is the cold multisig's job.
        vm.prank(psmPauser);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        module.unpause();

        vm.prank(psmUnpauser);
        module.unpause();
    }
}
