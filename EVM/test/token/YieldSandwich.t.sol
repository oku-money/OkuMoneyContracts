// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title YieldSandwichTest
 * @notice Regression suite for the yield-sandwich vulnerability that motivated
 *         replacing OkuMoney's discrete multiplier with continuous epoch accrual.
 *
 * @dev ## The vulnerability (historical)
 *
 *      `okuMMultiplier` is the settlement price for instant, two-way convertibility
 *      at the PSM. It used to be written as a discrete step by `distributeYield` /
 *      `setOkuMMultiplier`. A step in a settlement price is riskless arbitrage:
 *
 *          block N-1:  attacker mints OkuM at M = 1.0000        (cheap)
 *          block N:    operator steps M to 1.0500
 *          block N+1:  attacker redeems OkuM at M = 1.0500      (dear)
 *
 *      The attacker captured the entire increment with no price risk and no holding
 *      period, funded out of the PSM buffer and diluting every honest holder.
 *
 *      The `YieldSandwichGuard` fence did NOT stop this. It compared `block.number`
 *      against `lastYieldDistributionBlock`, which is only written INSIDE
 *      `distributeYield` — so a mint ordered BEFORE the step in the same block passed
 *      the check, and the redeem simply waited for the next block. The fence caught
 *      only the fully-atomic same-block round trip; the profitable version spans two
 *      blocks and needs nothing more than mempool visibility of the update tx.
 *
 *      ## The fix
 *
 *      Yield is still discovered off-chain in chunks, but it is now DELIVERED
 *      continuously over an epoch. `startYieldEpoch` begins at the CURRENT multiplier,
 *      so there is no discontinuity anywhere on the timeline. A holder earns strictly
 *      in proportion to time held, which is what yield is supposed to mean.
 *
 *      These tests assert that property directly: they run the exact attack sequence
 *      and show it is no longer profitable.
 */
