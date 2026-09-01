// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

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
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";

/**
 * @title ERC8056ConformanceTest
 * @notice Conformance suite for ERC-8056 (Scaled UI Amount Extension) on OkuMoney.
 *
 * @dev Spec: https://eips.ethereum.org/EIPS/eip-8056 (draft, created 2025-10-20).
 *
 *      ## Scope note — a deliberate extension beyond the standard's stated purpose
 *
 *      ERC-8056 was written for STOCK SPLITS. Its abstract describes the multiplier as
 *      "a cosmetic layer ... while maintaining the underlying token economics" — a
 *      2-for-1 split doubles the share count and halves the price, so it is
 *      value-neutral and cannot be arbitraged.
 *
 *      OkuMoney uses the same multiplier as the SETTLEMENT PRICE for PSM mint/redeem
 *      and vault wrap/unwrap. That is value-ADDITIVE: the multiplier rises and nothing
 *      falls. This is outside what the standard was designed for, and it is precisely
 *      why the multiplier must move continuously rather than in the discrete steps the
 *      EIP's own reference implementation uses. See `OkuMoney` NatSpec.
 *
 *      Only the interface is borrowed. The tests below verify we conform to the
 *      normative requirements: ERC-165 detection, 18-decimal precision, unchanged
 *      raw-amount ERC-20 semantics, and event emission on multiplier change.
 */
