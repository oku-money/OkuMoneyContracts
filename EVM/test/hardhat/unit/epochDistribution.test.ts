import { expect } from "chai";
import {
    multiplierAt,
    distributedUsdOverWindow,
    deriveSettlementRate,
    RateSegment,
} from "../../../scripts/utils/epochDistribution";
import { valueAt } from "../../../scripts/utils/globalValue";

describe("scripts/utils/epochDistribution", () => {
    describe("multiplierAt", () => {
        const segments: RateSegment[] = [
            { startSec: 0, endSec: 1000, ratePerSecond: 1.0000001, anchorMultiplier: 1.0 },
            { startSec: 1000, endSec: 2000, ratePerSecond: 1.0000002, anchorMultiplier: 1.1 },
        ];

        it("returns the anchor exactly at a segment's start", () => {
            expect(multiplierAt(segments, 0)).to.equal(1.0);
            expect(multiplierAt(segments, 1000)).to.equal(1.1);
        });

        it("compounds within a segment", () => {
            const m = multiplierAt(segments, 500);
            expect(m).to.be.greaterThan(1.0);
            expect(m).to.be.closeTo(1.0 * Math.pow(1.0000001, 500), 1e-9);
        });

        it("clamps to the first segment before the schedule starts", () => {
            expect(multiplierAt(segments, -100)).to.equal(1.0);
        });

        it("holds at the last segment's end value past the schedule's end", () => {
            const atEnd = 1.1 * Math.pow(1.0000002, 1000);
            expect(multiplierAt(segments, 5000)).to.be.closeTo(atEnd, 1e-9);
        });

        it("throws with no segments", () => {
            expect(() => multiplierAt([], 0)).to.throw(/no segments/);
        });
    });

    describe("distributedUsdOverWindow", () => {
        it("matches hand-computed distribution for a single flat-supply segment", () => {
            // Constant supply of 10,000,000 tokens (valueUsd == supply since m=1 at start),
            // rate chosen so growth over 1000s is a known, clean value.
            const rate = 1.0000001; // ~0.00001%/s
            const segments: RateSegment[] = [
                { startSec: 0, endSec: 1000, ratePerSecond: rate, anchorMultiplier: 1.0 },
            ];
            // Flat value samples: supply constant, multiplier moves, so valueUsd
            // samples must reflect m(t)*S with S constant. Build them from multiplierAt.
            const S = 10_000_000;
            const samples = [0, 250, 500, 750, 1000].map((t) => ({
                timestampSec: t,
                valueUsd: S * multiplierAt(segments, t),
            }));

            const distributed = distributedUsdOverWindow(segments, samples, 0, 1000);
            // Samples are built FROM `multiplierAt`, so the sum telescopes to
            // `S * (m(1000) - m(0))` for any `multiplierAt`, including a wrong
            // one; assert a closed form instead: constant supply S growing at a constant rate
            // for 1000 seconds distributes S * (rate^1000 - 1).
            const expected = S * (Math.pow(rate, 1000) - 1);
            expect(distributed, "flat-supply distribution is S * (rate^t - 1)")
                .to.be.closeTo(expected, 1e-6);
        });

        it("a mid-window supply INCREASE contributes proportionally less than if it had been present from the start", () => {
            const rate = 1.0000001;
            const segments: RateSegment[] = [
                { startSec: 0, endSec: 1000, ratePerSecond: rate, anchorMultiplier: 1.0 },
            ];
            const S0 = 10_000_000;
            const S1 = 15_000_000; // supply jumps at t=500

            const samplesWithJump = [
                { timestampSec: 0, valueUsd: S0 * multiplierAt(segments, 0) },
                { timestampSec: 500, valueUsd: S0 * multiplierAt(segments, 500) }, // just before jump
                { timestampSec: 500.001, valueUsd: S1 * multiplierAt(segments, 500.001) }, // just after
                { timestampSec: 1000, valueUsd: S1 * multiplierAt(segments, 1000) },
            ];
            const distributedWithJump = distributedUsdOverWindow(segments, samplesWithJump, 0, 1000);

            const samplesFlatHigh = [0, 500, 1000].map((t) => ({
                timestampSec: t,
                valueUsd: S1 * multiplierAt(segments, t),
            }));
            const distributedFlatHigh = distributedUsdOverWindow(segments, samplesFlatHigh, 0, 1000);

            // Late-arriving supply earns less than if it had been present the whole window.
            expect(distributedWithJump).to.be.lessThan(distributedFlatHigh);
            expect(distributedWithJump).to.be.greaterThan(0);
        });

        it("throws with fewer than 2 samples in the window", () => {
            const segments: RateSegment[] = [
                { startSec: 0, endSec: 1000, ratePerSecond: 1.0000001, anchorMultiplier: 1.0 },
            ];
            expect(() =>
                distributedUsdOverWindow(segments, [{ timestampSec: 0, valueUsd: 1 }], 0, 1000)
            ).to.throw(/need at least 2/);
        });

        it("extrapolates the final partial interval when the last sample is BEFORE windowEndSec, rather than silently under-counting it", () => {
            // Ignoring the gap to windowEndSec under-counts ~1.6% of the epoch
            // target at typical staging leads.
            const rate = 1.0000001;
            const segments: RateSegment[] = [
                { startSec: 0, endSec: 1000, ratePerSecond: rate, anchorMultiplier: 1.0 },
            ];
            const S = 10_000_000;
            // Samples only go up to t=800, but we ask for distribution through t=1000.
            const samples = [0, 400, 800].map((t) => ({
                timestampSec: t,
                valueUsd: S * multiplierAt(segments, t),
            }));

            const distributed = distributedUsdOverWindow(segments, samples, 0, 1000);
            const expected = S * (multiplierAt(segments, 1000) - multiplierAt(segments, 0));
            expect(distributed).to.be.closeTo(expected, 1e-3);
        });

        it("does NOT extrapolate when the last sample already sits exactly at windowEndSec (no gap to fill)", () => {
            const rate = 1.0000001;
            const segments: RateSegment[] = [
                { startSec: 0, endSec: 1000, ratePerSecond: rate, anchorMultiplier: 1.0 },
            ];
            const S = 10_000_000;
            const samples = [0, 500, 1000].map((t) => ({
                timestampSec: t,
                valueUsd: S * multiplierAt(segments, t),
            }));
            const distributed = distributedUsdOverWindow(segments, samples, 0, 1000);
            const expected = S * (multiplierAt(segments, 1000) - multiplierAt(segments, 0));
            expect(distributed).to.be.closeTo(expected, 1e-6);
        });
    });

    describe("deriveSettlementRate", () => {
        it("closes the gap exactly when the forecast average value is exactly correct", () => {
            const targetUsd = 40_000;
            const distributedSoFarUsd = 36_000; // base window under-shot, 4k remaining
            const settlementForecastAvgValueUsd = 10_000_000;
            const settlementLenSec = 5760; // 24h epoch at the default 1/15 settlement fraction

            const rate = deriveSettlementRate({
                targetUsd,
                distributedSoFarUsd,
                settlementForecastAvgValueUsd,
                settlementLenSec,
            });

            // Verify: applying this rate over the settlement window against the
            // SAME forecast value should distribute exactly the remaining 4k
            // (to within float round-trip error from composing Math.pow twice
            // over a ~5,760-second exponent — not a logic error).
            const growth = Math.pow(rate, settlementLenSec) - 1;
            const distributedInSettlement = growth * settlementForecastAvgValueUsd;
            expect(distributedInSettlement).to.be.closeTo(targetUsd - distributedSoFarUsd, 1e-3);
        });

        it("returns PRECISION (rate=1) when the base window already met or exceeded the target", () => {
            const rate = deriveSettlementRate({
                targetUsd: 40_000,
                distributedSoFarUsd: 45_000, // overshoot
                settlementForecastAvgValueUsd: 10_000_000,
                settlementLenSec: 5760, // 24h epoch at the default 1/15 settlement fraction
            });
            expect(rate).to.equal(1);
        });

        it("under-forecasting the settlement window's average value causes the settlement to OVER-distribute (residual carries to next epoch)", () => {
            const targetUsd = 40_000;
            const distributedSoFarUsd = 36_000;
            const forecastValueUsd = 8_000_000; // forecast LOW
            const actualValueUsd = 10_000_000; // actual turns out HIGHER
            const settlementLenSec = 5760; // 24h epoch at the default 1/15 settlement fraction

            const rate = deriveSettlementRate({
                targetUsd,
                distributedSoFarUsd,
                settlementForecastAvgValueUsd: forecastValueUsd,
                settlementLenSec,
            });

            const growth = Math.pow(rate, settlementLenSec) - 1;
            const actualDistributed = growth * actualValueUsd;
            // Rate was derived to hit the target AGAINST the (too-low) forecast,
            // so applying it against the higher actual value over-distributes.
            expect(actualDistributed).to.be.greaterThan(targetUsd - distributedSoFarUsd);
        });

        it("rejects non-positive settlementForecastAvgValueUsd / settlementLenSec", () => {
            expect(() =>
                deriveSettlementRate({
                    targetUsd: 1000,
                    distributedSoFarUsd: 0,
                    settlementForecastAvgValueUsd: 0,
                    settlementLenSec: 86400,
                })
            ).to.throw(/settlementForecastAvgValueUsd/);
            expect(() =>
                deriveSettlementRate({
                    targetUsd: 1000,
                    distributedSoFarUsd: 0,
                    settlementForecastAvgValueUsd: 1_000_000,
                    settlementLenSec: 0,
                })
            ).to.throw(/settlementLenSec/);
        });

        it("rejects a negative baseTailSec", () => {
            expect(() =>
                deriveSettlementRate({
                    targetUsd: 1000,
                    distributedSoFarUsd: 0,
                    settlementForecastAvgValueUsd: 1_000_000,
                    settlementLenSec: 86400,
                    baseTailSec: -1,
                })
            ).to.throw(/baseTailSec/);
        });

        it("projects the base-window tail forward using baseTailRatePerSecond, reducing the settlement target by exactly that projection", () => {
            const targetUsd = 40_000;
            const distributedSoFarUsd = 30_000;
            const forecastValueUsd = 10_000_000;
            const settlementLenSec = 5760; // 24h epoch at the default 1/15 settlement fraction
            const baseTailSec = 4 * 3600; // realistic staging lead inside a 22.4h base window
            const baseTailRatePerSecond = 1.0000000009344034; // ~3.2% APY per-second

            const projectedTailUsd =
                forecastValueUsd * (Math.pow(baseTailRatePerSecond, baseTailSec) - 1);

            const rate = deriveSettlementRate({
                targetUsd,
                distributedSoFarUsd,
                settlementForecastAvgValueUsd: forecastValueUsd,
                settlementLenSec,
                baseTailRatePerSecond,
                baseTailSec,
            });

            const growth = Math.pow(rate, settlementLenSec) - 1;
            const distributedInSettlement = growth * forecastValueUsd;
            const expectedRemaining = targetUsd - distributedSoFarUsd - projectedTailUsd;
            expect(distributedInSettlement).to.be.closeTo(expectedRemaining, 1e-3);
        });
    });

    describe("CORE VALIDATION: full base+settlement pipeline lands near Y* under flat supply with NO deliberate buffer", () => {
        // With conservativeFactor=1.0 (no deliberate withholding) and zero supply
        // volatility, the mechanism should land within rounding of the raw target.
        it("lands within 0.1% of Y* — proves the base-tail and extrapolation fixes compose correctly", () => {
            const initialSupplyUsd = 1_000_000;
            const realizedApy = 0.032;
            const epochLengthSec = 24 * 3600; // 24h production epoch
            const settlementFraction = 1 / 15;
            const conservativeFactor = 1.0; // NO deliberate buffer — isolate mechanism error only

            const yearSec = 365 * 86400;
            const rawTargetUsd = initialSupplyUsd * (Math.pow(1 + realizedApy, epochLengthSec / yearSec) - 1);
            const adjustedTargetUsd = rawTargetUsd * conservativeFactor;

            const baseWindowLenSec = epochLengthSec * (1 - settlementFraction);
            const baseWindowFraction = 0.9;
            const baseWindowTargetUsd = adjustedTargetUsd * baseWindowFraction;
            const rBaseFloat = Math.pow(1 + baseWindowTargetUsd / initialSupplyUsd, 1 / baseWindowLenSec);

            // Stage at 92% through the epoch (2% before baseEnd at 93.33%),
            // flat supply throughout — the ONLY thing moving is the multiplier.
            const stagingFrac = 1 - settlementFraction - 0.02;
            const stagingSec = epochLengthSec * stagingFrac;
            const baseEndSecVal = epochLengthSec * (1 - settlementFraction);

            // Samples every 30min (48 across a 24h epoch), flat supply.
            const samples: { timestampSec: number; valueUsd: number }[] = [];
            const segments: RateSegment[] = [{ startSec: 0, endSec: baseEndSecVal, ratePerSecond: rBaseFloat, anchorMultiplier: 1.0 }];
            for (let i = 0; i <= 48; i++) {
                const t = (epochLengthSec * i) / 48;
                if (t <= stagingSec) samples.push({ timestampSec: t, valueUsd: initialSupplyUsd * multiplierAt(segments, t) });
            }

            const distributedSoFarUsd = distributedUsdOverWindow(segments, samples, 0, stagingSec);
            const forecastValueUsd = valueAt(samples, stagingSec);

            const rSettleFloat = deriveSettlementRate({
                targetUsd: adjustedTargetUsd,
                distributedSoFarUsd,
                settlementForecastAvgValueUsd: forecastValueUsd,
                settlementLenSec: epochLengthSec * settlementFraction,
                baseTailRatePerSecond: rBaseFloat,
                baseTailSec: baseEndSecVal - stagingSec,
            });

            segments.push({
                startSec: baseEndSecVal,
                endSec: epochLengthSec,
                ratePerSecond: rSettleFloat,
                anchorMultiplier: multiplierAt(segments, baseEndSecVal),
            });

            // Ground truth: flat supply throughout, so exact distribution is trivial.
            const finalMultiplier = multiplierAt(segments, epochLengthSec);
            const exactDistributedUsd = initialSupplyUsd * (finalMultiplier - 1.0);

            const errorPct = ((exactDistributedUsd - rawTargetUsd) / rawTargetUsd) * 100;
            expect(Math.abs(errorPct)).to.be.lessThan(0.1);
        });
    });
});
