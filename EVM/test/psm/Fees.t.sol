// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {MathLib} from "../../src/lib/MathLib.sol";
import {Roles} from "../../src/lib/Roles.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {RedemptionQueue} from "../../src/psm/RedemptionQueue.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

/**
 * @title FeesTest
 * @notice PSM `tin` / `tout`, restored from the upstream `dss-lite-psm` design.
 *
 * @dev WHY THIS EXISTS ON EVM. `tout` is the control for *local* step
 *      arbitrage — minting at M0, holding across a discrete multiplier step, and
 *      redeeming at M1. That surface does not exist on this chain: accrual is
 *      continuous, so there is no step to hold across. It exists on SVM, where
 *      the Token-2022 `ScaledUiAmount` multiplier moves in jumps, and that is
 *      where `tout` is load-bearing (see `sync-window-and-fees.ts`, which
 *      demonstrates the attack and the fix). Here the parameters exist for
 *      upstream parity and to keep the fee schedule, runbook and monitoring
 *      symmetric across chains.
 *
 *      THE TWO TRAPS. Two pre-existing checks were written against a fee-free
 *      world and would have reverted every fee-bearing operation:
 *
 *        1. `_redeem`'s slippage floor compared a payout against a fee-free
 *           expectation, so any `tout > 0` reverted with `OutputBelowMinimum`.
 *        2. `mint`'s round-trip drift check tolerates one USDC unit, so any
 *           `tin > 0` reverted with `RoundTripDriftTooLarge` — treating the fee
 *           as conversion error.
 *
 *      Both are pinned by regression tests below. Both are no-ops at zero fees,
 *      which is what lets the mechanism ship inert.
 */
