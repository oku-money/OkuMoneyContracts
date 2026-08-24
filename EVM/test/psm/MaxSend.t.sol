// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {TestConstants} from "../shared/Constants.sol";

/**
 * @title MaxSendTest
 * @notice The max-send rule, and the ported regression assertions from the
 *         May-2026 Sepolia `InsufficientBalance()` incident.
 *
 * @dev ============ WHY THIS FILE EXISTS ============
 *
 *      HISTORICAL INCIDENT (Sepolia, May 2026). The v1 PSM pulled usdOku by
 *      nominal amount and then called `unwrap(amount)` with the same value.
 *      `OkuDollar.transferFrom` floored the share conversion while
 *      `OkuDollar.unwrap` ceiled the share burn, so above a unit multiplier the
 *      two diverged by one share, the PSM held one share less than `unwrap`
 *      demanded, and the call reverted with `InsufficientBalance()`.
 *
 *      The share ledger that caused it is gone. **The shape survives.**
 *      `redeemUiAmount(uiAmount)` converts a UI amount back to raw and then moves
 *      raw — the same UI-to-raw round trip, with the same rounding sensitivity.
 *
 *      What keeps it benign is precisely one thing: `fromUIAmount` FLOORS.
 *      Under Floor, `redeemUiAmount(balanceOfUI(u))` requests at most the
 *      caller's balance and therefore cannot revert; it merely leaves up to one
 *      wei behind. Flip that direction to Ceil — the natural "fix" for the dust —
 *      and the request exceeds the balance and reverts, reproducing the incident
 *      with different internals.
 *
 *      So these assertions are not guarding a currently-live bug. They pin a
 *      rounding direction against a plausible future patch. Read them before
 *      changing any rounding in `MathLib`.
 *
 *      An earlier draft of this refactor plan asserted that a user round-tripping
 *      `balanceOfUI` into `redeemUiAmount` would hit `InsufficientBalance` today.
 *      That is false under Floor, and `test_Incident_FloorMakesRevertImpossible`
 *      below is the proof.
 */