contract ERC8056ConformanceTest is BaseTest {
    event UIMultiplierUpdated(
        uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp
    );

    // ============ Interface IDs ============

    /// @notice The four interface IDs match the literals published in the EIP.
    /// @dev Computed from the interface definitions rather than hardcoded, so a change
    ///      to either the interfaces or the pinned constants surfaces here.
    function test_InterfaceIds_MatchPublishedSpec() public pure {
        assertEq(
            type(IScaledUIAmount).interfaceId,
            bytes4(0xa60bf13d),
            "IScaledUIAmount ID must match the EIP"
        );
        assertEq(
            type(IScaledUIAmountNewUIMultiplier).interfaceId,
            bytes4(0x4bd27648),
            "IScaledUIAmountNewUIMultiplier ID must match the EIP"
        );
        assertEq(
            type(IScaledUIAmountConversion).interfaceId,
            bytes4(0x57854fc3),
            "IScaledUIAmountConversion ID must match the EIP"
        );
        assertEq(
            type(IScaledUIAmountBalances).interfaceId,
            bytes4(0xd890fd71),
            "IScaledUIAmountBalances ID must match the EIP"
        );
    }

    /// @notice The constants pinned in `Constants.sol` agree with the interfaces.
    function test_PinnedConstants_MatchInterfaceIds() public pure {
        assertEq(Constants.IID_SCALED_UI_AMOUNT, type(IScaledUIAmount).interfaceId);
        assertEq(
            Constants.IID_SCALED_UI_NEW_MULTIPLIER, type(IScaledUIAmountNewUIMultiplier).interfaceId
        );
        assertEq(Constants.IID_SCALED_UI_CONVERSION, type(IScaledUIAmountConversion).interfaceId);
        assertEq(Constants.IID_SCALED_UI_BALANCES, type(IScaledUIAmountBalances).interfaceId);
    }

    // ============ ERC-165 detection (normative) ============

    /// @notice "Compliant contracts MUST implement ERC-165 and return true when queried
    ///         for the IScaledUIAmount interface ID."
    function test_SupportsInterface_CoreAndAllExtensions() public view {
        assertTrue(okuMoney.supportsInterface(Constants.IID_SCALED_UI_AMOUNT), "core interface");
        assertTrue(
            okuMoney.supportsInterface(Constants.IID_SCALED_UI_NEW_MULTIPLIER),
            "pending-multiplier extension (required)"
        );
        assertTrue(
            okuMoney.supportsInterface(Constants.IID_SCALED_UI_CONVERSION), "conversion extension"
        );
        assertTrue(
            okuMoney.supportsInterface(Constants.IID_SCALED_UI_BALANCES), "balances extension"
        );
    }

    /// @notice ERC-165 itself is still advertised, and unknown IDs are rejected.
    function test_SupportsInterface_ERC165AndUnknown() public view {
        assertTrue(okuMoney.supportsInterface(type(IERC165).interfaceId), "ERC-165 itself");
        assertFalse(okuMoney.supportsInterface(bytes4(0xdeadbeef)), "unknown ID must be false");
    }

    // ============ Precision (normative) ============

    /// @notice "The UI multiplier MUST use 18 decimal places (1e18 represents 1.0)."
    function test_UIMultiplier_Uses18Decimals() public view {
        assertEq(okuMoney.uiMultiplier(), 1e18, "fresh deploy must report exactly 1.0");
    }

    /// @notice `uiMultiplier()` is the ERC-8056 view of `okuMMultiplier()`.
    function test_UIMultiplier_TracksOkuMMultiplier() public {
        _mintOkuMoney(user1, 10_000e18);
        _distributeYield(100e18);

        assertEq(
            okuMoney.uiMultiplier(),
            okuMoney.okuMMultiplier(),
            "uiMultiplier must mirror okuMMultiplier"
        );
        assertGt(okuMoney.uiMultiplier(), 1e18, "must have appreciated");
    }

    // ============ Backwards compatibility (normative) ============

    /// @notice "Standard ERC-20 functions MUST continue to work with raw amounts."
    function test_ERC20Functions_OperateOnRawAmounts() public {
        _mintOkuMoney(user1, 100e18);
        _distributeYield(1e18); // move the multiplier off 1.0

        assertGt(okuMoney.uiMultiplier(), 1e18, "precondition: multiplier moved");

        // balanceOf / totalSupply stay raw despite the multiplier.
        assertEq(okuMoney.balanceOf(user1), 100e18, "balanceOf must remain raw");

        // transfer moves raw units.
        vm.prank(user1);
        okuMoney.transfer(user2, 40e18);
        assertEq(okuMoney.balanceOf(user1), 60e18, "raw transfer semantics");
        assertEq(okuMoney.balanceOf(user2), 40e18, "raw transfer semantics");
    }

    // ============ Conversion extension ============

    function test_ToUIAmount_AppliesMultiplier() public {
        _mintOkuMoney(user1, 10_000e18);
        _runYieldEpochTo(2e18, 0); // exactly 2.0

        assertEq(okuMoney.uiMultiplier(), 2e18, "precondition: multiplier is 2.0");
        assertEq(okuMoney.toUIAmount(100e18), 200e18, "100 raw at 2.0 == 200 UI");
        assertEq(okuMoney.fromUIAmount(200e18), 100e18, "200 UI at 2.0 == 100 raw");
    }

    /// @notice Round-tripping through the conversion pair can lose 1 wei.
    /// @dev Both directions floor, so `fromUIAmount(toUIAmount(x))` is `x` or `x - 1`.
    ///      A max-send MUST be computed from the raw `balanceOf`, never by
    ///      round-tripping. Pinned here so integrators can rely on the bound.
    function test_ConversionRoundTrip_LosesAtMostOneWei() public {
        _mintOkuMoney(user1, 10_000e18);
        _distributeYield(137e18); // non-even multiplier

        uint256[5] memory samples = [uint256(1), 7, 12_345, 1e18, 987_654_321_123_456_789];
        for (uint256 i = 0; i < samples.length; i++) {
            uint256 back = okuMoney.fromUIAmount(okuMoney.toUIAmount(samples[i]));
            assertLe(back, samples[i], "round trip must never inflate");
            assertGe(back + 1, samples[i], "round trip must lose at most 1 wei");
        }
    }

    function testFuzz_ConversionRoundTrip_NeverInflates(uint256 raw) public {
        _mintOkuMoney(user1, 10_000e18);
        _distributeYield(137e18);

        raw = bound(raw, 0, 1e30);
        uint256 back = okuMoney.fromUIAmount(okuMoney.toUIAmount(raw));
        assertLe(back, raw, "round trip must never inflate a balance");
    }

    // ============ Balances extension ============

    function test_BalanceOfUI_AndTotalSupplyUI() public {
        _mintOkuMoney(user1, 10_000e18);
        _runYieldEpochTo(2e18, 0);

        assertEq(okuMoney.balanceOfUI(user1), 20_000e18, "UI balance applies the multiplier");
        assertEq(
            okuMoney.totalSupplyUI(),
            okuMoney.toUIAmount(okuMoney.totalSupply()),
            "UI supply applies the multiplier"
        );
    }

    // ============ Pending-multiplier extension (required) ============

    /// @notice With a successor scheduled, the extension reports it.
    function test_PendingMultiplier_ReflectsScheduledEpoch() public {
        _mintOkuMoney(user1, 10_000e18);
        uint256 duration = 30 days;

        vm.prank(rebaser);
        okuMoney.startYieldEpoch(100e18, duration);
        uint256 boundary = block.timestamp + duration;

        vm.prank(rebaser);
        okuMoney.scheduleYieldEpoch(100e18, duration);

        assertEq(okuMoney.effectiveAt(), boundary, "effectiveAt is the successor's start");

        // At `effectiveAt` the live multiplier equals the advertised pending value.
        uint256 advertised = okuMoney.newUIMultiplier();
        vm.warp(boundary);
        assertEq(
            okuMoney.uiMultiplier(),
            advertised,
            "uiMultiplier must equal newUIMultiplier at effectiveAt"
        );
    }

    /// @notice With nothing scheduled, the extension reports the current epoch's
    ///         terminal state — the next value the multiplier is committed to reach.
    function test_PendingMultiplier_WithoutScheduledEpoch() public {
        _mintOkuMoney(user1, 10_000e18);
        uint256 duration = 30 days;

        vm.prank(rebaser);
        okuMoney.startYieldEpoch(100e18, duration);
        uint256 end = block.timestamp + duration;

        assertEq(okuMoney.effectiveAt(), end, "effectiveAt is the active epoch's end");

        uint256 advertised = okuMoney.newUIMultiplier();
        vm.warp(end);
        assertEq(okuMoney.uiMultiplier(), advertised, "advertised value must be reached");
    }

    // ============ Event emission (normative) ============

    /// @notice "The UIMultiplierUpdated event MUST be emitted whenever the multiplier
    ///         is changed."
    /// @dev Emitted whenever the multiplier's TRAJECTORY changes — starting,
    ///      scheduling or halting an epoch. It cannot fire on every per-second
    ///      increment; see the conformance note in `OkuMoney`.
    function test_UIMultiplierUpdated_EmittedOnEpochStart() public {
        _mintOkuMoney(user1, 10_000e18);

        uint256 supply = okuMoney.totalSupply();
        uint256 duration = 30 days;
        uint256 yieldAmount = 100e18;
        uint256 rate = ((yieldAmount * PRECISION) / supply) / duration;

        vm.expectEmit(false, false, false, true);
        emit UIMultiplierUpdated(PRECISION, PRECISION + rate * duration, block.timestamp);

        vm.prank(rebaser);
        okuMoney.startYieldEpoch(yieldAmount, duration);
    }

    function test_UIMultiplierUpdated_EmittedOnHalt() public {
        _mintOkuMoney(user1, 10_000e18);
        vm.prank(rebaser);
        okuMoney.startYieldEpoch(100e18, 30 days);
        vm.warp(block.timestamp + 1 days);

        uint256 frozen = okuMoney.okuMMultiplier();

        vm.expectEmit(false, false, false, true);
        emit UIMultiplierUpdated(frozen, frozen, block.timestamp);

        vm.prank(rebaser);
        okuMoney.haltAccrual();
    }

    // ============ Monotonicity (Oku-specific guarantee) ============

    /// @notice The multiplier is monotonically non-decreasing.
    /// @dev Not required by the EIP — a stock split can go either way — but it is a
    ///      hard guarantee here, because a decrease would retroactively undercollateralize
    ///      the vault and strand anyone who had already redeemed. Integrators may rely
    ///      on it: a cached value can be stale, but never an overstatement.
    function test_UIMultiplier_IsMonotonic() public {
        _mintOkuMoney(user1, 10_000e18);
        uint256 last = okuMoney.uiMultiplier();

        for (uint256 i = 0; i < 5; i++) {
            _distributeYield(50e18);
            uint256 current = okuMoney.uiMultiplier();
            assertGe(current, last, "uiMultiplier must never decrease");
            last = current;
        }
    }
}