contract FeesTest is BaseTest {
    uint256 internal constant TOUT = 50; // 50 bps
    uint256 internal constant TIN = 25; // 25 bps

    function setUp() public override {
        super.setUp();
        _seedBuffer(1_000_000e6);
    }

    function _setFees(uint256 tin_, uint256 tout_) internal {
        vm.prank(capManager);
        litePsm.setFees(tin_, tout_);
    }

    function _redeemAs(address user, uint256 raw) internal returns (uint256) {
        vm.startPrank(user);
        token.approve(address(litePsm), raw);
        uint256 out = litePsm.redeem(raw);
        vm.stopPrank();
        return out;
    }

    // ============ Ships inert ============

    function test_ShipsInert_BothFeesZero() public view {
        assertEq(litePsm.tin(), 0);
        assertEq(litePsm.tout(), 0);
    }

    /// @dev At zero fees the fee helpers must be exact identities, so existing
    ///      behaviour is bit-for-bit unchanged rather than approximately so.
    function test_ShipsInert_FeeMathIsIdentity() public pure {
        assertEq(MathLib.feeAmount(0, 0), 0);
        assertEq(MathLib.feeAmount(type(uint128).max, 0), 0);
        assertEq(MathLib.applyFee(12_345_678, 0), 12_345_678);
        assertEq(MathLib.applyFee(type(uint128).max, 0), type(uint128).max);
    }

    // ============ Regression: the two traps ============

    /// @notice REGRESSION. The slippage floor previously compared a post-fee
    ///         payout against a fee-free expectation, so enabling `tout` reverted
    ///         every redemption with `OutputBelowMinimum`. Both sides must be
    ///         post-fee.
    function test_Regression_ToutDoesNotTripSlippageFloor() public {
        uint256 raw = _psmMint(user1, 1000e6);
        _setFees(0, TOUT);

        uint256 out = _redeemAs(user1, raw);
        assertGt(out, 0, "redemption reverted or paid nothing with tout enabled");
    }

    /// @notice REGRESSION. The round-trip drift check tolerates exactly one USDC
    ///         unit, so enabling `tin` reverted every mint with
    ///         `RoundTripDriftTooLarge` — the fee is an intended deduction, not
    ///         drift. Must compare against the post-`tin` credited amount.
    function test_Regression_TinDoesNotTripRoundTripDrift() public {
        _setFees(TIN, 0);

        uint256 raw = _psmMint(user1, 1000e6);
        assertGt(raw, 0, "mint reverted or minted nothing with tin enabled");
    }

    /// @dev Both traps are sensitive to a nonzero multiplier too — the original
    ///      checks interact with accrual, so re-assert away from parity.
    function test_Regression_TrapsHoldAtNonUnitMultiplier() public {
        _accrue(RATE_5_PCT_APY, Constants.MAX_RATE_DURATION);
        assertGt(token.uiMultiplier(), Constants.PRECISION, "fixture must have accrued");

        _setFees(TIN, TOUT);
        uint256 raw = _psmMint(user1, 1000e6);
        assertGt(raw, 0);
        assertGt(_redeemAs(user1, raw), 0);
    }

    // ============ Arithmetic ============

    function test_Tout_WithholdsExactCeilRoundedFee() public {
        uint256 raw = _psmMint(user1, 1000e6);
        _setFees(0, TOUT);

        uint256 gross = MathLib.dollarsToUsdc(
            MathLib.toUiAmount(raw, token.uiMultiplier()), token.usdcDecimalMultiplier()
        );
        uint256 expected = gross - Math_ceilDiv(gross * TOUT, Constants.BASIS_POINTS);

        uint256 before = usdc.balanceOf(user1);
        _redeemAs(user1, raw);
        assertEq(usdc.balanceOf(user1) - before, expected, "tout arithmetic");
    }

    function test_Tin_MintsAgainstPostFeeDeposit() public {
        _setFees(TIN, 0);
        uint256 deposit = 1000e6;

        uint256 credited = deposit - Math_ceilDiv(deposit * TIN, Constants.BASIS_POINTS);
        uint256 expected = MathLib.fromUiAmount(
            MathLib.usdcToDollars(credited, token.usdcDecimalMultiplier()), token.uiMultiplier()
        );

        assertEq(_psmMint(user1, deposit), expected, "tin arithmetic");
    }

    /// @dev The fee rounds toward the protocol, so a dust-spam loop cannot
    ///      extract the rounding remainder.
    function test_Fee_RoundsUpNotDown() public pure {
        // 1 * 50 / 10_000 = 0.005 -> ceil = 1.
        assertEq(MathLib.feeAmount(1, 50), 1);
        assertEq(MathLib.applyFee(1, 50), 0);
        // 201 * 50 / 10_000 = 1.005 -> ceil = 2.
        assertEq(MathLib.feeAmount(201, 50), 2);
    }

    /// @dev Fees are withheld, never forwarded: no recipient, no sweep. The
    ///      buffer keeps them, so a fee raises the collateral ratio.
    function test_Fee_AccruesToBuffer() public {
        uint256 raw = _psmMint(user1, 1000e6);
        _setFees(0, TOUT);

        uint256 gross = MathLib.dollarsToUsdc(
            MathLib.toUiAmount(raw, token.uiMultiplier()), token.usdcDecimalMultiplier()
        );
        uint256 psmBefore = usdc.balanceOf(address(litePsm));
        uint256 paid = _redeemAs(user1, raw);
        uint256 psmDelta = psmBefore - usdc.balanceOf(address(litePsm));

        assertEq(psmDelta, paid, "buffer gave up exactly the net payout");
        assertGt(gross - psmDelta, 0, "fee was withheld from the buffer outflow");
    }

    /// @dev A dust redemption whose whole payout rounds into the fee must revert
    ///      rather than burn the user's tokens for a zero transfer.
    function test_Tout_RejectsRedemptionFullyConsumedByFee() public {
        _psmMint(user1, 1000e6);
        _setFees(0, Constants.MAX_FEE_BPS);

        // One USDC-unit's worth of raw: gross = 1, fee = ceil(1 * 100/10000) = 1,
        // net = 0.
        uint256 dust = token.usdcDecimalMultiplier();
        vm.startPrank(user1);
        token.approve(address(litePsm), dust);
        vm.expectRevert(LitePSM.AmountTooSmall.selector);
        litePsm.redeem(dust);
        vm.stopPrank();
    }

    // ============ Quotes ============

    /// @dev A fee-free quote would over-promise output and mis-size every
    ///      downstream trade, so the quotes must agree with reality exactly.
    function test_Quotes_MatchActualUnderFees() public {
        _setFees(TIN, TOUT);

        uint256 quotedRaw = litePsm.quoteMint(1000e6);
        uint256 actualRaw = _psmMint(user1, 1000e6);
        assertEq(quotedRaw, actualRaw, "quoteMint must be fee-inclusive");

        uint256 quotedUsdc = litePsm.quoteRedeem(actualRaw);
        uint256 actualUsdc = _redeemAs(user1, actualRaw);
        assertEq(quotedUsdc, actualUsdc, "quoteRedeem must be fee-inclusive");
    }

    // ============ Queue fee snapshot ============

    /// @notice The entry is priced at the multiplier at processing time (so the
    ///         holder keeps yield earned while waiting) but at the `tout`
    ///         snapshotted at enqueue time (so a governance fee change cannot
    ///         claw value back from someone already in the queue).
    function test_Queue_SnapshotsToutAtEnqueue() public {
        uint256 raw = _psmMint(user1, 1000e6);

        // Drain the buffer so the redemption queues. Read before the prank — an
        // external call in the argument list would consume `vm.prank`.
        uint256 buffered = usdc.balanceOf(address(litePsm));
        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(treasury, buffered);

        _setFees(0, TOUT);
        _redeemAs(user1, raw);
        assertEq(queue.queueLength(), 1, "expected a queued entry");
        // casting to 'uint16' is safe because TOUT is a 50-bps constant.
        // forge-lint: disable-next-line(unsafe-typecast)
        assertEq(queue.getQueueEntry(0).toutBps, uint16(TOUT), "tout not snapshotted");

        // Governance raises the fee AFTER this user queued.
        _setFees(0, Constants.MAX_FEE_BPS);

        uint256 gross = MathLib.dollarsToUsdc(
            MathLib.toUiAmount(raw, token.uiMultiplier()), token.usdcDecimalMultiplier()
        );
        uint256 expected = gross - Math_ceilDiv(gross * TOUT, Constants.BASIS_POINTS);

        _seedBuffer(1_000_000e6);
        uint256 before = usdc.balanceOf(user1);
        vm.prank(queueProcessor);
        litePsm.processQueue(0, 1, gross);

        assertEq(
            usdc.balanceOf(user1) - before,
            expected,
            "queued entry must settle at its snapshotted tout, not the new one"
        );
    }

    /// @dev `getQueueEntryValue` must report the net figure, since that is what
    ///      the holder will actually receive.
    function test_Queue_EntryValueIsNetOfSnapshottedFee() public {
        uint256 raw = _psmMint(user1, 1000e6);
        uint256 buffered = usdc.balanceOf(address(litePsm));
        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(treasury, buffered);

        _setFees(0, TOUT);
        _redeemAs(user1, raw);

        uint256 gross = MathLib.dollarsToUsdc(
            MathLib.toUiAmount(raw, token.uiMultiplier()), token.usdcDecimalMultiplier()
        );
        assertEq(
            queue.getQueueEntryValue(0), gross - Math_ceilDiv(gross * TOUT, Constants.BASIS_POINTS)
        );
    }

    /// @notice A fee CUT must reach users already in the queue.
    ///
    /// @dev The snapshot exists to protect them from an increase. Taking the
    ///      minimum of the snapshot and the live fee additionally passes on a
    ///      decrease, so a queued user is never left paying more than someone
    ///      redeeming instantly beside them. Nothing here is gameable: a user
    ///      cannot influence which value is lower, nor choose to be queued.
    function test_Queue_FeeCutIsPassedOnToQueuedUsers() public {
        uint256 raw = _psmMint(user1, 1000e6);
        uint256 buffered = usdc.balanceOf(address(litePsm));
        vm.prank(bufferWithdrawer);
        litePsm.withdrawUsdc(treasury, buffered);

        // Queue at the maximum fee.
        _setFees(0, Constants.MAX_FEE_BPS);
        _redeemAs(user1, raw);
        assertEq(queue.getQueueEntry(0).toutBps, uint16(Constants.MAX_FEE_BPS));

        // Governance then CUTS the fee.
        _setFees(0, TOUT);

        uint256 gross = MathLib.dollarsToUsdc(
            MathLib.toUiAmount(raw, token.uiMultiplier()), token.usdcDecimalMultiplier()
        );
        uint256 expected = gross - Math_ceilDiv(gross * TOUT, Constants.BASIS_POINTS);

        // The view is a conservative floor — it cannot see the live fee, so it
        // still reports the snapshotted (worse) rate. Erring low is correct for
        // a quote: a holder is never told to expect more than they get.
        assertLe(queue.getQueueEntryValue(0), expected, "view must not over-promise");

        // Settlement applies the better of the two.
        _seedBuffer(1_000_000e6);
        uint256 before = usdc.balanceOf(user1);
        vm.prank(queueProcessor);
        litePsm.processQueue(0, 1, gross);
        assertEq(
            usdc.balanceOf(user1) - before,
            expected,
            "queued user must receive the benefit of a fee cut"
        );
    }

    /// @dev `enqueue` re-asserts the bound because it is an external entrypoint
    ///      and the `uint16` narrowing must not be reachable with a wider value.
    function test_Queue_EnqueueRejectsOutOfRangeFee() public {
        // Impersonate the PSM, the only holder of `QUEUE_PSM`.
        vm.prank(address(litePsm));
        vm.expectRevert(
            abi.encodeWithSelector(
                RedemptionQueue.FeeAboveMaximum.selector,
                Constants.MAX_FEE_BPS + 1,
                Constants.MAX_FEE_BPS
            )
        );
        queue.enqueue(user1, 1e18, Constants.MAX_FEE_BPS + 1);
    }

    // ============ Bounds and RBAC ============

    function test_SetFees_RejectsAboveMaxOnEitherLeg() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                LitePSM.FeeAboveMaximum.selector, Constants.MAX_FEE_BPS + 1, Constants.MAX_FEE_BPS
            )
        );
        vm.prank(capManager);
        litePsm.setFees(Constants.MAX_FEE_BPS + 1, 0);

        vm.expectRevert(
            abi.encodeWithSelector(
                LitePSM.FeeAboveMaximum.selector, Constants.MAX_FEE_BPS + 1, Constants.MAX_FEE_BPS
            )
        );
        vm.prank(capManager);
        litePsm.setFees(0, Constants.MAX_FEE_BPS + 1);
    }

    function test_SetFees_AcceptsExactlyMax() public {
        _setFees(Constants.MAX_FEE_BPS, Constants.MAX_FEE_BPS);
        assertEq(litePsm.tin(), Constants.MAX_FEE_BPS);
        assertEq(litePsm.tout(), Constants.MAX_FEE_BPS);
    }

    /// @dev Gated on the PSM-namespaced `PSM_FEE_MANAGER`, not the token's
    ///      `OKU_CAP_MANAGER`. AccessControl mappings are per-contract, so
    ///      reusing the token's identifier here would have silently required a
    ///      grant on the PSM under a name that reads as a token role.
    function test_SetFees_IsFeeManagerOnly() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                psmPauser,
                Roles.PSM_FEE_MANAGER
            )
        );
        vm.prank(psmPauser);
        litePsm.setFees(0, TOUT);

        // Holding the token's cap-manager role is NOT sufficient on the PSM.
        assertTrue(token.hasRole(Roles.OKU_CAP_MANAGER, capManager));
        assertTrue(litePsm.hasRole(Roles.PSM_FEE_MANAGER, capManager));
        assertFalse(litePsm.hasRole(Roles.OKU_CAP_MANAGER, capManager));
    }

    // ============ Helpers ============

    /// @dev Local ceil-div so the expectations are computed independently of the
    ///      library under test rather than restating its implementation.
    function Math_ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }
}