contract YieldSandwichTest is BaseTest {
    uint256 internal constant SUPPLY = 1_000_000e18; // 1M OkuM held honestly
    uint256 internal constant ATTACKER_USDC = 1_000_000e6; // attacker matches TVL
    uint256 internal constant YIELD = 4110e18; // ~5% APR over 30 days
    uint256 internal constant EPOCH = 30 days;

    address internal alice; // honest holder
    address internal bob; // attacker

    function setUp() public override {
        super.setUp();
        alice = makeAddr("alice_honest");
        bob = makeAddr("bob_attacker");

        // Alice holds OkuM across the whole period.
        _mintOkuMoney(alice, SUPPLY);

        // Deep buffer so redemptions are never buffer-limited — we are measuring
        // arbitrage, not liquidity.
        usdc.mint(address(litePsm), 10_000_000e6);

        // Bob is funded and pre-approved.
        usdc.mint(bob, ATTACKER_USDC);
        vm.prank(bob);
        usdc.approve(address(litePsm), type(uint256).max);
    }

    /// @notice THE regression test: the cross-block mint/step/redeem round trip that
    ///         drained the buffer under the old discrete design is no longer
    ///         profitable.
    /// @dev Bob does everything right: he sees the epoch transaction, mints
    ///      immediately before it, and redeems immediately after. He must not profit.
    function test_CrossBlockSandwich_IsNotProfitable() public {
        uint256 usdcBefore = usdc.balanceOf(bob);

        // --- Block N-1: Bob front-runs the yield transaction ---
        vm.prank(bob);
        litePsm.mintOkuM(ATTACKER_USDC);
        uint256 bobOkuM = okuMoney.balanceOf(bob);
        assertGt(bobOkuM, 0, "bob should hold OkuM");

        // --- Block N: the operator publishes yield ---
        vm.roll(block.number + 1);
        vm.prank(rebaser);
        okuMoney.startYieldEpoch(YIELD, EPOCH);

        // --- Block N+1: Bob back-runs, redeeming immediately ---
        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12); // one block of elapsed time
        vm.prank(bob);
        IERC20(address(okuMoney)).approve(address(litePsm), bobOkuM);
        vm.prank(bob);
        litePsm.redeemOkuM(bobOkuM);

        uint256 usdcAfter = usdc.balanceOf(bob);
        uint256 gain = usdcAfter > usdcBefore ? usdcAfter - usdcBefore : 0;

        // Bob held ~12 seconds of a 30-day epoch with ~50% of supply, so the yield he
        // is legitimately owed is:
        //
        //     4110 USDC * 0.5 * (12 / 2_592_000) = 0.009514 USDC
        //
        // He receives 0.009513 USDC. He is not exploiting anything — he is being paid
        // correctly for twelve seconds of capital at risk. That is the whole point:
        // the payout is a function of time held, so there is no longer an instant to
        // straddle. Under the old discrete step the same sequence paid him 2055 USDC.
        uint256 expectedProRata = (YIELD / 2 * 12 / EPOCH) / 1e12; // 18-dec dollars -> 6-dec USDC
        assertApproxEqAbs(
            gain, expectedProRata, 1, "gain must equal the honest pro-rata time share"
        );

        // And in absolute terms it is dust: well under one cent.
        assertLt(gain, 0.01e6, "residual gain must be immaterial");
    }

    /// @notice Quantifies the fix: the same attack under a simulated discrete step
    ///         would have paid out ~2055 USDC. Continuous accrual pays ~0.
    /// @dev Runs Bob's round trip across the epoch publication and compares his gain
    ///      against the step-shaped payoff he would have captured. Documents the
    ///      magnitude of what was closed, not just the direction.
    function test_SandwichProfit_IsNegligibleVersusStepPayoff() public {
        // What Bob WOULD have taken under a discrete step: with supply doubled by his
        // mint, `distributeYield` split the pot evenly, so he took half.
        uint256 stepPayoffUsdc = (YIELD / 2) / 1e12; // 18-dec dollars -> 6-dec USDC

        uint256 usdcBefore = usdc.balanceOf(bob);

        vm.prank(bob);
        litePsm.mintOkuM(ATTACKER_USDC);
        uint256 bobOkuM = okuMoney.balanceOf(bob);

        vm.roll(block.number + 1);
        vm.prank(rebaser);
        okuMoney.startYieldEpoch(YIELD, EPOCH);

        vm.roll(block.number + 1);
        vm.warp(block.timestamp + 12);
        vm.prank(bob);
        IERC20(address(okuMoney)).approve(address(litePsm), bobOkuM);
        vm.prank(bob);
        litePsm.redeemOkuM(bobOkuM);

        uint256 gain = usdc.balanceOf(bob) > usdcBefore ? usdc.balanceOf(bob) - usdcBefore : 0;

        assertGt(stepPayoffUsdc, 2000e6 / 1e6, "sanity: step payoff was material");
        assertLt(gain, stepPayoffUsdc / 1000, "continuous gain must be <0.1% of step payoff");
    }

    /// @notice Yield accrues in proportion to TIME HELD — the property a step destroys.
    /// @dev Alice holds the full epoch, Bob holds 1%. Bob's share of the yield must be
    ///      ~1% of what his capital would have earned over the full epoch.
    function test_YieldIsProportionalToTimeHeld() public {
        vm.prank(rebaser);
        okuMoney.startYieldEpoch(YIELD, EPOCH);

        uint256 mStart = okuMoney.okuMMultiplier();

        // Bob holds for 1% of the epoch.
        vm.warp(block.timestamp + EPOCH / 100);
        uint256 mAfterBob = okuMoney.okuMMultiplier();

        // Alice holds the remaining 99%.
        vm.warp(block.timestamp + (EPOCH * 99) / 100);
        uint256 mEnd = okuMoney.okuMMultiplier();

        uint256 bobGrowth = mAfterBob - mStart;
        uint256 totalGrowth = mEnd - mStart;

        // Bob captured ~1% of the epoch's appreciation, not ~100% as a step would give.
        assertApproxEqRel(
            bobGrowth * 100, totalGrowth, 1e15, "1% of holding time earns ~1% of yield"
        );
    }

    /// @notice An epoch publication is invisible to price at the instant it lands.
    /// @dev The root cause of the vulnerability was that the multiplier jumped. Assert
    ///      directly that publishing yield moves nothing at the moment it is published,
    ///      across every conversion surface the multiplier feeds.
    function test_EpochPublication_MovesNoPrice() public {
        uint256 mBefore = okuMoney.okuMMultiplier();
        uint256 quoteBefore = okuMoney.toUIAmount(1e18);

        vm.prank(rebaser);
        okuMoney.startYieldEpoch(YIELD, EPOCH);

        assertEq(okuMoney.okuMMultiplier(), mBefore, "multiplier must not step");
        assertEq(okuMoney.toUIAmount(1e18), quoteBefore, "UI conversion must not step");
    }

    /// @notice Holding across an epoch boundary confers no advantage.
    /// @dev The successor epoch starts exactly where its predecessor ended, so the
    ///      handover is not a step either — a boundary is not an arbitrage window.
    function test_EpochBoundary_IsNotAnArbitrageWindow() public {
        vm.prank(rebaser);
        okuMoney.startYieldEpoch(YIELD, EPOCH);
        vm.prank(rebaser);
        okuMoney.scheduleYieldEpoch(YIELD, EPOCH);

        // One second either side of the handover.
        vm.warp(block.timestamp + EPOCH - 1);
        uint256 justBefore = okuMoney.okuMMultiplier();
        vm.warp(block.timestamp + 1);
        uint256 atBoundary = okuMoney.okuMMultiplier();
        vm.warp(block.timestamp + 1);
        uint256 justAfter = okuMoney.okuMMultiplier();

        uint256 stepIn = atBoundary - justBefore;
        uint256 stepOut = justAfter - atBoundary;

        // Both single-second increments are the same order of magnitude: no jump.
        assertApproxEqRel(stepIn, stepOut, 1e17, "boundary must not produce a jump");
    }

    /// @notice Honest holders keep the yield an attacker used to take.
    /// @dev Under the step design Bob's mint diluted the pot and halved Alice's yield.
    ///      Here Bob's brief presence is immaterial to what Alice earns.
    function test_HonestHolderRetainsYield_DespiteAttackerActivity() public {
        // Baseline: Alice alone across the epoch.
        uint256 mStart = okuMoney.okuMMultiplier();
        vm.prank(rebaser);
        okuMoney.startYieldEpoch(YIELD, EPOCH);
        vm.warp(block.timestamp + EPOCH);
        uint256 aliceSolo = okuMoney.okuMMultiplier() - mStart;

        // Reset and repeat with Bob churning through the epoch.
        setUp();
        mStart = okuMoney.okuMMultiplier();
        vm.prank(rebaser);
        okuMoney.startYieldEpoch(YIELD, EPOCH);

        vm.warp(block.timestamp + 12);
        vm.prank(bob);
        litePsm.mintOkuM(ATTACKER_USDC);
        uint256 bobOkuM = okuMoney.balanceOf(bob);
        vm.warp(block.timestamp + 12);
        vm.prank(bob);
        IERC20(address(okuMoney)).approve(address(litePsm), bobOkuM);
        vm.prank(bob);
        litePsm.redeemOkuM(bobOkuM);

        vm.warp(block.timestamp + EPOCH);
        uint256 aliceWithBob = okuMoney.okuMMultiplier() - mStart;

        // Bob's churn does not change the multiplier trajectory at all: the epoch's
        // rate was fixed at publication and is not re-divided by a moving supply.
        assertEq(aliceWithBob, aliceSolo, "attacker activity must not dilute honest yield");
    }
}
