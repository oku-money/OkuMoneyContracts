import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import {
    appendSample,
    loadSamples,
    samplesInWindow,
    sampleGlobalValueUsd,
    valueAt,
    cumulativeDistributedUsd,
    GlobalValueSample,
} from "../../../scripts/utils/globalValue";
import { timeWeightedAverage } from "../../../scripts/utils/yieldRate";
import { RateSegment } from "../../../scripts/utils/epochDistribution";

// Pure TS logic — no network needed. Uses a temp file per test so it never
// touches the real (gitignored) scripts/config/globalValueSamples.json store.
// The chain set every sample below is taken against.
const CHAINS = ["baseSepolia", "sepolia"];
const perChain = (v: number) => ({ baseSepolia: v / 2, sepolia: v / 2 });

describe("scripts/utils/globalValue", () => {
    let tmpPath: string;

    beforeEach(() => {
        tmpPath = path.join(os.tmpdir(), `globalValueSamples.${Date.now()}.${Math.random()}.json`);
    });

    afterEach(() => {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    });

    describe("loadSamples / appendSample", () => {
        it("returns an empty array when the store doesn't exist yet", () => {
            expect(loadSamples(tmpPath)).to.deep.equal([]);
        });

        it("round-trips a sample through append + load", () => {
            const sample: GlobalValueSample = {
                timestampSec: 1000,
                valueUsd: 10_000_000,
                perChain: { base: 6_000_000, arbitrum: 4_000_000 },
            };
            appendSample(sample, tmpPath);
            const loaded = loadSamples(tmpPath);
            expect(loaded).to.have.length(1);
            expect(loaded[0]).to.deep.equal(sample);
        });

        it("appends without clobbering prior samples", () => {
            appendSample({ timestampSec: 1000, valueUsd: 10_000_000, perChain: perChain(10_000_000) }, tmpPath);
            appendSample({ timestampSec: 2000, valueUsd: 10_500_000, perChain: perChain(10_500_000) }, tmpPath);
            const loaded = loadSamples(tmpPath);
            expect(loaded).to.have.length(2);
            expect(loaded.map((s) => s.timestampSec)).to.deep.equal([1000, 2000]);
        });

        it("writes atomically (no tmp file left behind)", () => {
            appendSample({ timestampSec: 1000, valueUsd: 1, perChain: perChain(1) }, tmpPath);
            const leftovers = fs.readdirSync(path.dirname(tmpPath)).filter((f) => f.startsWith(path.basename(tmpPath) + ".tmp"));
            expect(leftovers).to.deep.equal([]);
        });
    });

    describe("samplesInWindow", () => {
        beforeEach(() => {
            // A day of hourly samples, flat at 10M then ramping to 11M in the last hour.
            for (let h = 0; h <= 24; h++) {
                const v = h < 23 ? 10_000_000 : 10_500_000;
                appendSample({ timestampSec: h * 3600, valueUsd: v, perChain: perChain(v), chains: CHAINS }, tmpPath);
            }
        });

        it("selects only samples within the requested window, chronologically sorted", () => {
            const selected = samplesInWindow(0, 12 * 3600, CHAINS, tmpPath);
            expect(selected.length).to.equal(13); // hours 0..12 inclusive
            expect(selected[0].timestampSec).to.equal(0);
            expect(selected[selected.length - 1].timestampSec).to.equal(12 * 3600);
        });

        it("is directly consumable by timeWeightedAverage", () => {
            // Exact trapezoidal arithmetic is covered in yieldRate.test.ts; this
            // just confirms samplesInWindow's output shape plugs straight into
            // timeWeightedAverage and produces a sane result — mostly-flat at
            // 10M with a small late ramp to 10.5M should land strictly between
            // the two, and much closer to 10M (the ramp covers only the last
            // 2 of 25 hourly samples).
            const selected = samplesInWindow(0, 24 * 3600, CHAINS, tmpPath);
            const twa = timeWeightedAverage(selected);
            // Bounding within [10M, 10.5M] would be true by construction; the exact
            // answer is computable: 22h at 10M, 1h at 10.25M, 1h at 10.5M over 24h.
            const expectedTwa = (22 * 10_000_000 + 1 * 10_250_000 + 1 * 10_500_000) / 24;
            expect(twa, "time-weighted average is exactly the trapezoid").to.be.closeTo(expectedTwa, 1);
        });

        it("throws if fewer than 2 samples fall in the window", () => {
            expect(() => samplesInWindow(0, 1, CHAINS, tmpPath)).to.throw(/at least 2/);
        });

        it("throws (rather than silently averaging over a sparse window) when the store is empty", () => {
            const emptyPath = path.join(os.tmpdir(), `empty.${Date.now()}.json`);
            expect(() => samplesInWindow(0, 100, CHAINS, emptyPath)).to.throw(/at least 2/);
        });

        it("covers the window start by interpolating between the samples either side of it", () => {
            // Samples at 22h (10M) and 23h (10.5M); start at 22.5h -> 10.25M.
            const selected = samplesInWindow(22.5 * 3600, 24 * 3600, CHAINS, tmpPath);
            expect(selected[0]).to.deep.equal({ timestampSec: 22.5 * 3600, valueUsd: 10_250_000 });
            expect(selected.map((s) => s.timestampSec)).to.deep.equal([22.5 * 3600, 23 * 3600, 24 * 3600]);
        });

        it("rejects a window whose start precedes every sample", () => {
            expect(() => samplesInWindow(-3600, 3600, CHAINS, tmpPath)).to.throw(/start is not covered/);
        });

        it("rejects a gap larger than maxGapSec", () => {
            expect(() => samplesInWindow(0, 12 * 3600, CHAINS, tmpPath, { maxGapSec: 1800 })).to.throw(/gap/);
        });

        it("rejects samples whose chain set differs from the expected set (a missing chain lowers V̄)", () => {
            appendSample({ timestampSec: 25 * 3600, valueUsd: 5_000_000, perChain: { sepolia: 5_000_000 } }, tmpPath);
            expect(() => samplesInWindow(24 * 3600, 25 * 3600, CHAINS, tmpPath)).to.throw(/different chain set/);
            // The same samples are fine for a window that doesn't touch the partial one.
            expect(() => samplesInWindow(0, 24 * 3600, CHAINS, tmpPath)).to.not.throw();
        });

        it("rejects every sample when the expected set itself changed (e.g. SVM now expected)", () => {
            expect(() => samplesInWindow(0, 12 * 3600, [...CHAINS, "solana"], tmpPath)).to.throw(/different chain set/);
        });

        it("rejects a sample whose recorded chain set disagrees with its perChain keys", () => {
            appendSample({ timestampSec: 25 * 3600, valueUsd: 1, perChain: perChain(1), chains: ["sepolia"] }, tmpPath);
            expect(() => samplesInWindow(24 * 3600, 25 * 3600, CHAINS, tmpPath)).to.throw(/inconsistent/);
        });

        it("accepts legacy samples with no recorded chain set when perChain covers the expected set", () => {
            appendSample({ timestampSec: 25 * 3600, valueUsd: 1, perChain: perChain(1) }, tmpPath);
            expect(samplesInWindow(24 * 3600, 25 * 3600, CHAINS, tmpPath)).to.have.length(2);
        });
    });

    describe("valueAt", () => {
        const samples = [
            { timestampSec: 0, valueUsd: 10_000_000 },
            { timestampSec: 1000, valueUsd: 12_000_000 },
        ];

        it("returns the exact sample value at a sample's own timestamp", () => {
            expect(valueAt(samples, 0)).to.equal(10_000_000);
            expect(valueAt(samples, 1000)).to.equal(12_000_000);
        });

        it("linearly interpolates between two samples", () => {
            expect(valueAt(samples, 500)).to.equal(11_000_000);
        });

        it("clamps to the first sample before the series starts", () => {
            expect(valueAt(samples, -500)).to.equal(10_000_000);
        });

        it("clamps to the last sample after the series ends", () => {
            expect(valueAt(samples, 5000)).to.equal(12_000_000);
        });

        it("throws with no samples", () => {
            expect(() => valueAt([], 0)).to.throw(/no samples/);
        });
    });

    describe("cumulativeDistributedUsd", () => {
        it("composes samplesInWindow + distributedUsdOverWindow correctly", () => {
            const rate = 1.0000001;
            const segments: RateSegment[] = [
                { startSec: 0, endSec: 86400, ratePerSecond: rate, anchorMultiplier: 1.0 },
            ];
            // Flat supply of 10M — build samples consistent with that + the schedule.
            const S = 10_000_000;
            for (const t of [0, 43200, 86400]) {
                const m = 1.0 * Math.pow(rate, t);
                appendSample({ timestampSec: t, valueUsd: S * m, perChain: perChain(S * m) }, tmpPath);
            }

            const distributed = cumulativeDistributedUsd(segments, 0, 86400, CHAINS, tmpPath, { maxGapSec: 43200 });
            const expected = S * (Math.pow(rate, 86400) - 1);
            expect(distributed).to.be.closeTo(expected, 1e-3);
        });
    });

    describe("sampleGlobalValueUsd", () => {
        let envBackup: NodeJS.ProcessEnv;
        beforeEach(() => {
            envBackup = { ...process.env };
            for (const k of ["SVM_EXPECTED", "SVM_RPC_URL", "SVM_LITE_PSM_PROGRAM_ID", "SVM_OKU_M_MINT", "YES_MAINNET"]) {
                delete process.env[k];
            }
        });
        afterEach(() => {
            process.env = envBackup;
        });

        async function rejection(p: Promise<unknown>): Promise<Error> {
            try {
                await p;
            } catch (e: any) {
                return e;
            }
            throw new Error("expected the promise to reject, but it resolved");
        }

        it("throws (no partial sum) when an expected EVM chain has no address", async () => {
            // The committed address book has no OkuMoney for any chain (clean-slate).
            const err = await rejection(sampleGlobalValueUsd(["sepolia"]));
            expect(err.message).to.match(/INCOMPLETE/);
            expect(err.message).to.match(/sepolia/);
        });

        it("throws when SVM is expected but not configured, naming it", async () => {
            process.env.SVM_EXPECTED = "true";
            const err = await rejection(sampleGlobalValueUsd(["sepolia", "solana"]));
            expect(err.message).to.match(/solana: SVM_EXPECTED=true but SVM is not configured/);
        });
    });
});
