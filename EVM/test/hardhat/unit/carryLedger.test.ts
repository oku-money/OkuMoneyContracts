import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import {
    appendLedgerEntry,
    loadLedger,
    summarizeLedger,
    buildLedgerEntry,
    CarryLedgerEntry,
} from "../../../scripts/utils/carryLedger";
import { realisedYieldToRatePerSecond } from "../../../scripts/utils/yieldRate";

describe("scripts/utils/carryLedger", () => {
    let tmpPath: string;

    beforeEach(() => {
        tmpPath = path.join(os.tmpdir(), `carryLedger.${Date.now()}.${Math.random()}.json`);
    });

    afterEach(() => {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    });

    it("returns an empty/zeroed summary when the ledger doesn't exist yet", () => {
        const summary = summarizeLedger(tmpPath);
        expect(summary.epochCount).to.equal(0);
        expect(summary.cumulativeRealisedYieldUsd).to.equal(0);
        expect(summary.outstandingCarryUsd).to.equal(0);
        expect(summary.latestEntry).to.equal(null);
    });

    it("round-trips an entry through append + load", () => {
        const entry: CarryLedgerEntry = {
            epochId: "2025-01",
            timestampSec: 1000,
            realisedYieldUsd: 40_000,
            carryInUsd: 0,
            measuredAvgValueUsd: 10_000_000,
            conservativeFactor: 1,
            ratePerSecond: "1000000000158549",
            carryForwardUsd: 0.01,
        };
        appendLedgerEntry(entry, tmpPath);
        expect(loadLedger(tmpPath)).to.deep.equal([entry]);
    });

    it("buildLedgerEntry correctly stringifies the bigint rate for JSON storage", () => {
        const measuredAvgValueUsd = 10_000_000;
        const result = realisedYieldToRatePerSecond(40_000, measuredAvgValueUsd, 86400 * 30);
        const entry = buildLedgerEntry({
            epochId: "2025-01",
            realisedYieldUsd: 40_000,
            carryInUsd: 0,
            measuredAvgValueUsd,
            conservativeFactor: 1,
            result,
        });
        expect(entry.ratePerSecond).to.equal(result.ratePerSecond.toString());
        expect(typeof entry.ratePerSecond).to.equal("string");
    });

    it("cumulative conservation identity: cumulativeAchieved = cumulativeRealised - outstandingCarry, threaded across epochs with conservativeFactor withholding", () => {
        const measuredAvgValueUsd = 10_000_000;
        const windowSeconds = 86400 * 30;
        const conservativeFactor = 0.9;
        const realisedPerEpoch = 40_000;

        let carry = 0;
        for (let epoch = 1; epoch <= 5; epoch++) {
            const result = realisedYieldToRatePerSecond(
                realisedPerEpoch,
                measuredAvgValueUsd,
                windowSeconds,
                carry,
                conservativeFactor
            );
            const entry = buildLedgerEntry({
                epochId: `epoch-${epoch}`,
                realisedYieldUsd: realisedPerEpoch,
                carryInUsd: carry,
                measuredAvgValueUsd,
                conservativeFactor,
                result,
                timestampSec: epoch * windowSeconds,
            });
            appendLedgerEntry(entry, tmpPath);
            carry = result.carryForwardUsd;
        }

        const summary = summarizeLedger(tmpPath);
        expect(summary.epochCount).to.equal(5);
        expect(summary.cumulativeRealisedYieldUsd).to.be.closeTo(realisedPerEpoch * 5, 1e-6);
        // The identity itself, to high precision (not just "close"):
        expect(summary.cumulativeAchievedUsd).to.be.closeTo(
            summary.cumulativeRealisedYieldUsd - summary.outstandingCarryUsd,
            1e-9
        );
        // With conservativeFactor < 1, SOME carry must still be outstanding —
        // this isn't a degenerate all-zero test.
        expect(summary.outstandingCarryUsd).to.be.greaterThan(0);
    });
});
