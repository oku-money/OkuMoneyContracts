// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {OkuM} from "../../src/token/OkuM.sol";
import {ScaledUIAmountUpgradeable} from "../../src/lib/ScaledUIAmountUpgradeable.sol";
import {SubscriptionModule} from "../../src/psm/SubscriptionModule.sol";

/**
 * @title StepArbitrageTest
 * @notice The economic test of the whole design: a discrete `M_oku` step must
 *         not be extractable through the subscription module.
 *
 * @dev THE ATTACK. `M_oku` steps, so the round trip
 *
 *          mint at M0  ->  wait for the step  ->  redeem at M1
 *
 *      converts a mark into USDC out of the buffer. The attacker holds raw
 *      across the step and needs no transaction while the sync window is open,
 *      which is exactly why the window is NOT the defence — no window length
 *      deters someone who is simply waiting.
 *
 *      THE DEFENCE is the round-trip fee:
 *
 *          profit per unit = M1/M0 - 1 - (tin + tout)/10_000
 *
 *      so the protocol must enforce `tin + tout >= stepBps` for every step
 *      taken. Two mechanisms, both required:
 *
 *        1. `OkuM.setOkuMultiplier` refuses a step the current fees do not cover
 *           (`StepNotCovered`). Without it, fees could simply be set to zero and
 *           a large step taken.
 *        2. `SubscriptionModule.setFees` refuses to drop `tin + tout` below
 *           `stepHighWaterMark` (`FeesBelowStepFloor`). Without it, the fee could
 *           be raised for the step and lowered immediately after, leaving anyone
 *           still holding raw from before the step able to exit cheaply.
 *
 *      An earlier draft bound `tout` ALONE, which leaks the mint-side half: an
 *      attacker who mints cheaply at M0 pays only `tout` on the way out, so a
 *      `tout`-only rule prices a round trip at less than the step whenever `tin`
 *      carried part of the coverage. The invariant is on the SUM.
 */
