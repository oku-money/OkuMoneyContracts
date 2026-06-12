// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

import {OkuMoney} from "../src/token/OkuMoney.sol";
import {OkuDollar} from "../src/token/OkuDollar.sol";
import {LitePSM} from "../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../src/psm/RedemptionQueue.sol";
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

    function test_RedemptionQueueInitialize_RevertZeroOkuMoney() public {
        RedemptionQueue impl = new RedemptionQueue();
        bytes memory initData =
            abi.encodeCall(RedemptionQueue.initialize, (address(0), address(usdc), admin));
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_RedemptionQueueInitialize_RevertZeroUsdc() public {
        RedemptionQueue impl = new RedemptionQueue();
        bytes memory initData =
            abi.encodeCall(RedemptionQueue.initialize, (address(okuMoney), address(0), admin));
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_RedemptionQueueInitialize_RevertZeroAdmin() public {
        RedemptionQueue impl = new RedemptionQueue();
        bytes memory initData = abi.encodeCall(
            RedemptionQueue.initialize, (address(okuMoney), address(usdc), address(0))
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_LitePSMInitialize_RevertZeroOkuMoney() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize,
            (address(0), address(okuDollar), address(usdc), address(redemptionQueue), admin)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_LitePSMInitialize_RevertZeroOkuDollar() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize,
            (address(okuMoney), address(0), address(usdc), address(redemptionQueue), admin)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_LitePSMInitialize_RevertZeroUsdc() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize,
            (address(okuMoney), address(okuDollar), address(0), address(redemptionQueue), admin)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_LitePSMInitialize_RevertZeroRedemptionQueue() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize,
            (address(okuMoney), address(okuDollar), address(usdc), address(0), admin)
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    function test_LitePSMInitialize_RevertZeroAdmin() public {
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize,
            (
                address(okuMoney),
                address(okuDollar),
                address(usdc),
                address(redemptionQueue),
                address(0)
            )
        );
        vm.expectRevert(Errors.ZeroAddress.selector);
        new ERC1967Proxy(address(impl), initData);
    }

    // ============ UsdcDecimalsTooLarge ============

    function test_LitePSMInitialize_RevertUsdcDecimalsTooLarge() public {
        MockHighDecimalToken hd = new MockHighDecimalToken(19);
        LitePSM impl = new LitePSM();
        bytes memory initData = abi.encodeCall(
            LitePSM.initialize,
            (address(okuMoney), address(okuDollar), address(hd), address(redemptionQueue), admin)
        );
        vm.expectRevert(abi.encodeWithSelector(LitePSM.UsdcDecimalsTooLarge.selector, uint8(19)));
        new ERC1967Proxy(address(impl), initData);
    }

    function test_RedemptionQueueInitialize_RevertUsdcDecimalsTooLarge() public {
        MockHighDecimalToken hd = new MockHighDecimalToken(20);
        RedemptionQueue impl = new RedemptionQueue();
        bytes memory initData =
            abi.encodeCall(RedemptionQueue.initialize, (address(okuMoney), address(hd), admin));
        vm.expectRevert(
            abi.encodeWithSelector(RedemptionQueue.UsdcDecimalsTooLarge.selector, uint8(20))
        );
        new ERC1967Proxy(address(impl), initData);
    }

    // ============ OkuMoney multiplier ceiling ============

    function test_OkuMoney_SetOkuMMultiplier_RevertMultiplierTooHigh() public {
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.MultiplierTooHigh.selector);
        okuMoney.setOkuMMultiplier(Constants.MAX_MULTIPLIER + 1);
    }

    function test_OkuMoney_DistributeYield_RevertMultiplierTooHigh() public {
        // Bring the multiplier just under the ceiling so a small yield pushes it over.
        vm.prank(rebaser);
        okuMoney.setOkuMMultiplier(Constants.MAX_MULTIPLIER);

        // Mint supply so `distributeYield`'s `supply == 0` guard doesn't fire.
        _mintOkuMoney(user1, 1000e18);

        // Roll past the same-block yield lock would-affect side effects (irrelevant here
        // because we're calling distributeYield, not a PSM op).

        // Any positive yieldPerToken pushes newMultiplier > MAX_MULTIPLIER.
        vm.prank(rebaser);
        vm.expectRevert(OkuMoney.MultiplierTooHigh.selector);
        okuMoney.distributeYield(1000e18); // 1e18 yield over 1000 OkuM = 1e15 per token
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
}
