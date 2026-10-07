import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import {
    upsertLedgerEntry,
    loadLedger,
    summarizeLedger,
    buildLedgerEntry,
    backfillReconciliation,
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
        upsertLedgerEntry(entry, tmpPath);
        expect(loadLedger(tmpPath)).to.deep.equal([entry]);
    });

    it("buildLedgerEntry correctly stringifies the bigint rate for JSON storage", () => {
        const measuredAvgValueUsd = 10_000_000;
        const result = realisedYieldToRatePerSecond(40_000, measuredAvgValueUsd, 86400);
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
        const windowSeconds = 86400;
        const conservativeFactor = 0.9;
        const realisedPerEpoch = 40_000;

        let carry = 0;
        // Accumulate the expected total INDEPENDENTLY as the loop runs, so the
        // assertion below has something to compare against that is not simply a
        // restatement of `summarizeLedger`'s own arithmetic.
        let expectedAchieved = 0;
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
            upsertLedgerEntry(entry, tmpPath);
            // What this epoch actually paid out: what came in (realised + prior
            // carry) minus what is still owed forward.
            expectedAchieved += realisedPerEpoch + carry - result.carryForwardUsd;
            carry = result.carryForwardUsd;
        }

        const summary = summarizeLedger(tmpPath);
        expect(summary.epochCount).to.equal(5);
        expect(summary.cumulativeRealisedYieldUsd).to.be.closeTo(realisedPerEpoch * 5, 1e-6);
        // Checked against the independently accumulated total, NOT against
        // `cumulativeRealisedYieldUsd - outstandingCarryUsd` -- which is the
        // literal definition of `cumulativeAchievedUsd` and so could not fail.
        expect(summary.cumulativeAchievedUsd, "cumulative achieved matches the per-epoch sum")
            .to.be.closeTo(expectedAchieved, 1e-6);
        // With conservativeFactor < 1, SOME carry must still be outstanding —
        // this isn't a degenerate all-zero test.
        expect(summary.outstandingCarryUsd).to.be.greaterThan(0);
    });

    // ── upsertLedgerEntry / backfillReconciliation ──────────────────────────
    // Exercises the exact call pattern `broadcastSchedule.ts` uses: insert a
    // roll-epoch entry, then backfill the PRIOR entry's reconciliation once
    // the NEXT roll computes it.

    function baseEntry(overrides: Partial<CarryLedgerEntry>): CarryLedgerEntry {
        return {
            epochId: "epoch-1",
            timestampSec: 1000,
            realisedYieldUsd: 40_000,
            carryInUsd: 0,
            measuredAvgValueUsd: 10_000_000,
            conservativeFactor: 1,
            ratePerSecond: "1000000000158549",
            carryForwardUsd: 0,
            ...overrides,
        };
    }

    it("upsertLedgerEntry inserts a new entry and is idempotent on an identical re-run", () => {
        const entry = baseEntry({});
        upsertLedgerEntry(entry, tmpPath);
        upsertLedgerEntry(entry, tmpPath); // identical re-run (e.g. after a partial broadcast retry)
        expect(loadLedger(tmpPath)).to.deep.equal([entry]);
    });

    it("upsertLedgerEntry refuses to silently replace a DIFFERENT derivation for the same epochId", () => {
        upsertLedgerEntry(baseEntry({}), tmpPath);
        expect(() =>
            upsertLedgerEntry(baseEntry({ realisedYieldUsd: 99_999 }), tmpPath)
        ).to.throw(/DIFFERENT/);
    });

    it("upsertLedgerEntry preserves a prior backfilled reconciliation across an idempotent re-run", () => {
        const entry = baseEntry({});
        upsertLedgerEntry(entry, tmpPath);
        backfillReconciliation("epoch-1", 123.45, tmpPath);
        upsertLedgerEntry(entry, tmpPath); // same derivation, re-run
        const [reloaded] = loadLedger(tmpPath);
        expect(reloaded.reconciledCarryUsd).to.equal(123.45);
    });

    it("backfillReconciliation sets reconciledCarryUsd on the correct (prior) entry only", () => {
        upsertLedgerEntry(baseEntry({ epochId: "epoch-1" }), tmpPath);
        upsertLedgerEntry(baseEntry({ epochId: "epoch-2", timestampSec: 2000 }), tmpPath);
        backfillReconciliation("epoch-1", 50, tmpPath);
        const ledger = loadLedger(tmpPath);
        expect(ledger.find((e) => e.epochId === "epoch-1")!.reconciledCarryUsd).to.equal(50);
        expect(ledger.find((e) => e.epochId === "epoch-2")!.reconciledCarryUsd).to.be.undefined;
    });

    it("backfillReconciliation throws for an unknown epochId", () => {
        upsertLedgerEntry(baseEntry({}), tmpPath);
        expect(() => backfillReconciliation("no-such-epoch", 1, tmpPath)).to.throw(/no ledger entry/);
    });

    it("backfillReconciliation refuses to silently overwrite a DIFFERENT already-recorded value", () => {
        upsertLedgerEntry(baseEntry({}), tmpPath);
        backfillReconciliation("epoch-1", 10, tmpPath);
        expect(() => backfillReconciliation("epoch-1", 20, tmpPath)).to.throw(/DIFFERENT/);
        // Same value again is fine (idempotent).
        expect(() => backfillReconciliation("epoch-1", 10, tmpPath)).to.not.throw();
    });

    it("summarizeLedger: outstandingCarryUsd prefers reconciledCarryUsd once backfilled, and pendingReconciliation reflects whether it has been", () => {
        upsertLedgerEntry(baseEntry({ carryForwardUsd: 0, carryInUsd: 5 }), tmpPath);

        let summary = summarizeLedger(tmpPath);
        expect(summary.pendingReconciliation).to.equal(true);
        expect(summary.outstandingCarryUsd).to.equal(0); // falls back to carryForwardUsd pre-reconciliation
        expect(summary.currentEpochCarryInUsd).to.equal(5);

        backfillReconciliation("epoch-1", 77, tmpPath);
        summary = summarizeLedger(tmpPath);
        expect(summary.pendingReconciliation).to.equal(false);
        expect(summary.outstandingCarryUsd).to.equal(77);
        // currentEpochCarryInUsd is unaffected by reconciling the SAME entry —
        // it reflects what was baked into ITS OWN target, not the reconciliation.
        expect(summary.currentEpochCarryInUsd).to.equal(5);
    });

    it("reconciledCarryUsd threaded as next epoch's carryInUsd does not equal carryForwardUsd — they answer different questions", () => {
        // Simulates exactly what `broadcastSchedule.ts` does for a
        // roll-epoch artifact: insert epoch N's entry with carryForwardUsd=0
        // (deriveBaseRate has no clamping yet), then — once epoch N+1 derives
        // and reconciles epoch N's actual-vs-target — backfill epoch N's
        // reconciledCarryUsd, and that reconciled figure (NOT epoch N's own
        // carryForwardUsd) becomes epoch N+1's carryInUsd.
        upsertLedgerEntry(baseEntry({ epochId: "epoch-1", carryForwardUsd: 0 }), tmpPath);

        const reconciledForEpoch1 = 250; // e.g. epoch 1 under-delivered by $250
        backfillReconciliation("epoch-1", reconciledForEpoch1, tmpPath);

        const epoch1 = loadLedger(tmpPath)[0];
        expect(epoch1.carryForwardUsd).to.equal(0); // unchanged — a different field
        expect(epoch1.reconciledCarryUsd).to.equal(reconciledForEpoch1);

        // Epoch 2's carryInUsd should equal epoch 1's RECONCILED carry, per
        // deriveRollEpoch.ts — not the (always-0) carryForwardUsd.
        upsertLedgerEntry(
            baseEntry({ epochId: "epoch-2", carryInUsd: reconciledForEpoch1, carryForwardUsd: 0 }),
            tmpPath
        );
        const summary = summarizeLedger(tmpPath);
        expect(summary.currentEpochCarryInUsd).to.equal(reconciledForEpoch1);
    });
});