contract MaxSendTest is BaseTest {
    uint256 internal constant DM = TestConstants.DECIMAL_MULTIPLIER;

    function setUp() public override {
        super.setUp();
        _seedBuffer(10_000_000e6);
    }

    // ============ The max-send rule ============

    /// @notice Round-tripping the display layer loses at most one wei, never gains.
    function test_RoundTrip_BoundedBelowInput() public {
        _accrue(RATE_5_PCT_APY, 20 days);
        uint256[6] memory xs =
            [uint256(1), 7, 1e6, 1e18, 333_333_333_333_333_333, type(uint128).max];
        for (uint256 i = 0; i < xs.length; ++i) {
            uint256 back = token.fromUIAmount(token.toUIAmount(xs[i]));
            assertLe(back, xs[i]);
            assertGe(back + 1, xs[i]);
        }
    }

    function testFuzz_RoundTrip_BoundedBelowInput(uint256 x, uint256 elapsed) public {
        x = _bound(x, 1, 1e30);
        elapsed = _bound(elapsed, 0, Constants.MAX_RATE_DURATION);
        if (elapsed > 0) _accrue(RATE_5_PCT_APY, elapsed);
        uint256 back = token.fromUIAmount(token.toUIAmount(x));
        assertLe(back, x, "must never manufacture raw tokens");
        assertGe(back + 1, x, "must lose at most one wei");
    }

    /// @notice THE CORRECT MAX-SEND: derive from raw `balanceOf`, never from the
    ///         displayed value. Transfers the entire balance with zero dust.
    function test_MaxSend_DerivedFromRaw_IsExact() public {
        _mintRaw(user1, 1000e18 + 7);
        _accrue(RATE_5_PCT_APY, 20 days);

        uint256 raw = token.balanceOf(user1); // this is `getMaxSendRaw()`
        vm.prank(user1);
        token.transfer(user2, raw);

        assertEq(token.balanceOf(user1), 0, "no dust left behind");
        assertEq(token.balanceOf(user2), raw);
    }

    /// @notice THE WRONG MAX-SEND: round-tripping through the display layer.
    ///         Leaves dust rather than reverting, because `fromUIAmount` floors.
    function test_MaxSend_RoundTripped_LeavesDustButNeverReverts() public {
        _mintRaw(user1, 1000e18 + 7);
        _accrue(RATE_5_PCT_APY, 20 days);

        uint256 wrong = token.fromUIAmount(token.balanceOfUI(user1));
        assertLe(wrong, token.balanceOf(user1), "the whole point: never exceeds");

        vm.prank(user1);
        token.transfer(user2, wrong);
        assertLe(token.balanceOf(user1), 1, "at most one wei of dust");
    }

    // ============ Ported incident assertions ============

    /// @notice THE REGRESSION. Under Floor rounding, redeeming the displayed
    ///         balance can never request more than the caller holds, across the
    ///         full multiplier range and the exact rate that exposed the original
    ///         incident in the field.
    function test_Incident_FloorMakesRevertImpossible() public {
        uint256[4] memory balances = [uint256(1e18), 3e17 + 7, 999_999_999_999_999_999, 12_345e18];
        uint256[4] memory horizons = [uint256(1), 1 days, 20 days, Constants.MAX_RATE_DURATION];

        for (uint256 i = 0; i < balances.length; ++i) {
            for (uint256 j = 0; j < horizons.length; ++j) {
                uint256 snap = vm.snapshotState();

                _mintRaw(user1, balances[i]);
                _accrue(RATE_5_PCT_APY, horizons[j]);

                uint256 requested = token.fromUIAmount(token.balanceOfUI(user1));
                assertLe(
                    requested,
                    token.balanceOf(user1),
                    "UI->raw round trip must never exceed the balance"
                );

                vm.revertToState(snap);
            }
        }
    }

    /// @notice `redeemUiAmount(balanceOfUI(u))` succeeds and leaves at most the
    ///         rounding dust. The end-to-end version of the assertion above,
    ///         driven through the real PSM redemption path.
    function test_Incident_RedeemUiAmountOfFullBalance_Succeeds() public {
        uint256 rawOut = _psmMint(user1, 100_000e6);
        _accrue(RATE_5_PCT_APY, 20 days);

        vm.startPrank(user1);
        token.approve(address(litePsm), type(uint256).max);
        uint256 usdcOut = litePsm.redeemUiAmount(token.balanceOfUI(user1));
        vm.stopPrank();

        assertGt(usdcOut, 0, "must pay out, not queue");
        // Dust is bounded by the round-trip loss, well under one USDC unit of raw.
        assertLt(token.balanceOf(user1), DM, "residual below USDC granularity");
        assertLt(token.balanceOf(user1), rawOut / 1e6);
    }

    /// @notice A true max-redeem uses the raw balance and clears it exactly.
    function test_Incident_RedeemRawFullBalance_ClearsExactly() public {
        _psmMint(user1, 100_000e6);
        _accrue(RATE_5_PCT_APY, 20 days);

        vm.startPrank(user1);
        token.approve(address(litePsm), type(uint256).max);
        litePsm.redeem(token.balanceOf(user1));
        vm.stopPrank();

        assertEq(token.balanceOf(user1), 0, "raw max-redeem leaves nothing");
    }

    /// @notice Quotes must agree with what the redemption actually pays, or a UI
    ///         showing the quote is lying. The incident surfaced as a revert; the
    ///         quieter failure is a quote that silently disagrees.
    function test_Incident_QuoteAgreesWithRealisedOutput() public {
        _psmMint(user1, 50_000e6);
        _accrue(RATE_5_PCT_APY, 11 days);

        uint256 rawIn = token.balanceOf(user1) / 3;
        uint256 quoted = litePsm.quoteRedeem(rawIn);

        vm.startPrank(user1);
        token.approve(address(litePsm), type(uint256).max);
        uint256 actual = litePsm.redeem(rawIn);
        vm.stopPrank();

        assertEq(actual, quoted, "quote must equal realised output");
    }

    function test_Incident_QuoteMintAgreesWithRealisedOutput() public {
        _accrue(RATE_5_PCT_APY, 11 days);
        uint256 quoted = litePsm.quoteMint(7777e6);
        uint256 actual = _psmMint(user1, 7777e6);
        assertEq(actual, quoted);
    }

    /// @notice `redeemableNow()` is safe to pass straight back into `redeem` — it
    ///         can never over-draw the buffer, because the raw figure is floored.
    function test_RedeemableNow_NeverOverdrawsBuffer() public {
        // Reset to a tight buffer so the bound actually binds.
        // NOTE: the balance read is hoisted deliberately. Inlining it as a call
        // argument would consume the `vm.prank` before `withdrawUsdc` is reached.
        uint256 seeded = usdc.balanceOf(address(litePsm));
        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(treasury, seeded);
        _seedBuffer(1337e6 + 7);

        // Mint raw directly rather than through the PSM: a PSM mint would add its
        // USDC to the buffer, defeating the tight-buffer setup this test needs.
        _mintRaw(user1, 1_000_000e18);
        _accrue(RATE_5_PCT_APY, 20 days);

        uint256 maxRaw = litePsm.redeemableNow();
        assertLe(litePsm.quoteRedeem(maxRaw), usdc.balanceOf(address(litePsm)));

        vm.startPrank(user1);
        token.approve(address(litePsm), type(uint256).max);
        uint256 usdcOut = litePsm.redeem(maxRaw);
        vm.stopPrank();

        assertGt(usdcOut, 0, "must settle instantly, not queue");
    }

    // ============ Sub-granularity rejections ============

    function test_RedeemBelowUsdcGranularity_Reverts() public {
        _mintRaw(user1, 1e18);
        vm.startPrank(user1);
        token.approve(address(litePsm), type(uint256).max);
        vm.expectRevert(LitePSM.AmountTooSmall.selector);
        litePsm.redeem(DM - 1);
        vm.stopPrank();
    }

    function test_RedeemUiAmountZero_Reverts() public {
        vm.prank(user1);
        vm.expectRevert(Errors.ZeroAmount.selector);
        litePsm.redeemUiAmount(0);
    }

    /// @notice A UI amount that floors to zero raw is rejected rather than
    ///         silently no-op'ing.
    function test_RedeemUiAmountFlooringToZero_Reverts() public {
        _accrueToAtLeast(2 * Constants.PRECISION);
        vm.prank(user1);
        vm.expectRevert(LitePSM.AmountTooSmall.selector);
        litePsm.redeemUiAmount(1);
    }
}
