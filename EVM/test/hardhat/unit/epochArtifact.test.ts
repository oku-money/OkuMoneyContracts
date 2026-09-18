import { expect } from "chai";
import fs from "fs";
import path from "path";
import {
    artifactKey,
    artifactPath,
    saveArtifact,
    loadArtifact,
    saveArtifactInPlace,
    EpochScheduleArtifact,
} from "../../../scripts/utils/epochArtifact";

function makeArtifact(overrides: Partial<EpochScheduleArtifact> = {}): EpochScheduleArtifact {
    return {
        artifactVersion: 1,
        epochId: "test-epoch-artifact-1",
        phase: "roll-epoch",
        derivedAtSec: 1000,
        referenceChain: "sepolia",
        schedule: { rate: "1000000000158549", rateEnd: 2000, nextRate: "1000000000200000", nextRateEnd: 3000 },
        meta: {
            realisedYieldUsd: 40_000,
            conservativeFactor: 1,
            carryInUsd: 0,
            carryForwardUsd: 0,
            globalValueUsd: 10_000_000,
        },
        receipts: {},
        ...overrides,
    };
}

describe("scripts/utils/epochArtifact", () => {
    // Every test uses a unique epochId so parallel/rerun test invocations
    // never collide on the same on-disk file, and cleans up afterward.
    const written: string[] = [];

    afterEach(() => {
        for (const p of written) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        written.length = 0;
    });

    it("artifactKey combines epochId and phase — the fix for the epochId-only collision", () => {
        expect(artifactKey("2026-01", "stage-settlement")).to.equal("2026-01-stage-settlement");
        expect(artifactKey("2026-01", "roll-epoch")).to.equal("2026-01-roll-epoch");
        // The two phases of ONE epoch must produce DIFFERENT keys.
        expect(artifactKey("2026-01", "stage-settlement")).to.not.equal(artifactKey("2026-01", "roll-epoch"));
    });

    it("REGRESSION (defect #2): both phases of the SAME epochId can be saved without collision", () => {
        const epochId = "test-epoch-artifact-nocollide";
        const stage = makeArtifact({ epochId, phase: "stage-settlement" });
        const roll = makeArtifact({ epochId, phase: "roll-epoch" });

        written.push(artifactPath(epochId, "stage-settlement"), artifactPath(epochId, "roll-epoch"));

        expect(() => saveArtifact(stage)).to.not.throw();
        expect(() => saveArtifact(roll)).to.not.throw(); // used to throw: "Artifact already exists"

        expect(loadArtifact(epochId, "stage-settlement").phase).to.equal("stage-settlement");
        expect(loadArtifact(epochId, "roll-epoch").phase).to.equal("roll-epoch");
    });

    it("saveArtifact refuses to overwrite an existing (epochId, phase) pair", () => {
        const artifact = makeArtifact({ epochId: "test-epoch-artifact-dup" });
        written.push(artifactPath(artifact.epochId, artifact.phase));
        saveArtifact(artifact);
        expect(() => saveArtifact(artifact)).to.throw(/already exists/);
    });

    it("loadArtifact throws a clear error for a missing artifact", () => {
        expect(() => loadArtifact("no-such-epoch", "roll-epoch")).to.throw(/No artifact/);
    });

    it("saveArtifactInPlace overwrites in place (used by broadcastSchedule.ts to record receipts)", () => {
        const artifact = makeArtifact({ epochId: "test-epoch-artifact-inplace" });
        written.push(artifactPath(artifact.epochId, artifact.phase));
        saveArtifact(artifact);

        const mutated = loadArtifact(artifact.epochId, artifact.phase);
        mutated.receipts["sepolia"] = { txHash: "0xabc", confirmedAtSec: 1234 };
        saveArtifactInPlace(mutated);

        const reloaded = loadArtifact(artifact.epochId, artifact.phase);
        expect(reloaded.receipts["sepolia"]).to.deep.equal({ txHash: "0xabc", confirmedAtSec: 1234 });
    });

    it("round-trips every field through save + load", () => {
        const artifact = makeArtifact({
            epochId: "test-epoch-artifact-roundtrip",
            meta: {
                realisedYieldUsd: 12_345,
                conservativeFactor: 0.9,
                carryInUsd: 111,
                carryForwardUsd: 0,
                globalValueUsd: 9_999_999,
                priorEpochId: "test-epoch-artifact-prior",
            },
        });
        written.push(artifactPath(artifact.epochId, artifact.phase));
        saveArtifact(artifact);
        expect(loadArtifact(artifact.epochId, artifact.phase)).to.deep.equal(artifact);
    });

    it("artifactPath is stable and deterministic for a given (epochId, phase)", () => {
        const p1 = artifactPath("2026-01", "roll-epoch");
        const p2 = artifactPath("2026-01", "roll-epoch");
        expect(p1).to.equal(p2);
        expect(path.basename(p1)).to.equal("2026-01-roll-epoch.json");
    });
});