contract StepArbitrageTest is BaseTest {
    /// @dev A deep buffer, so a redemption never queues and the round trip is
    ///      measured end to end in USDC rather than in queue entries.
    function setUp() public override {
        super.setUp();
        _seedBuffer(50_000_000e6);
    }

    /// @dev Run the attack once and report the attacker's USDC delta.
    ///      Negative-or-zero is a pass.
    function _roundTrip(
        uint256 tinBps,
        uint256 toutBps,
        uint256 stepBps,
        uint256 usdcIn
    )
        internal
        returns (int256 profit)
    {
        vm.prank(capManager);
        module.setFees(tinBps, toutBps);

        // Mint at M0.
        usdc.mint(user1, usdcIn);
        vm.startPrank(user1);
        usdc.approve(address(module), usdcIn);
        uint256 raw = module.mint(usdcIn);
        vm.stopPrank();

        // The step lands while the attacker holds raw.
        uint256 m0 = token.uiMultiplier();
        uint256 m1 = m0 + (m0 * stepBps) / Constants.BASIS_POINTS;
        if (m1 <= m0) m1 = m0 + 1;
        vm.prank(rateSetter);
        token.setOkuMultiplier(m1);
        _warpPastSyncWindow();

        // Redeem at M1.
        vm.startPrank(user1);
        token.approve(address(module), raw);
        uint256 usdcOut = module.redeem(raw);
        vm.stopPrank();

        // forge-lint: disable-next-line(unsafe-typecast)
        profit = int256(usdcOut) - int256(usdcIn);
    }

    // ============ The invariant, deterministically ============

    /// @notice At exact coverage (`tin + tout == stepBps`) the round trip is
    ///         break-even at best. This is the boundary case, and the one a
    ///         mis-derived formula gets wrong.
    function test_ExactCoverage_IsNeverProfitable() public {
        int256 profit = _roundTrip(50, 50, 100, 1_000_000e6);
        assertLe(profit, 0, "exact coverage must not be profitable");
    }

    /// @notice The mint-side half matters. With coverage carried ENTIRELY by
    ///         `tin`, a `tout`-only rule would have permitted this step at
    ///         `tout = 0` and the round trip would profit. The sum rule does not.
    function test_CoverageCarriedEntirelyByTin() public {
        int256 profit = _roundTrip(100, 0, 100, 1_000_000e6);
        assertLe(profit, 0, "tin-only coverage still closes the round trip");
    }

    /// @notice And symmetrically, coverage carried entirely by `tout`.
    function test_CoverageCarriedEntirelyByTout() public {
        int256 profit = _roundTrip(0, 100, 100, 1_000_000e6);
        assertLe(profit, 0);
    }

    /// @notice Over-coverage is strictly loss-making, as it must be.
    function test_OverCoverage_IsLossMaking() public {
        int256 profit = _roundTrip(100, 100, 50, 1_000_000e6);
        assertLt(profit, 0);
    }

    /// @notice The grid. Every legal `(tin, tout, stepBps)` triple with
    ///         `tin + tout >= stepBps` must close the round trip.
    function test_Grid_EveryLegalCombinationIsUnprofitable() public {
        uint256[4] memory fees = [uint256(0), 25, 50, 100];
        uint256[4] memory steps = [uint256(1), 25, 50, 100];

        for (uint256 i; i < fees.length; i++) {
            for (uint256 j; j < fees.length; j++) {
                for (uint256 k; k < steps.length; k++) {
                    if (fees[i] + fees[j] < steps[k]) continue; // illegal: refused on-chain
                    uint256 snap = vm.snapshotState();
                    int256 profit = _roundTrip(fees[i], fees[j], steps[k], 1_000_000e6);
                    assertLe(profit, 0, "a legal fee/step combination leaked value");
                    vm.revertToState(snap);
                }
            }
        }
    }

    function testFuzz_LegalCombinationsAreUnprofitable(
        uint256 tinSeed,
        uint256 toutSeed,
        uint256 stepSeed,
        uint256 amountSeed
    )
        public
    {
        uint256 stepBps = _bound(stepSeed, 1, Constants.MAX_STEP_BPS);
        uint256 tinBps = _bound(tinSeed, 0, Constants.MAX_FEE_BPS);
        // Constrain to the legal region — the illegal region is unreachable
        // on-chain and is asserted separately below.
        uint256 minTout = stepBps > tinBps ? stepBps - tinBps : 0;
        uint256 toutBps = _bound(toutSeed, minTout, Constants.MAX_FEE_BPS);
        uint256 usdcIn = _bound(amountSeed, 1e6, 5_000_000e6);

        int256 profit = _roundTrip(tinBps, toutBps, stepBps, usdcIn);
        assertLe(profit, 0);
    }

    // ============ The illegal region is unreachable ============

    /// @notice Under-covered steps are REFUSED, which is what makes the grid
    ///         above exhaustive rather than merely representative.
    function test_UnderCoveredStep_IsRefused() public {
        vm.prank(capManager);
        module.setFees(10, 10); // 20 bps of coverage

        vm.prank(rateSetter);
        vm.expectRevert(abi.encodeWithSelector(OkuM.StepNotCovered.selector, 50, 20));
        token.setOkuMultiplier((Constants.PRECISION * 10_050) / 10_000);
    }

    /// @notice FAIL-CLOSED: with fees at their shipped default of zero, no step
    ///         is possible at all. A deployment cannot accidentally mark before
    ///         its fee schedule exists.
    function test_ZeroFees_RefuseEveryStep() public view {
        assertEq(module.tin(), 0);
        assertEq(module.tout(), 0);
        // A one-wei step is 1 bps after ceiling, against 0 bps of coverage.
        // (Asserted via the revert path in `test_OneWeiStepStillNeedsCoverage`.)
    }

    function test_OneWeiStepStillNeedsCoverage() public {
        vm.prank(rateSetter);
        vm.expectRevert(abi.encodeWithSelector(OkuM.StepNotCovered.selector, 1, 0));
        token.setOkuMultiplier(Constants.PRECISION + 1);
    }

    /// @notice An unwired fee source reads as ZERO coverage, not as "no check".
    ///         A partially-configured deployment fails closed.
    function test_UnwiredFeeSource_RefusesEveryStep() public {
        vm.prank(capManager);
        token.setStepFeeSource(address(0));

        vm.prank(rateSetter);
        vm.expectRevert(abi.encodeWithSelector(OkuM.StepNotCovered.selector, 1, 0));
        token.setOkuMultiplier(Constants.PRECISION + 1);
    }

    // ============ The ratchet ============

    /// @notice The second mechanism. Raising the fee for a step and dropping it
    ///         afterwards would leave anyone still holding raw from before the
    ///         step able to exit cheaply — so the floor is a RATCHET.
    function test_Ratchet_FeesCannotDropBelowAStepAlreadyTaken() public {
        vm.prank(capManager);
        module.setFees(50, 50);
        vm.prank(rateSetter);
        token.setOkuMultiplier((Constants.PRECISION * 10_100) / 10_000); // 100 bps
        assertEq(token.stepHighWaterMark(), 100);

        vm.prank(capManager);
        vm.expectRevert(
            abi.encodeWithSelector(SubscriptionModule.FeesBelowStepFloor.selector, 99, 100)
        );
        module.setFees(50, 49);

        // Exactly at the floor is fine; any redistribution of the same total is.
        vm.prank(capManager);
        module.setFees(100, 0);
        assertEq(module.tin() + module.tout(), 100);
    }

    /// @notice The high-water mark tracks the LARGEST step, not the latest — a
    ///         small step after a large one must not relax the floor.
    function test_Ratchet_TracksTheLargestStepNotTheLatest() public {
        vm.prank(capManager);
        module.setFees(50, 50);

        _stepNoWarp((Constants.PRECISION * 10_100) / 10_000); // 100 bps
        _warpPastSyncWindow();
        assertEq(token.stepHighWaterMark(), 100);

        uint256 m = token.uiMultiplier();
        vm.prank(rateSetter);
        token.setOkuMultiplier(m + (m * 10) / Constants.BASIS_POINTS); // 10 bps
        assertEq(token.stepHighWaterMark(), 100, "a small step does not lower the mark");

        vm.prank(capManager);
        vm.expectPartialRevert(SubscriptionModule.FeesBelowStepFloor.selector);
        module.setFees(5, 5);
    }

    /// @notice THE NAMED ESCAPE HATCH. Cold can clear the floor, which reopens
    ///         historical step exposure — its honest precondition (that supply
    ///         outstanding at the time of the large step has substantially turned
    ///         over) is not verifiable on-chain. Hence the event, and hence the
    ///         monitoring requirement.
    function test_Ratchet_ColdEscapeHatchClearsTheFloor() public {
        vm.prank(capManager);
        module.setFees(50, 50);
        vm.prank(rateSetter);
        token.setOkuMultiplier((Constants.PRECISION * 10_100) / 10_000);
        assertEq(token.stepHighWaterMark(), 100);

        vm.prank(capManager);
        token.resetStepHighWaterMark();
        assertEq(token.stepHighWaterMark(), 0);

        vm.prank(capManager);
        module.setFees(0, 0);
        assertEq(module.tin(), 0);
    }

    // ============ Fee ceiling as a cadence constraint ============

    /// @notice `MAX_FEE_BPS` bounds the maximum coverable step and therefore the
    ///         MINIMUM MARK CADENCE. At a 5% annual target a daily step is ~1.34
    ///         bps, weekly ~9.6 bps, monthly ~40.7 bps — so a 1% ceiling covers
    ///         roughly a 2.4-month interval. A missed mark that forces an
    ///         oversized catch-up step will be refused, and the operational
    ///         answer is several smaller marks, not a bigger fee.
    function test_FeeCeilingBoundsTheCoverableStep() public {
        vm.prank(capManager);
        module.setFees(Constants.MAX_FEE_BPS, Constants.MAX_FEE_BPS);

        // Maximum coverage is 200 bps, but MAX_STEP_BPS caps the step at 100
        // regardless: the step ceiling binds before the fee ceiling does.
        vm.prank(rateSetter);
        vm.expectPartialRevert(ScaledUIAmountUpgradeable.StepAboveMaximum.selector);
        token.setOkuMultiplier((Constants.PRECISION * 10_101) / 10_000);

        vm.prank(rateSetter);
        token.setOkuMultiplier((Constants.PRECISION * 10_100) / 10_000);
        assertEq(token.stepHighWaterMark(), 100);
    }

    /// @notice A catch-up after a missed cadence has to be split. Asserted
    ///         because it is the operational consequence most likely to surprise
    ///         someone reading only the constants.
    function test_LargeCatchUpMustBeSplitAcrossSeveralMarks() public {
        vm.prank(capManager);
        module.setFees(50, 50);

        uint256 target = (Constants.PRECISION * 10_300) / 10_000; // ~300 bps behind
        vm.prank(rateSetter);
        vm.expectPartialRevert(ScaledUIAmountUpgradeable.StepAboveMaximum.selector);
        token.setOkuMultiplier(target);

        // Three legal marks get there.
        for (uint256 i; i < 3; i++) {
            uint256 m = token.uiMultiplier();
            uint256 next = m + (m * Constants.MAX_STEP_BPS) / Constants.BASIS_POINTS;
            if (next > target) next = target;
            vm.prank(rateSetter);
            token.setOkuMultiplier(next);
            _warpPastSyncWindow();
        }
        assertGe(token.uiMultiplier(), target);
    }
}
