// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {SubscriptionModule} from "../src/subscription/SubscriptionModule.sol";
import {USDOkuWrapper} from "../src/wrapper/USDOkuWrapper.sol";
import {Constants} from "../src/lib/Constants.sol";
import {MathLib} from "../src/lib/MathLib.sol";
import {Roles} from "../src/lib/Roles.sol";

/**
 * @title CriticalPathsTest
 * @notice The load-bearing behavioural rules of the reviewed-conversion design.
 *         Each test targets a failure mode that would be a real incident, not a
 *         style violation.
 */
contract CriticalPathsTest is BaseTest {
    // =====================================================================
    // Pricing happens at FULFILLMENT, never at request.
    //
    // The single most important rule in SubscriptionModule. Pricing at request
    // time hands every requester a free option: submit, watch the multiplier,
    // cancel if it moves against you, let it fulfill if it moves in your favour.
    // That reintroduces exactly the step arbitrage reviewed conversion exists to
    // remove — inside the mechanism meant to prevent it.
    // =====================================================================

    function test_subscription_pricesAtFulfillmentNotRequest() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        // At request time 1000 USDC would have bought 1000 OkuM.
        uint256 priceAtRequest = 1000e18;

        // A mark lands between request and fulfillment.
        _stepOkuMultiplier(100); // M_oku: 1.0 -> 1.01

        vm.prank(fulfiller);
        module.fulfillSubscription(requestId);

        uint256 received = okuM.balanceOf(alice);

        // Priced at the NEW multiplier: 1000e18 / 1.01 ~= 990.099e18.
        assertLt(received, priceAtRequest, "must not be priced at the request block");
        assertApproxEqRel(received, 990.099e18, 0.0001e18, "priced at fulfillment M_oku");

        // The dollar value delivered still matches what was paid in — the user
        // is not short-changed, they simply receive fewer, more valuable shares.
        assertApproxEqAbs(okuM.balanceOfUI(alice), 1000e18, 1e13, "dollar value preserved");
    }

    /// @dev minOut is the user's protection against an adverse move while they
    ///      wait. Without it, a request sitting through a mark is unbounded risk.
    function test_subscription_minOutBlocksAdverseMove() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        uint256 quoted = module.quoteSubscription(1000 * USDC_UNIT);

        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, quoted);
        vm.stopPrank();

        _stepOkuMultiplier(100);

        vm.prank(fulfiller);
        vm.expectPartialRevert(SubscriptionModule.SlippageExceeded.selector);
        module.fulfillSubscription(requestId);
    }

    /// @dev A request that has sat too long must not be fulfillable at a price
    ///      the user never had a chance to evaluate.
    function test_subscription_cannotFulfillPastMaxAge() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.warp(block.timestamp + Constants.MAX_REQUEST_AGE + 1);

        vm.prank(fulfiller);
        vm.expectPartialRevert(SubscriptionModule.RequestExpired.selector);
        module.fulfillSubscription(requestId);
    }

    // =====================================================================
    // Wrapper prices BOTH directions at M_oku, never at M_usd.
    //
    // If unwrap priced at M_usd, USDOku holders could extract the smoothing gap
    // directly out of the OkuM backing pool, turning a bounded accounting gap
    // into an unbounded drain on senior OkuM holders.
    // =====================================================================

    /// @dev The steady state the two-index design produces, funded as the design
    ///      now requires: M_usd outruns M_oku, and the issuer has pre-funded the
    ///      difference so the promise is actually backed.
    function _wrapThenFundedAccrual() internal returns (uint256 raw) {
        raw = _subscribe(alice, 1000 * USDC_UNIT);

        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        _prefundWrapper(20 * USDC_UNIT);

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(1000), block.timestamp + 30 days);
        vm.warp(block.timestamp + 30 days);

        assertGt(usdOku.usdOkuIndex(), okuM.uiMultiplier(), "declared has outrun realized");
    }

    function test_unwrap_pricesAtOkuMultiplierNotUsdIndex() public {
        _wrapThenFundedAccrual();

        uint256 mOku = okuM.uiMultiplier();
        uint256 mUsd = usdOku.usdOkuIndex();
        uint256 exitAmount = 500e18;

        vm.prank(alice);
        uint256 okuMOut = wrapper.unwrap(exitAmount, alice);

        assertEq(okuMOut, MathLib.fromUIAmount(exitAmount, mOku), "priced at M_oku");
        assertGt(
            okuMOut,
            MathLib.fromUIAmount(exitAmount, mUsd),
            "M_usd pricing would pay strictly less - proves M_oku is used"
        );
    }

    /// @dev THE property pre-funding buys. Previously, unwrapping a fully-grown
    ///      USDOku balance reverted `InsufficientReserves` because the wrapper
    ///      only ever held what was wrapped into it, so the last holder out could
    ///      not exit. With `MAX_SOLVENCY_GAP_BPS == 0` the forward rate cannot be
    ///      declared unless it is already funded, which makes a displayed USDOku
    ///      balance always redeemable.
    function test_unwrap_fullGrownBalanceAlwaysRedeemable() public {
        uint256 raw = _wrapThenFundedAccrual();

        uint256 usdBalance = usdOku.balanceOf(alice);
        assertGt(usdBalance, raw, "balance grew past what was wrapped");

        vm.prank(alice);
        uint256 okuMOut = wrapper.unwrap(usdBalance, alice);

        assertGt(okuMOut, raw, "holder receives the funded yield");
        assertEq(usdOku.balanceOf(alice), 0, "position fully exited");
    }

    /// @dev The invariant that replaces the old unenforceable `gapBps <= MAX`
    ///      monitoring threshold. It must survive every mutating operation.
    function test_backingCoversLiability_survivesFullCycle() public {
        assertTrue(wrapper.backingCoversLiability(), "genesis");

        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();
        assertTrue(wrapper.backingCoversLiability(), "after wrap");

        _prefundWrapper(20 * USDC_UNIT);
        assertTrue(wrapper.backingCoversLiability(), "after prefund");

        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(1000), block.timestamp + 30 days);
        assertTrue(wrapper.backingCoversLiability(), "after rate write");

        vm.warp(block.timestamp + 30 days);
        assertTrue(wrapper.backingCoversLiability(), "after full accrual");

        vm.prank(alice);
        wrapper.unwrap(300e18, alice);
        assertTrue(wrapper.backingCoversLiability(), "after partial unwrap");

        _stepOkuMultiplier(50);
        assertTrue(wrapper.backingCoversLiability(), "after an M_oku step");

        uint256 remaining = usdOku.balanceOf(alice);
        vm.prank(alice);
        wrapper.unwrap(remaining, alice);
        assertTrue(wrapper.backingCoversLiability(), "after full exit");
    }

    /// @dev `unwrap` can no longer fail for want of reserves at all, so there is
    ///      nothing for a solvency gate to protect against.
    function test_unwrap_neverRevertsForReserves() public {
        _wrapThenFundedAccrual();

        vm.startPrank(alice);
        wrapper.unwrap(500e18, alice);
        wrapper.unwrap(100e18, alice);
        wrapper.unwrap(usdOku.balanceOf(alice), alice);
        vm.stopPrank();

        assertEq(usdOku.totalSupply(), 0, "all USDOku redeemed");
    }

    /// @dev Wrap moves liability and backing by the same dollar amount and floors
    ///      the share credit, so it can only improve the position. Asserted on the
    ///      ABSOLUTE surplus, not on `solvencyGapBps()`: that is a ratio, and equal
    ///      additions to both sides dilute it toward zero, so a surplus position
    ///      legitimately sees gapBps rise (e.g. -115 -> -19) while the surplus
    ///      itself is untouched. This is why `wrap` carries no solvency gate.
    function test_wrap_cannotWorsenBacking() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        _prefundWrapper(20 * USDC_UNIT);
        vm.prank(rateSetter);
        usdOku.setUsdOkuRate(_ratePerSecondForAprBps(1000), block.timestamp + 30 days);
        vm.warp(block.timestamp + 30 days);

        uint256 surplusBefore = wrapper.realizedBacking() - wrapper.declaredLiability();

        uint256 bobRaw = _subscribe(bob, 5000 * USDC_UNIT);
        vm.startPrank(bob);
        okuM.approve(address(wrapper), bobRaw);
        wrapper.wrap(bobRaw, bob, 0);
        vm.stopPrank();

        uint256 surplusAfter = wrapper.realizedBacking() - wrapper.declaredLiability();
        assertGe(surplusAfter, surplusBefore, "wrap must never reduce the absolute surplus");
        assertTrue(wrapper.backingCoversLiability(), "invariant intact");
    }

    // =====================================================================
    // withdrawSurplus - the counterpart to pre-funding
    // =====================================================================

    /// @dev Safe to expose ONLY because the invariant is real: the post-withdrawal
    ///      backing is checked before any transfer, so surplus recovery can never
    ///      create the shortfall unwrap would otherwise hit.
    function test_withdrawSurplus_recoversOnlyTheSurplus() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        uint256 funded = _prefundWrapper(20 * USDC_UNIT);

        // No rate declared, so the entire pre-funding is still surplus.
        assertApproxEqAbs(wrapper.withdrawableSurplus(), funded, 1, "surplus == funding");

        vm.prank(admin);
        wrapper.withdrawSurplus(funded, admin);

        assertEq(okuM.balanceOf(admin), funded, "surplus recovered");
        assertTrue(wrapper.backingCoversLiability(), "invariant intact after withdrawal");
    }

    function test_withdrawSurplus_cannotBreachBacking() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw, alice, 0);
        vm.stopPrank();

        uint256 funded = _prefundWrapper(20 * USDC_UNIT);

        vm.prank(admin);
        vm.expectPartialRevert(USDOkuWrapper.WouldBreachBacking.selector);
        wrapper.withdrawSurplus(funded + 1e18, admin);
    }

    /// @dev With a rate running, the funding is committed and is no longer surplus.
    function test_withdrawSurplus_shrinksAsDeclaredRateConsumesFunding() public {
        _wrapThenFundedAccrual();

        uint256 surplusAfterAccrual = wrapper.withdrawableSurplus();
        uint256 funded = 20e18;
        assertLt(surplusAfterAccrual, funded, "accrual consumed part of the funding");

        vm.prank(admin);
        wrapper.withdrawSurplus(surplusAfterAccrual, admin);
        assertTrue(wrapper.backingCoversLiability(), "invariant intact");

        // Nothing left to take.
        vm.prank(admin);
        vm.expectPartialRevert(USDOkuWrapper.WouldBreachBacking.selector);
        wrapper.withdrawSurplus(1e15, admin);
    }

    function test_withdrawSurplus_requiresWrapperAdmin() public {
        _prefundWrapper(20 * USDC_UNIT);

        vm.prank(alice);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        wrapper.withdrawSurplus(1e18, alice);
    }

    /// @dev Sunset step 1: wrap closes, unwrap stays open indefinitely. Winding
    ///      down by trapping holders is a materially different act for a
    ///      licensed issuer than a noticed wind-down.
    function test_sunset_wrapDisabledUnwrapRemainsOpen() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        okuM.approve(address(wrapper), raw);
        wrapper.wrap(raw / 2, alice, 0);
        vm.stopPrank();

        vm.prank(admin);
        wrapper.setWrapEnabled(false);

        vm.startPrank(alice);
        vm.expectRevert(USDOkuWrapper.WrapDisabled.selector);
        wrapper.wrap(raw / 2, alice, 0);

        // Exit path unaffected.
        wrapper.unwrap(100e18, alice);
        vm.stopPrank();
    }

    // =====================================================================
    // Escrow integrity
    // =====================================================================

    /// @dev Rejected and cancelled requests must refund the input EXACTLY — no
    ///      fee, no haircut. A user who was declined has not transacted.
    function test_cancel_refundsExactlyAndChargesNoFee() public {
        vm.prank(admin);
        module.setFees(Constants.MAX_FEE_BPS, Constants.MAX_FEE_BPS);

        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice), 0, "input escrowed");
        assertEq(module.totalEscrowedUsdc(), 1000 * USDC_UNIT, "escrow tracked");

        vm.warp(block.timestamp + Constants.MIN_CANCEL_DELAY);
        vm.prank(alice);
        module.cancelRequest(requestId);

        assertEq(usdc.balanceOf(alice), 1000 * USDC_UNIT, "refunded to the wei");
        assertEq(module.totalEscrowedUsdc(), 0, "escrow released");
    }

    /// @dev Without the delay a user could submit and cancel inside one block to
    ///      probe fulfillment timing.
    function test_cancel_blockedBeforeMinDelay() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);

        vm.expectPartialRevert(SubscriptionModule.TooEarlyToCancel.selector);
        module.cancelRequest(requestId);
        vm.stopPrank();
    }

    function test_reject_isImmediateAndRefunds() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.prank(fulfiller);
        module.rejectRequest(requestId, keccak256("REASON_KYC"));

        assertEq(usdc.balanceOf(alice), 1000 * USDC_UNIT, "refunded immediately");
        assertEq(module.pendingDepositRequest(0, alice), 0, "slot freed");
    }

    /// @dev A request must resolve exactly once. Double-settlement in either
    ///      direction would mint or refund twice.
    function test_request_resolvesExactlyOnce() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.prank(fulfiller);
        module.fulfillSubscription(requestId);

        vm.prank(fulfiller);
        vm.expectRevert(SubscriptionModule.RequestNotPending.selector);
        module.fulfillSubscription(requestId);

        vm.prank(fulfiller);
        vm.expectRevert(SubscriptionModule.RequestNotPending.selector);
        module.rejectRequest(requestId, bytes32(0));

        vm.warp(block.timestamp + Constants.MIN_CANCEL_DELAY);
        vm.prank(alice);
        vm.expectRevert(SubscriptionModule.RequestNotPending.selector);
        module.cancelRequest(requestId);
    }

    function test_onePendingRequestPerUserPerDirection() public {
        usdc.mint(alice, 2000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 2000 * USDC_UNIT);
        module.requestSubscription(1000 * USDC_UNIT, 0);

        vm.expectPartialRevert(SubscriptionModule.AlreadyPending.selector);
        module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();
    }

    /// @dev sweepToken recovers donations but must be provably unable to touch a
    ///      user's escrowed input. Token donations are unpreventable, which is
    ///      why the escrow property is a BOUND and never an equality.
    function test_sweep_cannotReachEscrowedInput() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        // Someone donates straight to the module.
        usdc.mint(address(module), 500 * USDC_UNIT);

        vm.prank(admin);
        vm.expectPartialRevert(SubscriptionModule.CannotSweepBelowEscrow.selector);
        module.sweepToken(address(usdc), admin, 501 * USDC_UNIT);

        vm.prank(admin);
        module.sweepToken(address(usdc), admin, 500 * USDC_UNIT);

        assertEq(usdc.balanceOf(admin), 500 * USDC_UNIT, "donation recovered");
        assertEq(usdc.balanceOf(address(module)), module.totalEscrowedUsdc(), "escrow fully intact");
    }

    /// @dev Redemption fulfillment pulls from treasury at execution time. If the
    ///      allowance is short it must fail LOUDLY, not partially fill.
    function test_redemption_insufficientTreasuryAllowanceRevertsLoudly() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);

        vm.startPrank(alice);
        okuM.approve(address(module), raw);
        uint256 requestId = module.requestRedemption(raw, 0);
        vm.stopPrank();

        vm.prank(treasury);
        usdc.approve(address(module), 1 * USDC_UNIT);

        vm.prank(fulfiller);
        vm.expectPartialRevert(SubscriptionModule.InsufficientTreasuryAllowance.selector);
        module.fulfillRedemption(requestId);
    }

    function test_redemption_burnsEscrowAndPaysFromTreasury() public {
        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        uint256 supplyBefore = okuM.totalSupply();

        vm.startPrank(alice);
        okuM.approve(address(module), raw);
        uint256 requestId = module.requestRedemption(raw, 0);
        vm.stopPrank();

        assertEq(module.totalEscrowedOkuM(), raw, "OkuM escrowed in module");

        vm.prank(fulfiller);
        module.fulfillRedemption(requestId);

        assertEq(okuM.totalSupply(), supplyBefore - raw, "escrowed OkuM burned");
        assertEq(module.totalEscrowedOkuM(), 0, "escrow released");
        assertEq(usdc.balanceOf(alice), 1000 * USDC_UNIT, "paid from treasury");
    }

    // =====================================================================
    // Oracle-sanity bound on the rate setter
    // =====================================================================

    /// @dev MAX_STEP_BPS is no longer an arbitrage control — it is the only
    ///      per-write bound on a compromised OKU_RATE_SETTER. MAX_MULTIPLIER
    ///      alone would permit a single 1,000,000x step.
    function test_setOkuMultiplier_stepCeilingEnforced() public {
        uint256 current = okuM.uiMultiplier();
        uint256 tooBig = current + (current * (Constants.MAX_STEP_BPS + 1)) / Constants.BASIS_POINTS;

        vm.prank(rateSetter);
        vm.expectRevert(abi.encodeWithSignature("StepAboveMaximum()"));
        okuM.setOkuMultiplier(tooBig, 1);
    }

    function test_setOkuMultiplier_monotoneAndEpochOrdered() public {
        _stepOkuMultiplier(50);
        uint256 current = okuM.uiMultiplier();

        vm.prank(rateSetter);
        vm.expectRevert(abi.encodeWithSignature("MultiplierCannotDecrease()"));
        okuM.setOkuMultiplier(current - 1, 99);

        // Epoch must strictly increase — it is how both chains prove they wrote
        // for the same mark. Reads hoisted so they cannot consume the cheatcodes.
        uint256 staleEpoch = okuM.syncEpoch();
        uint256 target = current + 1e15;
        vm.prank(rateSetter);
        vm.expectRevert(abi.encodeWithSignature("EpochNotIncreasing()"));
        okuM.setOkuMultiplier(target, staleEpoch);
    }

    /// @dev Two-key separation on the value path: a compromised rate setter
    ///      cannot convert, and a compromised fulfiller cannot misprice. This is
    ///      a security property the permissionless design could not have.
    function test_roleSeparation_rateSetterCannotFulfill() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.prank(rateSetter);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        module.fulfillSubscription(requestId);

        uint256 target = okuM.uiMultiplier() + 1e15;
        vm.prank(fulfiller);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        okuM.setOkuMultiplier(target, 1);
    }

    // =====================================================================
    // Display-layer rounding
    // =====================================================================

    /// @dev The most likely user-visible bug in the system: a "Max" button built
    ///      by round-tripping through the display layer leaves dust on every
    ///      send, or exceeds the balance and reverts.
    function testFuzz_fromUIAmount_roundTripLosesAtMostOneWei(uint256 rawAmount) public {
        rawAmount = bound(rawAmount, 0, 1e30);
        _stepOkuMultiplier(97);

        uint256 roundTripped = okuM.fromUIAmount(okuM.toUIAmount(rawAmount));
        assertLe(roundTripped, rawAmount, "round trip must never inflate");
        assertGe(roundTripped + 1, rawAmount, "round trip must lose at most 1 wei");
    }

    /// @dev The ERC-8056 display layer and the 4626-shaped value layer must read
    ///      the same number. They are related by a floor to USDC granularity, so
    ///      this is a BOUND, not an equality — any test written against equality
    ///      fails immediately, which is worth encoding.
    function test_displayAndValueLayersAgreeWithinOneUsdcUnit() public {
        _stepOkuMultiplier(63);

        uint256 mOku = okuM.uiMultiplier();
        uint256 assets = okuM.convertToAssets(1e18);

        assertLe(assets * DECIMAL_MULTIPLIER, mOku, "lower bound");
        assertLt(mOku, (assets + 1) * DECIMAL_MULTIPLIER, "upper bound");
    }

    function test_totalSupplyUI_tracksSupplyTimesMultiplier() public {
        _subscribe(alice, 1000 * USDC_UNIT);
        _stepOkuMultiplier(100);

        assertEq(
            okuM.totalSupplyUI(),
            MathLib.toUIAmount(okuM.totalSupply(), okuM.uiMultiplier()),
            "totalSupplyUI identity"
        );
        assertApproxEqRel(okuM.totalSupplyUI(), 1010e18, 0.0001e18, "1000 OkuM at 1.01");
    }

    // =====================================================================
    // Regulated-issuer controls
    // =====================================================================

    /// @dev Burning must NOT restore minter allowance — otherwise the cap is a
    ///      revolving door rather than a cumulative bound.
    function test_burnDoesNotRestoreMinterAllowance() public {
        vm.prank(admin);
        okuM.configureMinterAllowance(address(module), 2000e18);

        uint256 raw = _subscribe(alice, 1000 * USDC_UNIT);
        assertEq(okuM.minterAllowance(address(module)), 2000e18 - raw, "allowance consumed");

        vm.startPrank(alice);
        okuM.approve(address(module), raw);
        uint256 requestId = module.requestRedemption(raw, 0);
        vm.stopPrank();
        vm.prank(fulfiller);
        module.fulfillRedemption(requestId);

        assertEq(
            okuM.minterAllowance(address(module)), 2000e18 - raw, "burn must not restore allowance"
        );
    }

    /// @dev Guards live in `_update` rather than on transfer/transferFrom
    ///      precisely so mint and burn cannot bypass them: a blacklisted address
    ///      can neither be minted to nor burn out.
    function test_blacklist_appliesThroughMintPath() public {
        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.prank(admin);
        okuM.blacklist(alice);

        vm.prank(fulfiller);
        vm.expectRevert(abi.encodeWithSignature("RecipientBlacklisted()"));
        module.fulfillSubscription(requestId);
    }

    function test_maxSupplyCapEnforced() public {
        vm.prank(admin);
        okuM.setMaxSupply(500e18);

        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.prank(fulfiller);
        vm.expectRevert(abi.encodeWithSignature("ExceedsSupplyCap()"));
        module.fulfillSubscription(requestId);
    }

    // =====================================================================
    // Fees
    // =====================================================================

    /// @dev Fees are withheld, not forwarded — no recipient, no sweep — so a fee
    ///      raises the collateral ratio. Fees round UP, payouts round DOWN.
    function test_fees_withheldRaiseBackingRatio() public {
        vm.prank(admin);
        module.setFees(100, 0); // 1% tin

        usdc.mint(alice, 1000 * USDC_UNIT);
        vm.startPrank(alice);
        usdc.approve(address(module), 1000 * USDC_UNIT);
        uint256 requestId = module.requestSubscription(1000 * USDC_UNIT, 0);
        vm.stopPrank();

        vm.prank(fulfiller);
        module.fulfillSubscription(requestId);

        // 1% withheld: 990 USDC of OkuM minted, but the full 1000 went to treasury.
        assertEq(okuM.balanceOf(alice), 990e18, "minted on the net amount");
        assertEq(
            usdc.balanceOf(treasury),
            100_000_000 * USDC_UNIT + 1000 * USDC_UNIT,
            "treasury received the gross"
        );
    }

    function test_fees_cannotExceedMaximum() public {
        vm.prank(admin);
        vm.expectPartialRevert(SubscriptionModule.FeeAboveMaximum.selector);
        module.setFees(Constants.MAX_FEE_BPS + 1, 0);
    }
}
