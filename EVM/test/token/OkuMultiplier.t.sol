// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {ScaledUIAmountUpgradeable} from "../../src/lib/ScaledUIAmountUpgradeable.sol";
import {OkuM} from "../../src/token/OkuM.sol";
import {Roles} from "../../src/lib/Roles.sol";
import {IScaledUIAmount} from "../../src/interfaces/erc8056/IScaledUIAmount.sol";
import {ScaledUIHarness} from "../mocks/ScaledUIHarness.sol";

/**
 * @title OkuMultiplierTest
 * @notice The `M_oku` step authority: every bound, the guardian lever, step
 *         coverage and the high-water-mark ratchet. `setOkuMultiplier` is an
 *         oracle write, so this is the suite an auditor should read first.
 *
 * @dev CHECK ORDER inside `setOkuMultiplier`, pinned by the tests below:
 *        1. role gate (`OKU_RATE_SETTER`)
 *        2. guardian halt flag           -> `AccrualIsHalted`
 *        3. monotonicity (strict)        -> `MultiplierCannotDecrease`
 *        4. `MAX_MULTIPLIER` ceiling     -> `MultiplierAboveMaximum`
 *        5. `MAX_STEP_BPS` per step      -> `StepAboveMaximum` (stepBps ceils)
 *        6. arm the sync window
 *
 *      There is NO step-coverage check here any more. The token does not read
 *      the module's fee schedule at all: coverage is guaranteed by the static
 *      per-leg floor in `SubscriptionModule.setFees` composed with check 5.
 *      See `StepArbitrageTest` for that invariant.
 */
