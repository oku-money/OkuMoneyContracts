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
 *      across the step and needs no transaction while any window is open, which
 *      is exactly why a time lock is NOT the defence here — no window length
 *      deters someone who is simply waiting. (Contrast `SyncWindowTest`, where a
 *      time lock IS the right tool because the edge is transient.)
 *
 *      THE DEFENCE is the round-trip fee:
 *
 *          profit per unit = M1/M0 - 1 - (tin + tout)/10_000
 *
 *      and it is enforced as a relationship between two CONSTANTS rather than as
 *      runtime state:
 *
 *          OkuM.setOkuMultiplier:       stepBps  <= MAX_STEP_BPS
 *          SubscriptionModule.setFees:  tin      >= MAX_STEP_BPS
 *                                       tout     >= MAX_STEP_BPS
 *
 *      Composed, every step the protocol can take is covered on each leg
 *      independently, for all time. `initialize` seeds both legs at the floor,
 *      so there is no uncovered window between deployment and configuration.
 *
 *      WHAT THIS REPLACED, and why the tests below are shorter than they were.
 *      The previous design read `tin() + tout()` back from the module at
 *      multiplier-write time (`StepNotCovered`), ratcheted a
 *      `stepHighWaterMark`, floored later `setFees` calls against that mark
 *      (`FeesBelowStepFloor`), and offered a cold `resetStepHighWaterMark`
 *      escape hatch. Those tests had to explore a two-dimensional
 *      (fee, step-history) state space and carry an exemption for the escape
 *      hatch. With a static floor there is no history to explore: the illegal
 *      region is defined by constants and is unreachable by construction.
 *
 *      PER-LEG RATHER THAN COMBINED. A combined `tin + tout >= step` rule is
 *      sufficient on one chain and insufficient across two, because a
 *      cross-chain round trip pays `tin` on the chain it mints on and `tout` on
 *      the chain it redeems on. `test_CrossChainLegPairing_IsNeverProfitable`
 *      pins the case that motivates the stronger rule.
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

    /// @notice The worst admissible case: both legs AT the floor, and a step of
    ///         exactly `MAX_STEP_BPS`. This is the tightest configuration the
    ///         contracts permit, and the one a mis-derived floor gets wrong.
    ///
    /// @dev Note the round trip now pays `2 * MAX_STEP_BPS` against a gain of
    ///      `MAX_STEP_BPS`, so there is a full step of margin. That margin is
    ///      the price of the per-leg rule, and it is what buys the cross-chain
    ///      guarantee below.
    function test_FloorFees_MaximalStep_IsNeverProfitable() public {
        int256 profit = _roundTrip(
            Constants.MAX_STEP_BPS, Constants.MAX_STEP_BPS, Constants.MAX_STEP_BPS, 1_000_000e6
        );
        assertLt(profit, 0, "floor fees against a maximal step must be loss-making");
    }

    /// @notice A one-wei step at floor fees. The smallest possible gain against
    ///         the smallest possible fee — guards against a rounding direction
    ///         that would make dust extraction profitable at scale.
    function test_OneWeiStep_AtFloorFees_IsNeverProfitable() public {
        vm.prank(capManager);
        module.setFees(Constants.MAX_STEP_BPS, Constants.MAX_STEP_BPS);

        uint256 usdcIn = 1_000_000e6;
        usdc.mint(user1, usdcIn);
        vm.startPrank(user1);
        usdc.approve(address(module), usdcIn);
        uint256 raw = module.mint(usdcIn);
        vm.stopPrank();

        uint256 target = token.uiMultiplier() + 1;
        vm.prank(rateSetter);
        token.setOkuMultiplier(target);
        _warpPastSyncWindow();

        vm.startPrank(user1);
        token.approve(address(module), raw);
        uint256 usdcOut = module.redeem(raw);
        vm.stopPrank();

        assertLt(usdcOut, usdcIn, "a one-wei step must not be extractable");
    }

    /// @notice Over-coverage is strictly loss-making, as it must be.
    function test_OverCoverage_IsLossMaking() public {
        int256 profit = _roundTrip(Constants.MAX_FEE_BPS, Constants.MAX_FEE_BPS, 1, 1_000_000e6);
        assertLt(profit, 0);
    }

    /// @notice The grid. Every `(tin, tout, stepBps)` triple the contracts admit
    ///         must close the round trip.
    ///
    /// @dev Exhaustive over the step dimension (1..MAX_STEP_BPS) rather than
    ///      sampled, which is affordable precisely because `MAX_STEP_BPS` is now
    ///      small. The fee dimension samples the floor and the ceiling: the
    ///      payout is monotonically decreasing in both fees, so the floor pair
    ///      is the worst case and the rest is confirmation.
    function test_Grid_EveryAdmissibleCombinationIsUnprofitable() public {
        uint256[3] memory fees =
            [Constants.MAX_STEP_BPS, Constants.MAX_STEP_BPS + 1, Constants.MAX_FEE_BPS];

        for (uint256 i; i < fees.length; i++) {
            for (uint256 j; j < fees.length; j++) {
                for (uint256 step = 1; step <= Constants.MAX_STEP_BPS; step++) {
                    uint256 snap = vm.snapshotState();
                    int256 profit = _roundTrip(fees[i], fees[j], step, 1_000_000e6);
                    assertLe(profit, 0, "an admissible fee/step combination leaked value");
                    vm.revertToState(snap);
                }
            }
        }
    }

    function testFuzz_AdmissibleCombinationsAreUnprofitable(
        uint256 tinSeed,
        uint256 toutSeed,
        uint256 stepSeed,
        uint256 amountSeed
    )
        public
    {
        // Exactly the region the contracts admit. There is no illegal region to
        // exclude by hand any more — the bounds ARE the admissibility rule.
        uint256 stepBps = _bound(stepSeed, 1, Constants.MAX_STEP_BPS);
        uint256 tinBps = _bound(tinSeed, Constants.MAX_STEP_BPS, Constants.MAX_FEE_BPS);
        uint256 toutBps = _bound(toutSeed, Constants.MAX_STEP_BPS, Constants.MAX_FEE_BPS);
        uint256 usdcIn = _bound(amountSeed, 1e6, 5_000_000e6);

        int256 profit = _roundTrip(tinBps, toutBps, stepBps, usdcIn);
        assertLe(profit, 0);
    }

    /// @notice THE CASE THE PER-LEG RULE EXISTS FOR. A cross-chain round trip
    ///         mints on the lagging chain and redeems on the leading one, paying
    ///         `tin` from chain A and `tout` from chain B.
    ///
    /// @dev Under a COMBINED floor, fees of `(0, 2N)` on chain A and `(2N, 0)`
    ///      on chain B each satisfy `tin + tout >= N` while the cross pairing
    ///      pays nothing at all. Under the per-leg floor the cheapest possible
    ///      pairing still pays `2 * MAX_STEP_BPS`.
    ///
    ///      Modelled on one chain by charging the minimum on each leg
    ///      independently, which is exactly what the cross-chain pairing costs.
    function test_CrossChainLegPairing_IsNeverProfitable() public {
        // The floor is the cheapest `tin` any chain can offer, and likewise the
        // cheapest `tout`. A full maximal step of divergence between chains.
        int256 profit = _roundTrip(
            Constants.MAX_STEP_BPS, Constants.MAX_STEP_BPS, Constants.MAX_STEP_BPS, 1_000_000e6
        );
        assertLt(profit, 0, "cheapest cross-chain leg pairing must be loss-making");
    }

    // ============ The illegal region is unreachable ============

    /// @notice A step above `MAX_STEP_BPS` is refused. This is what makes the
    ///         grid above exhaustive rather than merely representative.
    function test_OversizedStep_IsRefused() public {
        uint256 oversized = Constants.MAX_STEP_BPS + 1;
        uint256 target =
            (Constants.PRECISION * (Constants.BASIS_POINTS + oversized)) / Constants.BASIS_POINTS;

        vm.prank(rateSetter);
        vm.expectRevert(
            abi.encodeWithSelector(
                ScaledUIAmountUpgradeable.StepAboveMaximum.selector,
                oversized,
                Constants.MAX_STEP_BPS
            )
        );
        token.setOkuMultiplier(target);
    }

    /// @notice Neither leg can be set below the floor.
    function test_FeeBelowFloor_IsRefused() public {
        vm.startPrank(capManager);

        vm.expectRevert(
            abi.encodeWithSelector(
                SubscriptionModule.FeeBelowStepFloor.selector,
                Constants.MAX_STEP_BPS - 1,
                Constants.MAX_STEP_BPS
            )
        );
        module.setFees(Constants.MAX_STEP_BPS - 1, Constants.MAX_STEP_BPS);

        vm.expectRevert(
            abi.encodeWithSelector(
                SubscriptionModule.FeeBelowStepFloor.selector,
                Constants.MAX_STEP_BPS - 1,
                Constants.MAX_STEP_BPS
            )
        );
        module.setFees(Constants.MAX_STEP_BPS, Constants.MAX_STEP_BPS - 1);

        vm.stopPrank();
    }

    /// @notice ZERO FEES ARE UNREACHABLE. Not merely discouraged — there is no
    ///         call sequence that produces them.
    /// @dev The previous design shipped `(0, 0)` and relied on the token
    ///      refusing to step until fees were configured. That was safe but
    ///      non-accruing, and made "someone remembers to call `setFees`" a
    ///      launch dependency. Now the floor is seeded at `initialize` and the
    ///      only writer refuses to go below it.
    function test_ZeroFeesAreUnreachable() public {
        assertEq(module.tin(), Constants.MAX_STEP_BPS, "tin ships at the floor");
        assertEq(module.tout(), Constants.MAX_STEP_BPS, "tout ships at the floor");

        vm.prank(capManager);
        vm.expectPartialRevert(SubscriptionModule.FeeBelowStepFloor.selector);
        module.setFees(0, 0);
    }

    /// @notice Coverage holds from block one — no wiring call, no ordering.
    /// @dev Regression guard for the fail-closed hole this design had to be
    ///      corrected for mid-implementation: with the token no longer reading
    ///      the fee schedule, shipping zero fees would have left steps
    ///      admissible and uncovered until someone called `setFees`.
    function test_StepIsCoveredImmediatelyAfterDeploy() public {
        // No fee configuration whatsoever between `setUp` and this step.
        uint256 m0 = token.uiMultiplier();
        uint256 m1 = m0 + (m0 * Constants.MAX_STEP_BPS) / Constants.BASIS_POINTS;

        vm.prank(rateSetter);
        token.setOkuMultiplier(m1);
        _warpPastSyncWindow();

        assertGe(module.tin(), Constants.MAX_STEP_BPS);
        assertGe(module.tout(), Constants.MAX_STEP_BPS);
    }

    // ============ The constants must remain compatible ============

    /// @notice `MAX_STEP_BPS <= MAX_FEE_BPS`, or `setFees` admits nothing and
    ///         the multiplier is permanently bricked.
    /// @dev The one coupling left between these constants, and the only one an
    ///      operator re-tuning them can get wrong. SVM mirror: a `const _:`
    ///      assert in `oku-shared/src/constants.rs`.
    function test_ConstantsCoupling_FeeFloorFitsUnderCeiling() public pure {
        assertLe(
            Constants.MAX_STEP_BPS,
            Constants.MAX_FEE_BPS,
            "step floor above fee ceiling would brick setFees"
        );
    }
}
