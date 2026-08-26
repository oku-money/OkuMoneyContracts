// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Vm} from "forge-std/Vm.sol";

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {IScaledUIAmount} from "../../src/interfaces/erc8056/IScaledUIAmount.sol";
import {
    IScaledUIAmountNewUIMultiplier
} from "../../src/interfaces/erc8056/IScaledUIAmountNewUIMultiplier.sol";
import {
    IScaledUIAmountConversion
} from "../../src/interfaces/erc8056/IScaledUIAmountConversion.sol";
import {IScaledUIAmountBalances} from "../../src/interfaces/erc8056/IScaledUIAmountBalances.sol";

/**
 * @title ERC8056ConformanceTest
 * @notice Conformance against the ERC-8056 Draft, plus the interface-ID
 *         precedence rule and the immediate-step reading of the pending
 *         extension.
 *
 * @dev THE IMMEDIATE-STEP INVARIANT. Steps crystallize the moment they are
 *      written, so `uiMultiplier() == newUIMultiplier()` holds at EVERY
 *      timestamp and `effectiveAt()` is the timestamp of the last step. There
 *      is never a matured-but-uncrystallized pending value, which sidesteps the
 *      reference implementation's documented `>=`/`>` boundary defect.
 */
contract ERC8056ConformanceTest is BaseTest {
    // ============ Interface IDs ============

    /// @notice Every published ID matches its computed counterpart.
    /// @dev PRECEDENCE RULE: the interface *text* is normative, so
    ///      `type(I).interfaceId` wins on divergence and the published literal is
    ///      only a cross-check. This test is what turns a Draft-EIP ID change
    ///      into a red build rather than a silently mis-registered ERC-165.
    function test_InterfaceIds_PublishedMatchComputed() public pure {
        assertEq(
            Constants.IID_SCALED_UI_CORE,
            type(IScaledUIAmount).interfaceId,
            "core ID drifted from interface text"
        );
        assertEq(
            Constants.IID_SCALED_UI_PENDING,
            type(IScaledUIAmountNewUIMultiplier).interfaceId,
            "pending ID drifted"
        );
        assertEq(
            Constants.IID_SCALED_UI_CONVERSION,
            type(IScaledUIAmountConversion).interfaceId,
            "conversion ID drifted"
        );
        assertEq(
            Constants.IID_SCALED_UI_BALANCES,
            type(IScaledUIAmountBalances).interfaceId,
            "balances ID drifted"
        );
    }

    /// @notice The four literals from the published EIP table, hardcoded.
    /// @dev Deliberately duplicated as raw literals rather than referencing
    ///      `Constants`, so that editing `Constants` to chase a spec change
    ///      cannot silently make this test vacuous.
    function test_InterfaceIds_MatchPublishedTable() public pure {
        assertEq(Constants.IID_SCALED_UI_CORE, bytes4(0xa60bf13d));
        assertEq(Constants.IID_SCALED_UI_PENDING, bytes4(0x4bd27648));
        assertEq(Constants.IID_SCALED_UI_CONVERSION, bytes4(0x57854fc3));
        assertEq(Constants.IID_SCALED_UI_BALANCES, bytes4(0xd890fd71));
    }

    function test_SupportsInterface_AllFourClaimed() public view {
        assertTrue(token.supportsInterface(Constants.IID_SCALED_UI_CORE));
        assertTrue(token.supportsInterface(Constants.IID_SCALED_UI_PENDING));
        assertTrue(token.supportsInterface(Constants.IID_SCALED_UI_CONVERSION));
        assertTrue(token.supportsInterface(Constants.IID_SCALED_UI_BALANCES));
    }

    /// @notice USDOku claims NO ERC-8056 interface: its `balanceOf` is already
    ///         dollar-denominated, and an 8056-aware wallet applying a multiplier
    ///         on top would double-scale it.
    function test_UsdOku_DoesNotClaimErc8056() public view {
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_CORE));
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_PENDING));
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_CONVERSION));
        assertFalse(usdOku.supportsInterface(Constants.IID_SCALED_UI_BALANCES));
    }

    /// @notice ERC-4626 is deliberately NOT claimed — we ship the conversion
    ///         subset only, and claiming it would be false advertisement.
    function test_SupportsInterface_DoesNotClaimErc4626() public view {
        // ERC-4626 defines no ERC-165 ID of its own; assert we return false for
        // the XOR of the conversion-subset selectors we *do* implement, i.e. we
        // are not opportunistically registering a 4626-shaped ID.
        bytes4 pseudo4626 = bytes4(keccak256("asset()")) ^ bytes4(keccak256("totalAssets()"))
            ^ bytes4(keccak256("convertToShares(uint256)"))
            ^ bytes4(keccak256("convertToAssets(uint256)"));
        assertFalse(token.supportsInterface(pseudo4626));
    }

    function test_SupportsInterface_UnknownIdIsFalse() public view {
        assertFalse(token.supportsInterface(bytes4(0xdeadbeef)));
    }

    // ============ Genesis state ============

    /// @notice Spec Test Case 1: initial multiplier is 1.0 and UI == raw.
    function test_InitialMultiplierIsOne() public view {
        assertEq(token.uiMultiplier(), Constants.PRECISION);
        assertEq(token.newUIMultiplier(), Constants.PRECISION);
    }

    function test_InitialState_BalanceEqualsBalanceUI() public {
        _mintRaw(user1, 1000e18);
        assertEq(token.balanceOf(user1), token.balanceOfUI(user1));
        assertEq(token.totalSupply(), token.totalSupplyUI());
    }

    /// @notice `initialize` stamps `lastSteppedAt`, so `effectiveAt()` is the
    ///         deploy timestamp rather than zero and staleness math never
    ///         underflows.
    function test_Genesis_EffectiveAtIsDeployTimestamp() public view {
        assertEq(token.effectiveAt(), block.timestamp, "deployed in this block at ts=1");
        assertEq(token.effectiveAt(), token.lastSteppedAt());
        assertGt(token.effectiveAt(), 0);
    }

    // ============ Spec Test Case 2: the "2x split" ============

    function test_DoublingMultiplier_DoublesUiBalance() public {
        _mintRaw(user1, 1000e18);
        uint256 rawBefore = token.balanceOf(user1);

        // Drive the multiplier to >= 2e18 by repeated maximum steps.
        _stepToAtLeast(2 * Constants.PRECISION);

        assertEq(token.balanceOf(user1), rawBefore, "raw balance must not move");
        assertGe(token.balanceOfUI(user1), 2 * rawBefore, "UI balance should have >= doubled");
        assertEq(token.toUIAmount(rawBefore), token.balanceOfUI(user1));
    }

    // ============ Conversion extension ============

    function test_Conversion_IdentityAtUnitMultiplier() public view {
        assertEq(token.toUIAmount(12_345e18), 12_345e18);
        assertEq(token.fromUIAmount(12_345e18), 12_345e18);
    }

    function test_Conversion_RoundTripWithinOneWei() public {
        // A deliberately non-round multiplier so flooring is actually exercised.
        _step(1_034_567_891_234_567_891);
        uint256[5] memory xs = [uint256(1), 1e6, 1e18, 123_456_789e18, 999_999_999_999_999_999];
        for (uint256 i = 0; i < xs.length; ++i) {
            uint256 back = token.fromUIAmount(token.toUIAmount(xs[i]));
            assertLe(back, xs[i], "round trip must not exceed input");
            assertGe(back + 1, xs[i], "round trip must lose at most 1 wei");
        }
    }

    function test_Conversion_ZeroIsZero() public view {
        assertEq(token.toUIAmount(0), 0);
        assertEq(token.fromUIAmount(0), 0);
    }

    // ============ Balances extension ============

    /// @notice Per-balance flooring means the sum is bounded ABOVE by the total,
    ///         never equal to it. Do not tighten this to an equality.
    function test_Balances_SumBoundedByTotalSupplyUI() public {
        _mintRaw(user1, 333e18 + 7);
        _mintRaw(user2, 111e18 + 13);
        _mintRaw(user3, 1);
        _step(1_017_777_777_777_777_777);

        uint256 sum = token.balanceOfUI(user1) + token.balanceOfUI(user2) + token.balanceOfUI(user3);
        uint256 total = token.totalSupplyUI();
        assertLe(sum, total, "sum of floors cannot exceed total");
        assertGe(sum + 3, total, "gap bounded by holder count");
    }

    // ============ The immediate-step invariant ============

    /// @notice `uiMultiplier() == newUIMultiplier()` holds at EVERY moment: at
    ///         genesis, in the write block, and arbitrarily far after — steps are
    ///         immediate and future-dated steps are deliberately unsupported.
    function test_ImmediateStep_PendingAlwaysEqualsLive() public {
        assertEq(token.uiMultiplier(), token.newUIMultiplier(), "genesis");

        _stepNoWarp(1.0005e18);
        assertEq(token.uiMultiplier(), 1.0005e18, "step is live in its own block");
        assertEq(token.newUIMultiplier(), 1.0005e18, "pending == live in the write block");
        assertEq(token.effectiveAt(), block.timestamp, "effectiveAt is the write timestamp");

        vm.warp(block.timestamp + 365 days);
        assertEq(token.uiMultiplier(), token.newUIMultiplier(), "and forever after");
        assertEq(token.uiMultiplier(), 1.0005e18, "stepwise: flat between steps");
    }

    /// @notice `effectiveAt()` tracks the LAST step, not any schedule.
    function test_EffectiveAt_TracksLastStep() public {
        uint256 t0 = block.timestamp;
        assertEq(token.effectiveAt(), t0);

        _stepBy(10); // steps now, then warps past the window
        uint256 stepTs = block.timestamp - token.syncWindowDuration();
        assertEq(token.effectiveAt(), stepTs);

        vm.warp(block.timestamp + 30 days);
        assertEq(token.effectiveAt(), stepTs, "flat until the next step");
    }

    /// @notice Between steps the multiplier is exactly flat: no time-based drift.
    function test_Stepwise_FlatBetweenSteps() public {
        _stepBy(25);
        uint256 frozen = token.uiMultiplier();
        vm.warp(block.timestamp + 3650 days);
        assertEq(token.uiMultiplier(), frozen, "no continuous accrual on OkuM");
    }

    // ============ Event emission ============

    function test_UIMultiplierUpdated_EmittedOnEveryStep() public {
        _setFeesForStep(10);
        vm.recordLogs();
        vm.prank(rateSetter);
        token.setOkuMultiplier(1.0001e18); // 1 bps: inside MAX_STEP_BPS

        bytes32 sig = keccak256("UIMultiplierUpdated(uint256,uint256,uint256)");
        bool found;
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].topics[0] == sig) found = true;
        }
        assertTrue(found, "ERC-8056 requires UIMultiplierUpdated on every change");
    }

    function test_TransferWithUIAmount_EmittedOnTransfer() public {
        _mintRaw(user1, 100e18);
        _stepBy(30);

        uint256 expectedUi = token.toUIAmount(40e18);
        vm.expectEmit(true, true, false, true, address(token));
        emit IScaledUIAmount.TransferWithUIAmount(user1, user2, 40e18, expectedUi);
        vm.prank(user1);
        token.transfer(user2, 40e18);
    }

    /// @notice The reference implementation emits `TransferWithUIAmount` from
    ///         `_update`, which also fires on mint and burn where the counterparty
    ///         UI amount is meaningless. We emit only for genuine transfers.
    function test_TransferWithUIAmount_NotEmittedOnMintOrBurn() public {
        bytes32 sig = keccak256("TransferWithUIAmount(address,address,uint256,uint256)");

        vm.recordLogs();
        _mintRaw(user1, 10e18);
        Vm.Log[] memory mintLogs = vm.getRecordedLogs();
        for (uint256 i = 0; i < mintLogs.length; ++i) {
            assertTrue(mintLogs[i].topics[0] != sig, "must not emit on mint");
        }

        _mintRaw(burner, 10e18);
        vm.recordLogs();
        vm.prank(burner);
        token.burn(10e18);
        Vm.Log[] memory burnLogs = vm.getRecordedLogs();
        for (uint256 i = 0; i < burnLogs.length; ++i) {
            assertTrue(burnLogs[i].topics[0] != sig, "must not emit on burn");
        }
    }

    // ============ Raw layer is untouched stock OZ ============

    /// @notice ERC-8056 Implementation Requirement 3: standard ERC-20 functions
    ///         MUST continue to work with raw amounts.
    function test_RawLayer_BalanceStaticAcrossAYearOfSteps() public {
        _mintRaw(user1, 1000e18);
        uint256 raw = token.balanceOf(user1);
        uint256 supply = token.totalSupply();

        // ~Monthly marks for a year at ~40 bps each.
        for (uint256 i = 0; i < 12; ++i) {
            _stepBy(40);
            vm.warp(block.timestamp + 30 days);
        }

        assertEq(token.balanceOf(user1), raw, "raw balance must never move on a step");
        assertEq(token.totalSupply(), supply, "raw supply must never move on a step");
        assertGt(token.balanceOfUI(user1), raw, "but UI balance must have grown");
    }

    function test_RawLayer_TransferMovesRawNotUi() public {
        _mintRaw(user1, 100e18);
        _stepBy(40);

        vm.prank(user1);
        token.transfer(user2, 30e18);

        assertEq(token.balanceOf(user1), 70e18);
        assertEq(token.balanceOf(user2), 30e18);
    }

    /// @notice Allowances are raw-denominated, so their dollar value drifts upward
    ///         with the multiplier. Limitation 7 — surfaced on-chain via
    ///         `allowanceUI` so wallets can warn without importing an SDK.
    function test_AllowanceUI_DriftsWithMultiplier() public {
        vm.prank(user1);
        token.approve(user2, 100e18);
        assertEq(token.allowanceUI(user1, user2), 100e18);

        _stepBy(40);

        assertEq(token.allowance(user1, user2), 100e18, "raw allowance is unchanged");
        assertGt(token.allowanceUI(user1, user2), 100e18, "but its dollar value grew");
    }
}