contract OkuMultiplierTest is BaseTest {
    // ============ Monotonicity (strict) ============

    function test_Step_EqualValueReverts() public {
        _setFeesForStep(Constants.MAX_STEP_BPS);
        uint256 current = token.uiMultiplier();
        vm.prank(rateSetter);
        vm.expectRevert(Errors.MultiplierCannotDecrease.selector);
        token.setOkuMultiplier(current);
    }

    function test_Step_LowerValueReverts() public {
        _setFeesForStep(Constants.MAX_STEP_BPS);
        _stepBy(50);
        uint256 current = token.uiMultiplier();
        vm.prank(rateSetter);
        vm.expectRevert(Errors.MultiplierCannotDecrease.selector);
        token.setOkuMultiplier(current - 1);
    }

    function test_Step_MonotoneAcrossManySteps() public {
        uint256 previous = token.uiMultiplier();
        for (uint256 i = 0; i < 10; ++i) {
            _stepBy(10 + i);
            uint256 current = token.uiMultiplier();
            assertGt(current, previous, "multiplier must be strictly monotone per step");
            previous = current;
        }
    }

    // ============ MAX_STEP_BPS ============

    function test_Step_AboveMaxStepReverts() public {
        // Fees at their combined max (200 bps) so coverage is NOT the binding
        // constraint — this isolates the per-step ceiling.
        _setFeesForStep(Constants.MAX_STEP_BPS);
        uint256 current = token.uiMultiplier();
        uint256 tooFar = current + (current * (Constants.MAX_STEP_BPS + 1)) / Constants.BASIS_POINTS;
        vm.prank(rateSetter);
        vm.expectRevert(
            abi.encodeWithSelector(
                ScaledUIAmountUpgradeable.StepAboveMaximum.selector,
                Constants.MAX_STEP_BPS + 1,
                Constants.MAX_STEP_BPS
            )
        );
        token.setOkuMultiplier(tooFar);
    }

    function test_Step_ExactlyMaxStepAccepted() public {
        _setFeesForStep(Constants.MAX_STEP_BPS);
        uint256 current = token.uiMultiplier();
        uint256 target = current + (current * Constants.MAX_STEP_BPS) / Constants.BASIS_POINTS;
        vm.prank(rateSetter);
        token.setOkuMultiplier(target);
        assertEq(token.uiMultiplier(), target);
    }

    /// @notice `stepBps` rounds UP: one wei above a max-step target tips into
    ///         `MAX_STEP_BPS + 1` and reverts.
    function test_Step_OneWeiAboveMaxStepRoundsUpAndReverts() public {
        _setFeesForStep(Constants.MAX_STEP_BPS);
        uint256 current = token.uiMultiplier();
        uint256 target = current + (current * Constants.MAX_STEP_BPS) / Constants.BASIS_POINTS + 1;
        vm.prank(rateSetter);
        vm.expectPartialRevert(ScaledUIAmountUpgradeable.StepAboveMaximum.selector);
        token.setOkuMultiplier(target);
    }

    /// @notice `stepBps` rounds UP: a 1-wei step on 1e18 is 1 bp, not 0. The
    ///         ceil is what keeps the `MAX_STEP_BPS` comparison conservative, so
    ///         a fractionally-oversized step cannot round its way through.
    function test_StepBps_RoundsUp_OneWeiIsOneBp() public {
        uint256 old = token.uiMultiplier();

        vm.expectEmit(address(token));
        emit ScaledUIAmountUpgradeable.OkuMultiplierStepped(old, old + 1, 1);
        vm.prank(rateSetter);
        token.setOkuMultiplier(old + 1);
    }

    // ============ MAX_MULTIPLIER ============

    /// @notice The ceiling check fires BEFORE the step-size check, so a write
    ///         above 1e24 reports `MultiplierAboveMaximum` even though its step
    ///         would also have been oversized.
    function test_Step_AboveMaxMultiplierReverts() public {
        _setFeesForStep(Constants.MAX_STEP_BPS);
        vm.prank(rateSetter);
        vm.expectRevert(
            abi.encodeWithSelector(
                ScaledUIAmountUpgradeable.MultiplierAboveMaximum.selector,
                Constants.MAX_MULTIPLIER + 1,
                Constants.MAX_MULTIPLIER
            )
        );
        token.setOkuMultiplier(Constants.MAX_MULTIPLIER + 1);
    }

    /// @notice Reaching the ceiling legally: driven through the harness, because
    ///         ~1,390 max steps separate genesis from 1e24 on the real token.
    function test_Harness_StepToExactlyMaxMultiplierAccepted() public {
        ScaledUIHarness h = new ScaledUIHarness();
        h.init();
        h.forceMultiplier(Constants.MAX_MULTIPLIER - Constants.MAX_MULTIPLIER / 100_000);
        h.step(Constants.MAX_MULTIPLIER);
        assertEq(h.uiMultiplier(), Constants.MAX_MULTIPLIER);
    }

    function test_Harness_StepOneWeiPastMaxMultiplierReverts() public {
        ScaledUIHarness h = new ScaledUIHarness();
        h.init();
        h.forceMultiplier(Constants.MAX_MULTIPLIER - 1);
        vm.expectPartialRevert(ScaledUIAmountUpgradeable.MultiplierAboveMaximum.selector);
        h.step(Constants.MAX_MULTIPLIER + 1);
    }

    // ============ Step coverage lives elsewhere now ============

    /// @notice The token takes a step at deploy fees with no configuration at
    ///         all — and that is SAFE, because `initialize` seeded the module's
    ///         fees at the coverage floor.
    ///
    /// @dev This test previously asserted the opposite ("no step is possible
    ///      until `setFees`"), which was the fail-closed shipping state of the
    ///      old dynamic-coverage design. Inverted deliberately. The invariant it
    ///      protected is now structural rather than procedural: there is no
    ///      reachable state with fees below the floor, so there is nothing for
    ///      the token to check and no ordering for an operator to get wrong.
    function test_Step_PossibleImmediatelyAtDeployFees() public {
        assertEq(module.tin(), Constants.MAX_STEP_BPS, "tin ships at the floor");
        assertEq(module.tout(), Constants.MAX_STEP_BPS, "tout ships at the floor");

        vm.prank(rateSetter);
        token.setOkuMultiplier(Constants.PRECISION + 1);
        assertEq(token.uiMultiplier(), Constants.PRECISION + 1);
    }

    /// @notice The token exposes no fee-source surface. An integrator probing
    ///         for the old coupling must get a clean absence.
    /// @dev Compile-time assertion by absence: `setStepFeeSource`,
    ///      `stepFeeSource` and `stepHighWaterMark` no longer exist on `OkuM`,
    ///      so any reference here would fail to build. Asserted dynamically in
    ///      the Hardhat suite via ABI introspection.
    function test_Step_NoFeeSourceCoupling() public view {
        // The step bound is a constant, readable without touching the module.
        assertEq(Constants.MAX_STEP_BPS, 5, "provisional daily-cadence value");
        assertLe(Constants.MAX_STEP_BPS, Constants.MAX_FEE_BPS);
    }

    // ============ Guardian halt ============

    function test_HaltAccrual_BlocksSteps() public {
        _setFeesForStep(Constants.MAX_STEP_BPS);

        vm.expectEmit(address(token));
        emit OkuM.AccrualHalted(Constants.PRECISION);
        vm.prank(guardian);
        token.haltAccrual();
        assertTrue(token.accrualHalted());

        vm.prank(rateSetter);
        vm.expectRevert(OkuM.AccrualIsHalted.selector);
        token.setOkuMultiplier(Constants.PRECISION + 1);
    }

    /// @notice Cold (`OKU_CAP_MANAGER`) lifts the halt, and stepping resumes.
    function test_ResumeAccrual_Unblocks() public {
        _setFeesForStep(Constants.MAX_STEP_BPS);
        vm.prank(guardian);
        token.haltAccrual();

        vm.expectEmit(address(token));
        emit OkuM.AccrualResumed(Constants.PRECISION);
        vm.prank(capManager);
        token.resumeAccrual();
        assertFalse(token.accrualHalted());

        vm.prank(rateSetter);
        token.setOkuMultiplier(Constants.PRECISION + 1);
        assertEq(token.uiMultiplier(), Constants.PRECISION + 1);
    }

    /// @notice A halt must not arm the sync window: nothing about the current
    ///         multiplier changed, and arming would hand the warm guardian key a
    ///         repeatable mint/redeem block the RBAC model denies it.
    function test_HaltAccrual_DoesNotArmWindow() public {
        vm.prank(guardian);
        token.haltAccrual();
        assertFalse(token.isSyncLocked());
        assertEq(token.syncLockedUntil(), 0);
    }

    /// @notice Monotone-safe: the guardian can only withhold, never reduce.
    function test_HaltAccrual_CannotReduceAccruedValue() public {
        _stepBy(50);
        uint256 accrued = token.uiMultiplier();
        assertGt(accrued, Constants.PRECISION);

        vm.prank(guardian);
        token.haltAccrual();
        assertEq(token.uiMultiplier(), accrued, "value preserved, growth stopped");
    }

    // ============ Access control ============

    function test_SetOkuMultiplier_RequiresRateSetter() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.setOkuMultiplier(Constants.PRECISION + 1);
    }

    function test_HaltAccrual_RequiresGuardian() public {
        vm.prank(user1);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.haltAccrual();
    }

    /// @notice The guardian cannot step — it can only withhold. Separation of
    ///         duties is what makes a warm-multisig guardian safe.
    function test_Guardian_CannotStep() public {
        vm.prank(guardian);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.setOkuMultiplier(Constants.PRECISION + 1);
    }

    function test_RateSetter_CannotHalt() public {
        vm.prank(rateSetter);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.haltAccrual();
    }

    /// @notice `resumeAccrual` is cold-only: the guardian that halted cannot lift
    ///         its own halt.
    function test_ResumeAccrual_RequiresCapManagerNotGuardian() public {
        vm.prank(guardian);
        token.haltAccrual();
        vm.prank(guardian);
        vm.expectPartialRevert(IAccessControl.AccessControlUnauthorizedAccount.selector);
        token.resumeAccrual();
    }

    // ============ Events ============

    function test_Step_EmitsAllThreeEvents() public {
        _setFeesForStep(Constants.MAX_STEP_BPS);
        uint256 old = token.uiMultiplier();
        uint256 target = old + (old * Constants.MAX_STEP_BPS) / Constants.BASIS_POINTS;
        uint256 expectedLock = block.timestamp + token.syncWindowDuration();

        vm.expectEmit(address(token));
        emit ScaledUIAmountUpgradeable.OkuMultiplierStepped(old, target, Constants.MAX_STEP_BPS);
        vm.expectEmit(address(token));
        emit IScaledUIAmount.UIMultiplierUpdated(old, target, block.timestamp);
        vm.expectEmit(address(token));
        emit OkuM.SyncWindowArmed(expectedLock);

        vm.prank(rateSetter);
        token.setOkuMultiplier(target);
    }

    // ============ Pause interaction ============

    /// @notice Emergency levers must survive a pause: correcting the multiplier
    ///         during an incident must always be possible.
    function test_SetOkuMultiplier_WorksWhilePaused() public {
        _setFeesForStep(Constants.MAX_STEP_BPS);
        vm.prank(pauser);
        token.pause();
        vm.prank(rateSetter);
        token.setOkuMultiplier(Constants.PRECISION + Constants.PRECISION / 10_000);
        assertGt(token.uiMultiplier(), Constants.PRECISION);
    }

    function test_HaltAccrual_WorksWhilePaused() public {
        vm.prank(pauser);
        token.pause();
        vm.prank(guardian);
        token.haltAccrual();
        assertTrue(token.accrualHalted());
    }

    // ============ Immediate-step invariants ============

    function test_Step_PendingEqualsLiveAndEffectiveAtIsNow() public {
        _stepBy(25);
        assertEq(token.uiMultiplier(), token.newUIMultiplier(), "steps are immediate");
        // `_step` warps to the end of the sync window; `effectiveAt` stays at
        // the write timestamp.
        assertEq(token.effectiveAt(), block.timestamp - token.syncWindowDuration());
        assertEq(token.lastSteppedAt(), token.effectiveAt());
    }

    // ============ Fuzz: any covered legal step lands ============

    function testFuzz_Step_AnyCoveredLegalStepLands(uint256 bps) public {
        bps = _bound(bps, 1, Constants.MAX_STEP_BPS);
        _setFeesForStep(bps);
        uint256 old = token.uiMultiplier();
        uint256 target = old + (old * bps) / Constants.BASIS_POINTS;
        vm.prank(rateSetter);
        token.setOkuMultiplier(target);
        assertEq(token.uiMultiplier(), target);
    }
}
