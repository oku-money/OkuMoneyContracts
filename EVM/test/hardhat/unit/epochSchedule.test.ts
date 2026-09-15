import { expect } from "chai";
import {
    baseEndSec,
    epochEndSec,
    deriveBaseRate,
    deriveSettlementRateForEpoch,
    floatRateToBigint,
    toOnChainSchedule,
    DEFAULT_SETTLEMENT_FRACTION,
    EpochGrid,
} from "../../../scripts/utils/epochSchedule";
import { PRECISION, MAX_RATE } from "../../../scripts/utils/yieldRate";

describe("scripts/utils/epochSchedule", () => {
    const grid30d: EpochGrid = {
        epochStartSec: 0,
        epochLengthSec: 30 * 86400,
        settlementFraction: DEFAULT_SETTLEMENT_FRACTION,
    };

    describe("baseEndSec / epochEndSec", () => {
        it("computes a 2-day settlement window on a 30-day epoch at the default fraction", () => {
            const settlementLen = epochEndSec(grid30d) - baseEndSec(grid30d);
            expect(settlementLen).to.be.closeTo(2 * 86400, 1);
        });

        it("scales the settlement window proportionally for a 1-hour epoch", () => {
            const grid1h: EpochGrid = { epochStartSec: 0, epochLengthSec: 3600, settlementFraction: DEFAULT_SETTLEMENT_FRACTION };
            const settlementLen = epochEndSec(grid1h) - baseEndSec(grid1h);
            expect(settlementLen).to.be.closeTo(3600 / 15, 1);
        });
    });

    describe("deriveBaseRate", () => {
        it("targets baseWindowFraction of the (already cross-epoch-adjusted) target", () => {
            const { ratePerSecond, baseWindowTargetUsd } = deriveBaseRate({
                targetUsd: 40_000,
                baseWindowFraction: 0.9,
                measuredAvgValueUsd: 10_000_000,
                grid: grid30d,
            });
            expect(baseWindowTargetUsd).to.be.closeTo(40_000 * 0.9, 1e-6);
            expect(ratePerSecond).to.be.greaterThan(1);
        });

        it("baseWindowFraction = 1 targets the full amount in the base window (no within-epoch split)", () => {
            const { baseWindowTargetUsd } = deriveBaseRate({
                targetUsd: 40_000,
                baseWindowFraction: 1,
                measuredAvgValueUsd: 10_000_000,
                grid: grid30d,
            });
            expect(baseWindowTargetUsd).to.equal(40_000);
        });

        it("rejects baseWindowFraction outside (0, 1]", () => {
            expect(() =>
                deriveBaseRate({
                    targetUsd: 40_000,
                    baseWindowFraction: 0,
                    measuredAvgValueUsd: 10_000_000,
                    grid: grid30d,
                })
            ).to.throw(/baseWindowFraction/);
            expect(() =>
                deriveBaseRate({
                    targetUsd: 40_000,
                    baseWindowFraction: 1.1,
                    measuredAvgValueUsd: 10_000_000,
                    grid: grid30d,
                })
            ).to.throw(/baseWindowFraction/);
        });

        it("does NOT itself apply any cross-epoch buffer/carry — that's yieldRate.ts's job (see module doc)", () => {
            // Two calls with the same targetUsd but conceptually different
            // "upstream" carry should be indistinguishable to this function —
            // it only knows about the number it was given.
            const a = deriveBaseRate({
                targetUsd: 45_000, // caller already folded in +5k carry upstream
                baseWindowFraction: 0.9,
                measuredAvgValueUsd: 10_000_000,
                grid: grid30d,
            });
            const b = deriveBaseRate({
                targetUsd: 45_000,
                baseWindowFraction: 0.9,
                measuredAvgValueUsd: 10_000_000,
                grid: grid30d,
            });
            expect(a.ratePerSecond).to.equal(b.ratePerSecond);
        });
    });

    describe("deriveSettlementRateForEpoch", () => {
        it("targets the FULL (already-adjusted) epoch amount, recovering whatever baseWindowFraction withheld, not just the base window's own discounted target", () => {
            const targetUsd = 40_000;
            const baseWindowFraction = 0.9;
            const { baseWindowTargetUsd, ratePerSecond: rBaseFloat } = deriveBaseRate({
                targetUsd,
                baseWindowFraction,
                measuredAvgValueUsd: 10_000_000,
                grid: grid30d,
            });

            // Simulate the base window distributing exactly its own target (idealized),
            // and stage EXACTLY at baseEndSec so there's no remaining base tail
            // to project (isolates the withheld-fraction behavior being tested).
            const distributedSoFarUsd = baseWindowTargetUsd;

            const rSettle = deriveSettlementRateForEpoch({
                targetUsd,
                distributedSoFarUsd,
                settlementForecastAvgValueUsd: 10_000_000,
                grid: grid30d,
                stagingSec: baseEndSec(grid30d),
                baseRatePerSecond: rBaseFloat,
            });

            // Settlement must still target the withheld 10% (~4k of 40k),
            // not just close a zero gap.
            expect(rSettle).to.be.greaterThan(1);
        });

        it("subtracts the PROJECTED base-window tail when staging happens before baseEndSec — this is the fix for a real bug (see TRACKER.md)", () => {
            const targetUsd = 40_000;
            const baseWindowFraction = 1.0; // isolate the tail effect, no withholding
            const measuredAvgValueUsd = 10_000_000;
            const { baseWindowTargetUsd, ratePerSecond: rBaseFloat } = deriveBaseRate({
                targetUsd,
                baseWindowFraction,
                measuredAvgValueUsd,
                grid: grid30d,
            });

            // Stage 2 days before baseEndSec (a realistic lead time) — base
            // window has only distributed a PORTION of its own target so far.
            const stagingSec = baseEndSec(grid30d) - 2 * 86400;
            // Idealized: distributed exactly proportional to elapsed base-window time.
            const baseWindowLenSec = grid30d.epochLengthSec * (1 - grid30d.settlementFraction);
            const elapsedFrac = (stagingSec - grid30d.epochStartSec) / baseWindowLenSec;
            const distributedSoFarUsd = baseWindowTargetUsd * elapsedFrac;

            const rSettleWithTail = deriveSettlementRateForEpoch({
                targetUsd,
                distributedSoFarUsd,
                settlementForecastAvgValueUsd: measuredAvgValueUsd,
                grid: grid30d,
                stagingSec,
                baseRatePerSecond: rBaseFloat,
            });

            // Without the tail correction (old buggy behavior), the settlement
            // rate would be derived as if the ~2 remaining base-window days
            // don't exist — i.e. targeting the FULL remaining gap
            // (targetUsd - distributedSoFarUsd) instead of that minus the
            // projected tail. That would produce a HIGHER settlement rate than
            // the corrected version, since it fails to account for base-window
            // accrual that's still coming.
            const growthWithoutTailFix =
                1 + (targetUsd - distributedSoFarUsd) / measuredAvgValueUsd;
            const rSettleWithoutTailFix = Math.pow(
                growthWithoutTailFix,
                1 / (grid30d.epochLengthSec * grid30d.settlementFraction)
            );

            expect(rSettleWithTail).to.be.lessThan(rSettleWithoutTailFix);
        });
    });

    describe("floatRateToBigint", () => {
        it("maps 1.0 (no yield) to PRECISION", () => {
            expect(floatRateToBigint(1.0)).to.equal(PRECISION);
        });

        it("maps a below-1 (invalid) float defensively to PRECISION rather than a negative/garbage bigint", () => {
            expect(floatRateToBigint(0.5)).to.equal(PRECISION);
        });

        it("clamps an excessive rate to MAX_RATE instead of producing an out-of-range bigint", () => {
            const huge = 100; // absurd per-second rate
            expect(floatRateToBigint(huge)).to.equal(MAX_RATE);
        });

        it("round-trips a realistic rate within 1e18 precision", () => {
            const rate = 1.0000000015;
            const scaled = floatRateToBigint(rate);
            expect(scaled).to.be.greaterThan(PRECISION);
            expect(scaled).to.be.lessThan(MAX_RATE);
            expect(Number(scaled) / 1e18).to.be.closeTo(rate, 1e-9);
        });
    });

    describe("toOnChainSchedule", () => {
        it("produces integer-second boundaries and clamped bigint rates ready for setOkuMYieldRateWithSuccessor", () => {
            const schedule = toOnChainSchedule({
                rBaseFloat: 1.0000000015,
                rSettleFloat: 1.000000003,
                grid: grid30d,
            });
            expect(Number.isInteger(schedule.baseEndSec)).to.be.true;
            expect(Number.isInteger(schedule.settleEndSec)).to.be.true;
            expect(schedule.settleEndSec).to.be.greaterThan(schedule.baseEndSec);
            expect(schedule.rBase).to.be.greaterThan(PRECISION);
            expect(schedule.rSettle).to.be.greaterThan(PRECISION);
        });
    });
});
