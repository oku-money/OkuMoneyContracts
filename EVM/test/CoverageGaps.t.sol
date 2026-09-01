// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {OkuMoney} from "../src/token/OkuMoney.sol";
import {OkuDollar} from "../src/token/OkuDollar.sol";
import {LitePSM} from "../src/psm/LitePSM.sol";
import {Errors} from "../src/lib/Errors.sol";
import {Constants} from "../src/lib/Constants.sol";

import {MockUSDC} from "./mocks/MockUSDC.sol";
import {MockHighDecimalToken} from "./mocks/MockHighDecimalToken.sol";

import {BaseTest} from "./Base.t.sol";

/**
 * @title CoverageGapsTest
 * @notice Targeted tests for branches uncovered by the main suites.
 * @dev Each test exercises exactly one revert branch surfaced by
 *      `forge coverage --report summary`. The aim is to push the per-contract
 *      branch coverage above the audit-readiness target rather than to add
 *      additional functional verification.
 */
contract CoverageGapsTest is BaseTest {
    function setUp() public override {
        super.setUp();
    }

    // ============ initialize() ZeroAddress reverts ============
    //
    // Each `if (... == address(0)) revert Errors.ZeroAddress();` line in every
    // `initialize` is a distinct branch. We deploy the implementations directly
    // and call `initialize` with each address slot set to zero in turn.

    function test_OkuMoneyInitialize_RevertZeroAdmin() public {
        OkuMoney impl = new OkuMoney();
        bytes memory initData =
            abi.encodeCall(OkuMoney.initialize, ("OkuMoney", "OkuM", address(0), MAX_SUPPLY));
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_OkuDollarInitialize_RevertZeroOkuMoney() public {
        OkuDollar impl = new OkuDollar();
        bytes memory initData =
            abi.encodeCall(OkuDollar.initialize, (address(0), "OkuDollar", "usdOku", admin, 95e16));
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_OkuDollarInitialize_RevertZeroAdmin() public {
        OkuDollar impl = new OkuDollar();
        bytes memory initData = abi.encodeCall(
            OkuDollar.initialize, (address(okuMoney), "OkuDollar", "usdOku", address(0), 95e16)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_OkuDollarInitialize_RevertRatioExceedsMax() public {
        OkuDollar impl = new OkuDollar();
        bytes memory initData = abi.encodeCall(
            OkuDollar.initialize,
            (address(okuMoney), "OkuDollar", "usdOku", admin, Constants.PRECISION + 1)
        );
        vm.expectRevert(OkuDollar.RatioExceedsMax.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_OkuDollarInitialize_RevertRatioBelowFloor() public {
        OkuDollar impl = new OkuDollar();
        bytes memory initData = abi.encodeCall(
            OkuDollar.initialize,
            (
                address(okuMoney),
                "OkuDollar",
                "usdOku",
                admin,
                Constants.MIN_COLLATERAL_RATIO_FLOOR - 1
            )
        );
        vm.expectRevert(OkuDollar.RatioBelowFloor.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_LitePSMInitialize_RevertZeroOkuMoney() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (address(0), address(okuDollar), address(usdc), admin)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_LitePSMInitialize_RevertZeroOkuDollar() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (address(okuMoney), address(0), address(usdc), admin)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_LitePSMInitialize_RevertZeroUsdc() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (address(okuMoney), address(okuDollar), address(0), admin)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_LitePSMInitialize_RevertZeroAdmin() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (address(okuMoney), address(okuDollar), address(usdc), address(0))
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    // ============ UsdcDecimalsTooLarge ============

    function test_LitePSMInitialize_RevertUsdcDecimalsTooLarge() public {
        MockHighDecimalToken hd = new MockHighDecimalToken(19);
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize, (address(okuMoney), address(okuDollar), address(hd), admin)
        );
        vm.expectRevert(abi.encodeWithSelector(LitePSM.UsdcDecimalsTooLarge.selector, uint8(19)));
        new ERC1967Proxy(address(impl), initData);
    }

    // ============ OkuMoney yield-epoch bounds ============
    //
    // `MAX_MULTIPLIER` (1e24) is no longer directly reachable: the multiplier can
    // only advance through an epoch, and `MAX_IMPLIED_APR_BPS` caps each epoch at
    // 20% annualized. Compounding from 1e18 to 1e24 at that ceiling takes ~76 years
    // of back-to-back max-rate epochs. The binding constraint in practice is the
    // APR cap, so that is what these tests pin.

    function test_OkuMoney_StartYieldEpoch_RevertImpliedAprTooHigh() public {
        _mintOkuMoney(user1, 1000e18);

        // 20% of supply delivered over a single day annualizes to ~7300% — far above
        // the 20% cap. The reported figure is computed from the TRUNCATED per-second
        // rate, so it lands a hair under the exact 730000 bps.
        vm.prank(rebaser);
        vm.expectRevert(
            abi.encodeWithSelector(
                OkuMoney.ImpliedAprTooHigh.selector, uint256(729_999), Constants.MAX_IMPLIED_APR_BPS
            )
        );
        okuMoney.startYieldEpoch(200e18, 1 days);
    }

    function test_OkuMoney_StartYieldEpoch_RevertDurationTooShort() public {
        _mintOkuMoney(user1, 1000e18);
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.InvalidEpochDuration.selector);
        okuMoney.startYieldEpoch(1e18, Constants.MIN_EPOCH_DURATION - 1);
    }

    function test_OkuMoney_StartYieldEpoch_RevertDurationTooLong() public {
        _mintOkuMoney(user1, 1000e18);
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.InvalidEpochDuration.selector);
        okuMoney.startYieldEpoch(1e18, Constants.MAX_EPOCH_DURATION + 1);
    }

    function test_OkuMoney_StartYieldEpoch_RevertZeroSupply() public {
        assertEq(okuMoney.totalSupply(), 0, "precondition: no supply");
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.ZeroSupply.selector);
        okuMoney.startYieldEpoch(1e18, 30 days);
    }

    function test_OkuMoney_StartYieldEpoch_RevertYieldTooSmall() public {
        // Huge supply + tiny yield + long duration => per-second rate floors to zero.
        _mintOkuMoney(user1, 1_000_000_000e18);
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.YieldTooSmall.selector);
        okuMoney.startYieldEpoch(1, Constants.MAX_EPOCH_DURATION);
    }

    // ============ OkuDollar.setMinCollateralRatio post-condition branch ============

    function test_OkuDollar_SetMinCollateralRatio_RevertBelowMinimumCollateral() public {
        // Wrap a small amount so the vault has obligations but no surplus.
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(address(okuDollar), 100e18);
        vm.prank(user1);
        okuDollar.wrap(100e18, user1, 0);

        // Current ratio is 100% (1:1 OkuM:UsdOku at PRECISION multipliers). Raising the
        // floor above 100% would force the live ratio below the new floor.
        // Since PRECISION is the cap, request exactly PRECISION (= 100%) is the highest valid.
        // To trigger BelowMinimumCollateral we'd need a ratio above current live ratio.
        // The cleanest way: bring live ratio below PRECISION by distributing yield to USD side.
        // Easier: directly call with PRECISION when live ratio is < PRECISION.

        // Stage a positive USD yield rate so USD multiplier > 1 and live ratio < 1.
        // VAULT_REBASER (not the OkuMoney OKUM_REBASER) controls usdYieldRate.
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(Constants.PRECISION + 1e9, block.timestamp + 365 days);
        vm.warp(block.timestamp + 30 days);

        // Live ratio now < PRECISION. Attempt to raise floor to PRECISION → must revert.
        // VAULT_ADMIN is granted to `admin` at OkuDollar.initialize().
        vm.prank(admin);
        vm.expectRevert(OkuDollar.BelowMinimumCollateral.selector);
        okuDollar.setMinCollateralRatio(Constants.PRECISION);
    }

    // ============ OkuDollar.withdrawSurplus InsufficientReserves branch ============

    function test_OkuDollar_WithdrawSurplus_RevertInsufficientReserves() public {
        // Vault has zero reserves at setup.
        // Roll forward so we're not in the same block as a yield distribution (none has
        // been done in this test, but be safe vs. setUp).
        vm.roll(block.number + 1);

        vm.prank(reserveManager);
        vm.expectRevert(OkuDollar.InsufficientReserves.selector);
        okuDollar.withdrawSurplus(1e18);
    }

    // ============ LitePSM ZeroAmount reverts ============

    function test_LitePSM_MintUsdOku_RevertZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        litePsm.mintUsdOku(0);
    }

    function test_LitePSM_RedeemUsdOku_RevertZeroAmount() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        litePsm.redeemUsdOku(0);
    }

    // ============ OkuDollar._update tripwire ============
    //
    // `_update` lives behind ERC20Upgradeable.transfer / transferFrom, but OkuDollar
    // overrides those to use share-based accounting that bypasses `_update`. Direct
    // `_mint(address(0), ...)` / `_burn(..., address(0))` would hit the two reverts.
    // We exercise the reachable peer-to-peer branch through a normal ERC20.transfer.

    function test_OkuDollar_Update_PeerToPeerPassThrough() public {
        // Give user1 some shares via wrap.
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(address(okuDollar), 100e18);
        vm.prank(user1);
        okuDollar.wrap(100e18, user1, 0);

        // Peer-to-peer transfer goes through OkuDollar.transfer (share-based),
        // not the inherited ERC20 _update; this is a positive-path sanity check
        // that the override does not break peer-to-peer flow under upgraded OZ.
        uint256 bal = okuDollar.balanceOf(user1);
        vm.prank(user1);
        okuDollar.transfer(user2, bal / 2);
        assertGt(okuDollar.balanceOf(user2), 0);
    }

    // ============ OkuDollar.unwrap InsufficientBalance ============

    function test_OkuDollar_Unwrap_RevertInsufficientBalance() public {
        // user1 has no shares; unwrap any positive amount must revert.
        vm.prank(user1);
        vm.expectRevert(Errors.InsufficientBalance.selector);
        okuDollar.unwrap(1e18, user1);
    }

    function test_OkuDollar_Unwrap_RevertZeroReceiver() public {
        // Stage some shares first so we don't trip InsufficientBalance.
        _mintOkuMoney(user1, 100e18);
        vm.prank(user1);
        okuMoney.approve(address(okuDollar), 100e18);
        vm.prank(user1);
        okuDollar.wrap(100e18, user1, 0);

        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAddress.selector);
        okuDollar.unwrap(1e18, address(0));
    }

    // ============ OkuDollar._compoundFor saturation @ MAX_MULTIPLIER ============
    //
    // `_compoundFor` clips silently when the compounded value would exceed
    // `MAX_MULTIPLIER`. Downstream views (`usdMultiplier()`, `balanceOf`,
    // `totalSupply`, collateralization ratio) continue to operate using the
    // saturated value. This test pins the saturation behaviour so future
    // refactors (or a switch to a different `rpow` impl) cannot silently
    // wrap or revert at the cap.

    function test_OkuDollar_UsdMultiplier_SaturatesAtMaxMultiplier() public {
        // Stage a tiny supply so `wrap` succeeds; the value isn't material.
        _mintOkuMoney(user1, 1e18);
        vm.prank(user1);
        okuMoney.approve(address(okuDollar), 1e18);
        vm.prank(user1);
        okuDollar.wrap(1e18, user1, 0);

        // At MAX_RATE = PRECISION + 1e11 per second, the unbounded compounded
        // multiplier crosses MAX_MULTIPLIER (= 1e24 = 1e6 × PRECISION) after
        // roughly ln(1e6) / ln(1 + 1e-7) ≈ 1.38e8 seconds (~4.4 years). We
        // warp 10 years to land well past the saturation point but inside
        // the rpow-safe input region (warping 50+ years overflows rpow's
        // intermediate squarings, which is a separate property).
        vm.prank(usdRebaser);
        okuDollar.setUsdYieldRate(Constants.MAX_RATE, block.timestamp + 20 * 365 days);

        vm.warp(block.timestamp + 10 * 365 days);

        uint256 mult = okuDollar.usdMultiplier();
        assertEq(
            mult, Constants.MAX_MULTIPLIER, "usdMultiplier must saturate exactly at MAX_MULTIPLIER"
        );

        // Critical follow-on: downstream reads must continue to function at
        // the saturated value — no overflow, no revert. `balanceOf` reads
        // `usdMultiplier()` internally; it must return a usable number.
        uint256 bal = okuDollar.balanceOf(user1);
        assertGt(bal, 0, "balanceOf must not revert at saturated multiplier");
    }

    // ============ LitePSM buffer-only redemption ============
    //
    // There is no redemption queue: a redemption the buffer cannot cover reverts
    // with `InsufficientBuffer` rather than being escrowed. Pin that boundary here.

    function test_LitePSM_RedeemExceedingBuffer_Reverts() public {
        _mintOkuMoney(user1, 1000e18);
        usdc.mint(address(litePsm), 1_000_000e6);

        // Drain the buffer to ~1 USDC.
        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(admin, 999_999e6);

        uint256 buffer = usdc.balanceOf(address(litePsm));
        assertEq(buffer, 1e6, "buffer should be 1 USDC");

        // 1000 OkuM is worth ~1000 USDC, far above the buffer.
        vm.prank(user1);
        okuMoney.approve(address(litePsm), 1000e18);
        vm.prank(user1);
        vm.expectRevert(abi.encodeWithSelector(LitePSM.InsufficientBuffer.selector, buffer, 1000e6));
        litePsm.redeemOkuM(1000e18);

        // Nothing moved: no escrow, no partial fill.
        assertEq(okuMoney.balanceOf(user1), 1000e18, "user keeps their OkuM");
        assertEq(usdc.balanceOf(address(litePsm)), buffer, "buffer untouched");

        // A redemption within the buffer succeeds.
        vm.prank(user1);
        litePsm.redeemOkuM(1e18);
        assertEq(usdc.balanceOf(user1), 1e6, "user paid from buffer");
    }

    // ============ configureMinterAllowance ZeroAddress ============

    function test_ConfigureMinterAllowance_RevertZeroAddress() public {
        vm.prank(allowanceManager);
        vm.expectRevert(Errors.ZeroAddress.selector);
        okuMoney.configureMinterAllowance(address(0), 1000e18);
    }

    // ============ depositBuffer ZeroAmount ============

    function test_DepositBuffer_RevertZeroAmount() public {
        vm.prank(bufferDepositor);
        vm.expectRevert(Errors.ZeroAmount.selector);
        litePsm.depositBuffer(0);
    }
}
