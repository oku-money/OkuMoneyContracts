// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "../Base.t.sol";
import {Errors} from "../../src/lib/Errors.sol";
import {LitePSM} from "../../src/psm/LitePSM.sol";
import {Constants} from "../../src/lib/Constants.sol";
import {MathLib} from "../../src/lib/MathLib.sol";

/**
 * @title LitePSMRebasingRedeemTest
 * @notice Regression suite for `LitePSM.redeemUsdOku` when
 *         `okuDollar.usdMultiplier() > 1e18` (i.e. yield is live and accruing).
 *
 * @dev Historical bug (Sepolia, May 2026): `redeemUsdOku` pulled UsdOku by nominal
 *      amount and then called `unwrap(amount)` with the same nominal value. Because
 *      `OkuDollar.transferFrom` floors the share conversion and `OkuDollar.unwrap`
 *      ceils the share burn, the PSM ended up holding 1 share less than `unwrap`
 *      demanded → `InsufficientBalance()`. The fix measures the actual received
 *      amount via a balance delta and passes that to `unwrap`.
 *
 *      Coverage axes (cross-product):
 *        * usdMultiplier states: 1e18 baseline, slightly elevated, mid-range,
 *          near-MAX_MULTIPLIER, and live-compounding (rate > PRECISION + warp).
 *        * okuMMultiplier states: 1e18, $1.05, $1.50, $2.00.
 *        * redeem amounts: dust (1 wei), small (1e15), medium (1e18), large (1000e18),
 *          full-balance.
 *        * time horizons: 1 second, 1 minute, 1 hour, 1 day, 30 days, 1 year,
 *          5 years, 10 years, 25 years, ~50 years (capped to keep multiplier
 *          within reachable bounds).
 *        * entry points: `redeemUsdOku`.
 *
 *      The reference rate used in long-horizon tests is the live Sepolia
 *      production rate (`1_000_000_001_546_176_000` ≈ 5% APY). Selected because
 *      this is the exact rate that exposed the latent bug in the field.
 */
