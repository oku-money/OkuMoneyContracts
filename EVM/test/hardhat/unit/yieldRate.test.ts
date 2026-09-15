import { expect } from "chai";
import {
    apyToRatePerSecond,
    ratePerSecondToApy,
    realisedYieldToRatePerSecond,
    reconcileActualPayout,
    timeWeightedAverage,
    PRECISION,
    MAX_RATE,
    SECONDS_PER_YEAR,
} from "../../../scripts/utils/yieldRate";

// Pure TS logic — no network/fork needed. Covers the rear-facing epoch
// accounting model documented in EVM/README.md § Rear-Facing Epoch Accounting:
// converting realised yield into a rate against a TIME-WEIGHTED average value
// (not a spot value), the internal-bookkeeping carry ledger, and the ex-post
// `reconcileActualPayout` step that closes the gap internal bookkeeping can't
// (see the "Two V's" doc block on `realisedYieldToRatePerSecond`).
describe("scripts/utils/yieldRate", () => {
    describe("apyToRatePerSecond / ratePerSecondToApy", () => {
        it("round-trips a representative APY within float precision", () => {
            const rate = apyToRatePerSecond(0.05);
            expect(rate).to.be.greaterThan(PRECISION);
            const apy = ratePerSecondToApy(rate);
            expect(apy).to.be.closeTo(0.05, 1e-6);
        });

        it("0% APY maps to exactly PRECISION", () => {
            expect(apyToRatePerSecond(0)).to.equal(PRECISION);
        });

        it("rejects negative APY (multiplier is monotonic)", () => {
            expect(() => apyToRatePerSecond(-0.01)).to.throw(/must be >= 0/);
        });

        it("rejects an APY that exceeds MAX_RATE", () => {
            expect(() => apyToRatePerSecond(1000)).to.throw(/exceeds MAX_RATE/);
        });
    });

    describe("realisedYieldToRatePerSecond — no carry (baseline)", () => {
        it("fully reconciles a mid-range realised yield with ~zero carry", () => {
            const windowSeconds = Number(SECONDS_PER_YEAR) / 12; // ~1 month
            const { ratePerSecond, carryForwardUsd } = realisedYieldToRatePerSecond(
                50_000, // realised yield
                12_000_000, // global value
                windowSeconds
            );
            expect(ratePerSecond).to.be.greaterThan(PRECISION);
            expect(ratePerSecond).to.be.lessThan(MAX_RATE);
            // Reconciliation dust only — not exactly zero due to float/rpow rounding.
            expect(Math.abs(carryForwardUsd)).to.be.lessThan(1);
        });

        it("rejects negative realised yield (must use carryInUsd instead)", () => {
            expect(() =>
                realisedYieldToRatePerSecond(-100, 1_000_000, 86400)
            ).to.throw(/Negative REALISED yield/);
        });

        it("rejects non-positive measuredAvgValueUsd / windowSeconds", () => {
            expect(() => realisedYieldToRatePerSecond(100, 0, 86400)).to.throw(
                /measuredAvgValueUsd/
            );
            expect(() => realisedYieldToRatePerSecond(100, 1_000_000, 0)).to.throw(
                /windowSeconds/
            );
        });
    });

    describe("realisedYieldToRatePerSecond — conservative publish + carry-in", () => {
        it("under-publishing via conservativeFactor carries the withheld spread FORWARD (positive)", () => {
            const windowSeconds = 86400 * 30;
            const measuredAvgValueUsd = 10_000_000;
            const trueYieldUsd = 40_000;
            const conservativeFactor = 0.9;

            const { carryForwardUsd } = realisedYieldToRatePerSecond(
                trueYieldUsd,
                measuredAvgValueUsd,
                windowSeconds,
                0,
                conservativeFactor
            );

            // The unpublished 10% must appear as a positive carry to fold into
            // next epoch's carryInUsd — never silently dropped.
            const withheld = trueYieldUsd * (1 - conservativeFactor);
            expect(carryForwardUsd).to.be.closeTo(withheld, 1);
        });

        it("steady state: constant realised yield + constant conservativeFactor converges carry to a stable residual, not unbounded growth", () => {
            const windowSeconds = 86400 * 30;
            const measuredAvgValueUsd = 10_000_000;
            const trueYieldPerEpoch = 40_000;
            const conservativeFactor = 0.9; // publish 90% of realised yield every epoch

            let carry = 0;
            const carryHistory: number[] = [];
            for (let epoch = 0; epoch < 6; epoch++) {
                const result = realisedYieldToRatePerSecond(
                    trueYieldPerEpoch,
                    measuredAvgValueUsd,
                    windowSeconds,
                    carry,
                    conservativeFactor
                );
                carry = result.carryForwardUsd;
                carryHistory.push(carry);
            }

            // Carry should stabilise near the steady-state withheld-per-epoch
            // spread (trueYieldPerEpoch * (1 - conservativeFactor)), not
            // accumulate unboundedly epoch over epoch.
            const steadyStateWithheld = trueYieldPerEpoch * (1 - conservativeFactor);
            expect(carryHistory[carryHistory.length - 1]).to.be.closeTo(
                steadyStateWithheld,
                steadyStateWithheld * 0.05
            );
            // Confirm it actually converged (last two epochs are close to each other).
            expect(
                Math.abs(carryHistory[5] - carryHistory[4])
            ).to.be.lessThan(steadyStateWithheld * 0.01);
        });

        it("a positive carry-in (prior under-payment) is folded into this epoch's published rate", () => {
            const windowSeconds = 86400 * 30;
            const measuredAvgValueUsd = 10_000_000;

            const withoutCarry = realisedYieldToRatePerSecond(30_000, measuredAvgValueUsd, windowSeconds, 0);
            const withCarry = realisedYieldToRatePerSecond(30_000, measuredAvgValueUsd, windowSeconds, 10_000);

            expect(withCarry.ratePerSecond).to.be.greaterThan(withoutCarry.ratePerSecond);
        });

        it("a negative carry-in (prior OVER-payment) DECELERATES this epoch's rate without violating monotonicity", () => {
            const windowSeconds = 86400 * 30;
            const measuredAvgValueUsd = 10_000_000;

            const withoutCarry = realisedYieldToRatePerSecond(30_000, measuredAvgValueUsd, windowSeconds, 0);
            const withNegativeCarry = realisedYieldToRatePerSecond(
                30_000,
                measuredAvgValueUsd,
                windowSeconds,
                -10_000
            );

            // Slower than the uncorrected rate...
            expect(withNegativeCarry.ratePerSecond).to.be.lessThan(withoutCarry.ratePerSecond);
            // ...but never below PRECISION (the multiplier can only ever hold or grow).
            expect(withNegativeCarry.ratePerSecond).to.be.greaterThanOrEqual(PRECISION);
        });

        it("a carry-in deficit larger than realised yield clamps to PRECISION and carries the UNPAID remainder forward (does not destroy debt)", () => {
            const windowSeconds = 86400 * 30;
            const measuredAvgValueUsd = 10_000_000;

            // Realised 5k this epoch, but we over-paid 20k last epoch: net desired
            // growth is negative, which cannot be expressed on-chain (monotonic).
            const { ratePerSecond, carryForwardUsd } = realisedYieldToRatePerSecond(
                5_000,
                measuredAvgValueUsd,
                windowSeconds,
                -20_000
            );

            // Halts accrual this epoch rather than reverting or going negative.
            expect(ratePerSecond).to.equal(PRECISION);
            // The full unpaid deficit (5,000 - 20,000 = -15,000) rolls forward,
            // to be resolved by continuing to under-pay in future epochs.
            expect(carryForwardUsd).to.be.closeTo(-15_000, 1);
        });

        it("a desired rate above MAX_RATE clamps and carries the UNPAID surplus forward (does not throw)", () => {
            const windowSeconds = 86400; // 1 day — makes hitting MAX_RATE easy
            const measuredAvgValueUsd = 1_000_000;
            // An enormous realised yield relative to global value and window.
            const { ratePerSecond, carryForwardUsd } = realisedYieldToRatePerSecond(
                5_000_000,
                measuredAvgValueUsd,
                windowSeconds
            );

            expect(ratePerSecond).to.equal(MAX_RATE);
            // Whatever MAX_RATE couldn't pay this epoch must be positive and
            // carried forward, not thrown away.
            expect(carryForwardUsd).to.be.greaterThan(0);
        });

        it("rejects inputs implying a >=100% loss (operationally unreachable, but must fail loudly not silently)", () => {
            expect(() =>
                realisedYieldToRatePerSecond(0, 1_000_000, 86400, -1_000_000)
            ).to.throw(/>=100% loss/);
        });
    });

    describe("timeWeightedAverage", () => {
        it("returns the flat value when supply/value never changes", () => {
            const samples = [
                { timestampSec: 0, valueUsd: 10_000_000 },
                { timestampSec: 86400, valueUsd: 10_000_000 },
            ];
            expect(timeWeightedAverage(samples)).to.equal(10_000_000);
        });

        it("weights by DURATION, not by sample count", () => {
            // Value doubles after 90% of the window has elapsed — a naive
            // arithmetic mean of samples would overweight the brief high period.
            const samples = [
                { timestampSec: 0, valueUsd: 10_000_000 },
                { timestampSec: 900, valueUsd: 10_000_000 },
                { timestampSec: 1000, valueUsd: 20_000_000 }, // last 10% only
            ];
            const twa = timeWeightedAverage(samples);
            // Naive mean of the 3 sample VALUES would be ~13.3M; time-weighted
            // correctly gives 10.5M since the low value holds for 90% of the
            // duration and the doubled value holds for only the last 10%:
            // (10M*900 + 15M*100) / 1000 = 10.5M.
            expect(twa).to.be.closeTo(10_500_000, 1);
        });

        it("rejects fewer than 2 samples", () => {
            expect(() => timeWeightedAverage([{ timestampSec: 0, valueUsd: 1 }])).to.throw(
                /at least 2 samples/
            );
        });

        it("rejects out-of-order timestamps", () => {
            expect(() =>
                timeWeightedAverage([
                    { timestampSec: 100, valueUsd: 1 },
                    { timestampSec: 0, valueUsd: 1 },
                ])
            ).to.throw(/chronologically sorted/);
        });

        it("rejects a zero-duration sample set", () => {
            expect(() =>
                timeWeightedAverage([
                    { timestampSec: 100, valueUsd: 1 },
                    { timestampSec: 100, valueUsd: 2 },
                ])
            ).to.throw(/zero duration/);
        });
    });

    describe("supply changing mid-epoch: spot denominator vs time-weighted denominator", () => {
        it("a SPOT denominator at epoch start over-states the realised rate when supply grows mid-epoch", () => {
            // Global value starts at 10M and grows linearly to 15M over the epoch
            // (e.g. a large mint at the midpoint). Realised yield for the epoch
            // is a known, fixed dollar amount.
            const windowSeconds = 86400 * 30;
            const realisedYieldUsd = 40_000;
            const spotAtStart = 10_000_000;

            // Simulate hourly samples of a linear ramp 10M -> 15M.
            const samples: { timestampSec: number; valueUsd: number }[] = [];
            const hours = windowSeconds / 3600;
            for (let h = 0; h <= hours; h++) {
                const frac = h / hours;
                samples.push({
                    timestampSec: h * 3600,
                    valueUsd: spotAtStart + frac * 5_000_000,
                });
            }
            const twa = timeWeightedAverage(samples); // ~12.5M

            const spotResult = realisedYieldToRatePerSecond(realisedYieldUsd, spotAtStart, windowSeconds);
            const twaResult = realisedYieldToRatePerSecond(realisedYieldUsd, twa, windowSeconds);

            // The spot-denominator rate is higher (it divides the same yield by
            // a smaller base) — this is exactly the over-distribution failure
            // mode: applied against the REAL (grown) supply, it would pay out
            // more than was actually realised.
            expect(spotResult.ratePerSecond).to.be.greaterThan(twaResult.ratePerSecond);

            // Quantify: growth cancels out of the accounting error's driver — a
            // spot-vs-average gap of ~25% here (10M vs ~12.5M) produces a
            // proportionally similar overstatement in implied APY.
            const spotApy = ratePerSecondToApy(spotResult.ratePerSecond);
            const twaApy = ratePerSecondToApy(twaResult.ratePerSecond);
            expect(spotApy / twaApy).to.be.greaterThan(1.2);
        });
    });

    describe("reconcileActualPayout", () => {
        it("returns zero when actual payout exactly matches the target", () => {
            expect(reconcileActualPayout(40_000, 40_000)).to.equal(0);
        });

        it("returns a POSITIVE residual (under-paid) when the paying epoch's real AUM was smaller than assumed", () => {
            // Rate was derived assuming ~10M average value, but the paying
            // epoch's REAL time-weighted average turned out lower (e.g. net
            // redemptions), so the same rate paid out less than the target.
            const targetUsd = 40_000;
            const publishedRatePerSecond = 1.0000000015; // illustrative float rate
            const windowSeconds = 86400 * 30;
            const payingEpochRealAvgValueUsd = 9_000_000; // lower than the 10M assumed

            const achievedGrowth = Math.pow(publishedRatePerSecond, windowSeconds) - 1;
            const actualPaidUsd = achievedGrowth * payingEpochRealAvgValueUsd;

            const residual = reconcileActualPayout(targetUsd, actualPaidUsd);
            expect(residual).to.be.greaterThan(0);
        });

        it("returns a NEGATIVE residual (over-paid) when the paying epoch's real AUM was larger than assumed", () => {
            const targetUsd = 40_000;
            const publishedRatePerSecond = 1.0000000015;
            const windowSeconds = 86400 * 30;
            const payingEpochRealAvgValueUsd = 11_000_000; // higher than the 10M assumed

            const achievedGrowth = Math.pow(publishedRatePerSecond, windowSeconds) - 1;
            const actualPaidUsd = achievedGrowth * payingEpochRealAvgValueUsd;

            const residual = reconcileActualPayout(targetUsd, actualPaidUsd);
            expect(residual).to.be.lessThan(0);
        });

        it("cumulative conservation: summing residuals across epochs tracks cumulative realised yield", () => {
            // Simulate 4 epochs where the paying epoch's real AUM always differs
            // from what was assumed when the rate was derived, and confirm the
            // sum of (target - actual) equals the sum of targets minus the sum
            // of actuals exactly (tautological, but confirms no silent drift in
            // the accounting identity as carry threads through epochs).
            const targets = [40_000, 42_000, 41_000, 39_500];
            const actuals = [38_000, 43_500, 40_800, 39_000];

            let cumulativeResidual = 0;
            for (let i = 0; i < targets.length; i++) {
                cumulativeResidual += reconcileActualPayout(targets[i], actuals[i]);
            }

            const expectedCumulative =
                targets.reduce((a, b) => a + b, 0) - actuals.reduce((a, b) => a + b, 0);
            expect(cumulativeResidual).to.be.closeTo(expectedCumulative, 1e-9);
        });
    });
});