contract LitePSMRebasingRedeemTest is BaseTest {
    // ============ Events ============

    event UsdOkuRedeemed(
        address indexed user, uint256 usdIn, uint256 usdcOut, uint256 okuMMultiplier
    );

    // ============ Rate Constants ============

    /// @notice ~5% APY (live Sepolia rate). Per-second rate that compounds to ~1.05x in 365.25d.
    uint256 internal constant RATE_5_PCT_APY = 1_000_000_001_546_176_000;

    /// @notice ~2% APY per-second rate.
    uint256 internal constant RATE_2_PCT_APY = 1_000_000_000_634_000_000;

    /// @notice ~4.5% APY per-second rate (matches existing test_APYAccuracy).
    uint256 internal constant RATE_4_5_PCT_APY = 1_000_000_001_395_766_281;

    /// @notice ~10% APY per-second rate (stress).
    uint256 internal constant RATE_10_PCT_APY = 1_000_000_003_022_265_980;

    /// @notice Tracks the dollar value of UsdOku stranded in the PSM after a redeem.
    ///         Should always be ~0 (within 1 wei) for the bug to be considered fixed.
    uint256 internal constant MAX_STRANDED_DUST = 1; // wei of UsdOku

    // ============ Setup ============

    function setUp() public override {
        super.setUp();
        // Seed users and PSM buffer. Use a generous buffer so redemptions never
        // hit InsufficientBuffer.
        _mintUsdc(user1, 10_000_000e6);
        _mintUsdc(user2, 10_000_000e6);
        _mintUsdc(address(litePsm), 10_000_000e6);
    }

    // ============ Helpers ============

    /// @notice Set the active yield rate for one maximal rate window.
    /// @dev SINGLE MULTIPLIER: `okuDollar.usdMultiplier()` is exactly
    ///      `okuMoney.okuMMultiplier()`, so the rate is set on OkuMoney via OKUM_REBASER.
    ///
    ///      This used to open a single 100-year window. A window may now not
    ///      exceed `Constants.MAX_RATE_WINDOW` (90 days), so horizons beyond
    ///      that are walked via `_accrueAtCurrentRate`, which re-anchors at the
    ///      same rate every 90 days — matching how the epoch model actually
    ///      drives these contracts.
    function _setUsdRate(uint256 rate) internal {
        vm.prank(rebaser);
        okuMoney.setOkuMYieldRate(rate, block.timestamp + MAX_RATE_WINDOW);
    }

    /// @notice Mint UsdOku to a user from a USDC deposit through the PSM. Returns the
    ///         UsdOku balance minted.
    function _mintUsdOkuViaPsm(address user, uint256 usdcAmount) internal returns (uint256) {
        uint256 balBefore = okuDollar.balanceOf(user);
        _approveUsdc(user, address(litePsm), usdcAmount);
        vm.prank(user);
        litePsm.mintUsdOku(usdcAmount);
        return okuDollar.balanceOf(user) - balBefore;
    }

    /// @notice Approve and redeem; returns the USDC received and the post-redeem stranded UsdOku in PSM.
    function _redeemAndMeasure(
        address user,
        uint256 usdAmount
    )
        internal
        returns (uint256 usdcReceived, uint256 strandedUsdOku)
    {
        uint256 usdcBefore = usdc.balanceOf(user);
        uint256 strandedBefore = okuDollar.balanceOf(address(litePsm));
        _approveOkuDollar(user, address(litePsm), usdAmount);
        vm.prank(user);
        litePsm.redeemUsdOku(usdAmount);
        usdcReceived = usdc.balanceOf(user) - usdcBefore;
        strandedUsdOku = okuDollar.balanceOf(address(litePsm)) - strandedBefore;

        // THE invariant every caller cares about, asserted once here rather than
        // as `assertGt(usdcOut, 0)` at seven call sites -- which would have
        // passed on a single wei at any multiplier.
        //
        // usdOku is dollar-denominated, so redeeming `usdAmount` pays
        // `usdAmount / 1e12` USDC REGARDLESS of the multiplier. That invariance
        // is the whole point of the vault, and it is what these live-compounding
        // scenarios exist to confirm still holds after years of accrual.
        //
        // Tolerance is 2 collateral units: `OkuDollar.transferFrom` floors the
        // share conversion while `unwrap` ceils the burn, so the pair can differ
        // by a wei before the 18->6 truncation (see `LitePSM.redeemUsdOku`).
        assertApproxEqAbs(
            usdcReceived,
            usdAmount / 1e12,
            2,
            "redeeming usdOku must pay its dollar value regardless of the multiplier"
        );
    }

    // ============================================================
    // SECTION 1 — Baseline: usdMultiplier == 1e18 (the pre-rate world)
    // ============================================================

    /// @notice Sanity: at base multiplier, redeem still works (regression on the regression).
    function test_RedeemUsdOku_AtBaseMultiplier_Succeeds() public {
        _mintUsdOkuViaPsm(user1, 1000e6);
        uint256 usdBal = okuDollar.balanceOf(user1);
        assertEq(okuDollar.usdMultiplier(), PRECISION, "Baseline multiplier should be 1e18");

        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, usdBal);

        assertGt(usdcOut, 0, "Must receive USDC");
        assertLe(stranded, MAX_STRANDED_DUST, "No UsdOku may be stranded in PSM at base");
    }

    // ============================================================
    // SECTION 2 — Static elevated usdMultiplier (the exact bug condition)
    // ============================================================

    /// @notice This is the exact failing case from Sepolia: usdMultiplier slightly
    ///         above 1e18, redeem 1 UsdOku, expect success post-fix.
    ///         Without the fix this reverts with `InsufficientBalance()`.
    function test_RedeemUsdOku_AtSlightlyElevatedMultiplier_OneUsdOku() public {
        // Mint enough UsdOku BEFORE elevating to avoid mint-side rounding edge cases.
        _mintUsdOkuViaPsm(user1, 10_000e6); // 10k USDC -> ~10k UsdOku
        uint256 mintedBal = okuDollar.balanceOf(user1);
        assertGe(mintedBal, 10e18, "Need at least 10 UsdOku to redeem 1");

        // Elevate the multiplier just barely above PRECISION.
        // Sepolia at the time of the bug: 1_000_119_588_401_861_293 ≈ 1.0001196x.
        _elevateUsdMultiplier(PRECISION + 1e14); // ~1.0001x — same order of magnitude as Sepolia

        assertGt(okuDollar.usdMultiplier(), PRECISION, "Multiplier must be > 1e18");

        // Redeem exactly 1 UsdOku — the exact amount that failed in Fordefi.
        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, 1e18);

        assertGt(usdcOut, 0, "Must receive USDC for 1 UsdOku redemption");
        assertLe(stranded, MAX_STRANDED_DUST, "PSM must not strand UsdOku shares");
    }

    /// @notice 10% elevated multiplier — the test_MintUsdOku_PriceAware sibling for redeem.
    function test_RedeemUsdOku_AtTenPercentElevatedMultiplier() public {
        _mintUsdOkuViaPsm(user1, 10_000e6);
        _elevateUsdMultiplier(11e17); // ~$1.10 per share

        uint256 redeemAmount = 100e18; // 100 UsdOku
        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, redeemAmount);

        assertGt(usdcOut, 0, "Must receive USDC");
        assertLe(stranded, MAX_STRANDED_DUST, "PSM must not strand UsdOku shares");
    }

    /// @notice 50% elevated multiplier — pushing rounding error window wider.
    function test_RedeemUsdOku_AtFiftyPercentElevatedMultiplier() public {
        _mintUsdOkuViaPsm(user1, 100_000e6);
        _elevateUsdMultiplier(15e17); // ~$1.50 per share

        uint256 redeemAmount = 1000e18;
        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, redeemAmount);

        assertGt(usdcOut, 0, "Must receive USDC");
        assertLe(stranded, MAX_STRANDED_DUST, "PSM must not strand UsdOku shares");
    }

    /// @notice 2x multiplier — the upper end of the historical fuzz bound for usdMult.
    function test_RedeemUsdOku_AtDoubleMultiplier() public {
        _mintUsdOkuViaPsm(user1, 100_000e6);
        _elevateUsdMultiplier(2 * PRECISION);

        uint256 redeemAmount = 500e18;
        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, redeemAmount);

        assertGt(usdcOut, 0, "Must receive USDC");
        assertLe(stranded, MAX_STRANDED_DUST, "PSM must not strand UsdOku shares");
    }

    // ============================================================
    // SECTION 3 — Dust amounts (worst-case for rounding)
    // ============================================================

    /// @notice The smallest non-zero redeem amount the USDC-decimal path can payout.
    ///         At elevated multipliers, dust amounts maximize relative rounding error.
    function test_RedeemUsdOku_DustAmounts_AtElevatedMultiplier() public {
        // Need real UsdOku balance large enough to cover all dust redemptions.
        _mintUsdOkuViaPsm(user1, 100_000e6);
        _elevateUsdMultiplier(PRECISION + 5e16); // ~5% elevated

        // Smallest amount that produces >= 1 USDC unit out (otherwise AmountTooSmall
        // is the expected revert from the OkuM redeem leg, not the bug under test).
        // At usdMult ≈ 1.05 and okuMMult = 1.0, 1e12 UsdOku → ~0.0000009 USDC → floor 0 -> reverts.
        // We start at amounts that produce strictly positive USDC out.
        uint256[5] memory amounts = [uint256(1e15), 1e16, 1e17, 1e18, 10e18];

        for (uint256 i = 0; i < amounts.length; i++) {
            uint256 amt = amounts[i];
            (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, amt);
            assertGt(usdcOut, 0, "Each dust redeem must produce USDC");
            assertLe(stranded, MAX_STRANDED_DUST, "No stranded shares per dust redeem");
        }
    }

    /// @notice Many small back-to-back redeems must not accumulate stranded UsdOku in the PSM.
    function test_RedeemUsdOku_RepeatedSmallRedeems_NoAccumulatedDust() public {
        _mintUsdOkuViaPsm(user1, 1_000_000e6);
        _elevateUsdMultiplier(PRECISION + 1e16); // 1% elevated

        uint256 strandedStart = okuDollar.balanceOf(address(litePsm));
        for (uint256 i = 0; i < 20; i++) {
            _approveOkuDollar(user1, address(litePsm), 1e18);
            vm.prank(user1);
            litePsm.redeemUsdOku(1e18);
        }
        uint256 strandedEnd = okuDollar.balanceOf(address(litePsm));
        uint256 deltaShares = okuDollar.usdSharesOf(address(litePsm));

        // Dollar-value stranded should be at most 20 wei (one per redeem worst case).
        assertLe(strandedEnd - strandedStart, 20, "Cumulative stranded dust must stay bounded");
        assertLe(deltaShares, 20, "Cumulative stranded shares must stay bounded");
    }

    // ============================================================
    // SECTION 4 — Live compounding multiplier (rate > PRECISION + active accrual)
    // ============================================================
    //
    // The `_elevateUsdMultiplier` helper resets the rate to PRECISION after
    // reaching the target — so it produces a *frozen* elevated multiplier. The
    // tests in this section instead set the rate ONCE and let time pass so the
    // multiplier is actively compounding at the moment of redeem. This is the
    // exact state of the live Sepolia deployment.

    /// @notice Short horizon — 1 second of accrual at 5% APY.
    function test_RedeemUsdOku_LiveCompounding_1Second() public {
        _mintUsdOkuViaPsm(user1, 10_000e6);
        _setUsdRate(RATE_5_PCT_APY);

        _accrueAtCurrentRate(1);
        assertGt(okuDollar.usdMultiplier(), PRECISION, "Multiplier must accrue in 1s");

        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, 1e18);
        assertLe(stranded, MAX_STRANDED_DUST);
    }

    /// @notice 1 minute, 1 hour, 1 day at 5% APY — short horizons that match
    ///         typical CI/test-flow simulation windows.
    function test_RedeemUsdOku_LiveCompounding_ShortHorizons() public {
        uint256[3] memory horizons = [uint256(1 minutes), 1 hours, 1 days];

        for (uint256 i = 0; i < horizons.length; i++) {
            // Fresh deployment for each horizon to keep state clean.
            setUp();
            _mintUsdOkuViaPsm(user1, 10_000e6);
            _setUsdRate(RATE_5_PCT_APY);
            _accrueAtCurrentRate(horizons[i]);

            (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, 1e18);
            assertGt(usdcOut, 0, "Short-horizon redeem must produce USDC");
            assertLe(stranded, MAX_STRANDED_DUST, "Short-horizon redeem must not strand shares");
        }
    }

    /// @notice 1 year of compounding at 5% APY — Sepolia's first-anniversary scenario.
    function test_RedeemUsdOku_LiveCompounding_OneYear() public {
        _mintUsdOkuViaPsm(user1, 100_000e6);
        _setUsdRate(RATE_5_PCT_APY);

        _accrueAtCurrentRate(365 days);

        uint256 multAfter = okuDollar.usdMultiplier();
        // Sanity: after 1 year at 5% APY the multiplier should be ~1.05e18.
        assertApproxEqRel(multAfter, 105e16, 1e15, "1yr@5% should be ~1.05x");

        uint256 redeemAmount = 1000e18;
        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, redeemAmount);
        assertLe(stranded, MAX_STRANDED_DUST);
    }

    /// @notice 5-year horizon at 5% APY (~1.276x multiplier).
    function test_RedeemUsdOku_LiveCompounding_FiveYears() public {
        _mintUsdOkuViaPsm(user1, 100_000e6);
        _setUsdRate(RATE_5_PCT_APY);

        _accrueAtCurrentRate(5 * 365 days);

        // 1.05^5 ≈ 1.27628
        assertApproxEqRel(okuDollar.usdMultiplier(), 1_276_281_562_500_000_000, 1e15);

        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, 500e18);
        assertLe(stranded, MAX_STRANDED_DUST);
    }

    /// @notice 10-year horizon at 5% APY (~1.629x multiplier).
    function test_RedeemUsdOku_LiveCompounding_TenYears() public {
        _mintUsdOkuViaPsm(user1, 100_000e6);
        _setUsdRate(RATE_5_PCT_APY);

        _accrueAtCurrentRate(10 * 365 days);

        // 1.05^10 ≈ 1.62889
        assertApproxEqRel(okuDollar.usdMultiplier(), 1_628_894_626_777_442_000, 2e15);

        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, 500e18);
        assertLe(stranded, MAX_STRANDED_DUST);
    }

    /// @notice 25-year horizon at 5% APY (~3.386x). Multi-decade compound stress.
    function test_RedeemUsdOku_LiveCompounding_TwentyFiveYears() public {
        _mintUsdOkuViaPsm(user1, 100_000e6);
        _setUsdRate(RATE_5_PCT_APY);

        _accrueAtCurrentRate(25 * 365 days);

        // 1.05^25 ≈ 3.38635
        assertApproxEqRel(okuDollar.usdMultiplier(), 3_386_354_941_000_000_000, 5e15);

        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, 100e18);
        assertLe(stranded, MAX_STRANDED_DUST);
    }

    /// @notice 50-year horizon at 2% APY — keeps multiplier in reachable range while
    ///         still exercising decade-scale compounding. 1.02^50 ≈ 2.69159.
    function test_RedeemUsdOku_LiveCompounding_FiftyYearsAtTwoPercent() public {
        _mintUsdOkuViaPsm(user1, 100_000e6);
        _setUsdRate(RATE_2_PCT_APY);

        _accrueAtCurrentRate(50 * 365 days);

        assertApproxEqRel(okuDollar.usdMultiplier(), 2_691_588_029_000_000_000, 1e16);

        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, 100e18);
        assertLe(stranded, MAX_STRANDED_DUST);
    }

    // ============================================================
    // SECTION 5 — Time-walk: many redeems across a long horizon
    // ============================================================

    /// @notice Walk forward through 25 years of 5% APY, redeeming at each anniversary.
    ///         Each redeem happens against an actively-compounding multiplier with a
    ///         different value, so this exercises a wide spread of multiplier states
    ///         in a single test against a single deployment.
    function test_RedeemUsdOku_AnnualWalkOver25Years() public {
        _mintUsdOkuViaPsm(user1, 1_000_000e6); // 1M USDC -> 1M UsdOku
        _setUsdRate(RATE_5_PCT_APY);

        uint256 priorMult = okuDollar.usdMultiplier();
        for (uint256 year = 1; year <= 25; year++) {
            _accrueAtCurrentRate(365 days);
            uint256 currentMult = okuDollar.usdMultiplier();
            assertGt(currentMult, priorMult, "Multiplier must monotonically grow");
            priorMult = currentMult;

            // Redeem a fixed nominal amount each year.
            (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, 1e18);
            assertGt(usdcOut, 0, "Redeem succeeded at year");
            // Per-redeem stranded must remain bounded by 1 wei.
            assertLe(stranded, MAX_STRANDED_DUST);
        }

        // Total stranded across 25 redeems should be at most 25 wei.
        assertLe(okuDollar.balanceOf(address(litePsm)), 25);
    }

    /// @notice Walk forward through a half-year at hourly granularity, redeeming
    ///         every hour. Validates the high-frequency edge.
    function test_RedeemUsdOku_HourlyWalkOverThirtyDays() public {
        _mintUsdOkuViaPsm(user1, 1_000_000e6);
        _setUsdRate(RATE_5_PCT_APY);

        uint256 redeemsExpected = 30 * 24; // 720 hourly redeems
        for (uint256 i = 0; i < redeemsExpected; i++) {
            _accrueAtCurrentRate(1 hours);
            // `_redeemAndMeasure` already asserts the dollar-value conversion
            // for every call, so the per-iteration check here is redundant --
            // the loop's own property is the cumulative dust budget below.
            _redeemAndMeasure(user1, 1e17); // 0.1 UsdOku each
        }

        // Cumulative dust budget: at most 1 wei per redeem.
        assertLe(okuDollar.balanceOf(address(litePsm)), redeemsExpected);
    }

    // ============================================================
    // SECTION 6 — Cross-product: okuMMultiplier × usdMultiplier
    // ============================================================

    /// @notice Both multipliers elevated AND usd rate live. The single scenario
    ///         most likely to surface dual-multiplier rounding interactions.
    function test_RedeemUsdOku_DualLiveMultipliers() public {
        // Set okuMMultiplier to $1.05 first (rolls block internally).
        _setOkuMMultiplierAndRoll(105e16);
        // Mint UsdOku via PSM at the elevated okuMMultiplier.
        _mintUsdOkuViaPsm(user1, 100_000e6);

        // Activate USD yield rate and warp 2 years.
        _setUsdRate(RATE_5_PCT_APY);
        _accrueAtCurrentRate(2 * 365 days);

        // Both multipliers are now off-base.
        assertGt(okuMoney.okuMMultiplier(), PRECISION);
        assertGt(okuDollar.usdMultiplier(), PRECISION);

        uint256 redeemAmount = 100e18;
        (uint256 usdcOut, uint256 stranded) = _redeemAndMeasure(user1, redeemAmount);

        assertGt(usdcOut, 0, "Dual elevated multiplier redeem must succeed");
        assertLe(stranded, MAX_STRANDED_DUST);
    }

    // ============================================================
    // SECTION 7 — Property invariants
    // ============================================================

    /// @notice USDC paid out must never exceed the dollar value of the UsdOku that
    ///         was actually received by the PSM. Protocol must never lose money.
    function test_RedeemUsdOku_UsdcOutNeverExceedsReceivedDollarValue() public {
        _mintUsdOkuViaPsm(user1, 10_000e6);
        _setUsdRate(RATE_5_PCT_APY);
        _accrueAtCurrentRate(90 days);

        uint256 redeemAmount = 100e18;
        uint256 usdcBefore = usdc.balanceOf(user1);
        _approveOkuDollar(user1, address(litePsm), redeemAmount);
        vm.prank(user1);
        litePsm.redeemUsdOku(redeemAmount);
        uint256 usdcOut = usdc.balanceOf(user1) - usdcBefore;

        // USDC out scaled to 18 decimals must be <= requested dollar amount.
        assertLe(
            usdcOut * DECIMAL_MULTIPLIER, redeemAmount, "USDC out (18-dec) <= UsdOku in (18-dec)"
        );
    }

    /// @notice After a successful redeem, the PSM must not retain spendable UsdOku
    ///         that could be siphoned via a future caller. The fix guarantees this
    ///         (it passes `received` to unwrap, which burns all received shares).
    function test_RedeemUsdOku_PSMHoldsNoSpendableUsdOku_AfterRedeem() public {
        _mintUsdOkuViaPsm(user1, 100_000e6);
        _setUsdRate(RATE_5_PCT_APY);
        _accrueAtCurrentRate(1 days);

        uint256 strandedBefore = okuDollar.balanceOf(address(litePsm));
        _approveOkuDollar(user1, address(litePsm), 1000e18);
        vm.prank(user1);
        litePsm.redeemUsdOku(1000e18);

        uint256 strandedAfter = okuDollar.balanceOf(address(litePsm));
        // Delta is the actual stranded amount from this single redeem.
        assertLe(strandedAfter - strandedBefore, MAX_STRANDED_DUST);
    }
}
