import { expect } from "chai";
import fs from "fs";
import path from "path";
import {
    artifactKey,
    artifactPath,
    saveArtifact,
    loadArtifact,
    saveArtifactInPlace,
    assertArtifactBound,
    assertNotExpired,
    scheduleMatchesTarget,
    preStateMismatches,
    artifactTtlSeconds,
    DEFAULT_ARTIFACT_TTL_SECONDS,
    EpochScheduleArtifact,
} from "../../../scripts/utils/epochArtifact";

const PRE_STATE = {
    rate: "1000000000100000000",
    rateEnd: 2000,
    pendingRate: "1000000000000000000",
    pendingRateEnd: 0,
    baseMultiplier: "1010000000000000000",
    lastAccrualTime: 900,
};

function makeArtifact(overrides: Partial<EpochScheduleArtifact> = {}): EpochScheduleArtifact {
    return {
        artifactVersion: 2,
        epochId: "test-epoch-artifact-1",
        phase: "roll-epoch",
        derivedAtSec: 1000,
        expiresAtSec: 1000 + DEFAULT_ARTIFACT_TTL_SECONDS,
        referenceChain: "sepolia",
        targetChains: ["sepolia", "solana"],
        targets: {
            sepolia: { kind: "evm", chainId: 11155111, okuMoney: "0x0000000000000000000000000000000000000001" },
            solana: { kind: "svm", cluster: "devnet" },
        },
        expectedPreState: PRE_STATE,
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

    it("artifactKey combines epochId and phase so the two phases never collide", () => {
        expect(artifactKey("2026-01", "stage-settlement")).to.equal("2026-01-stage-settlement");
        expect(artifactKey("2026-01", "roll-epoch")).to.equal("2026-01-roll-epoch");
        // The two phases of ONE epoch must produce DIFFERENT keys.
        expect(artifactKey("2026-01", "stage-settlement")).to.not.equal(artifactKey("2026-01", "roll-epoch"));
    });

    it("both phases of the SAME epochId can be saved without collision", () => {
        const epochId = "test-epoch-artifact-nocollide";
        const stage = makeArtifact({ epochId, phase: "stage-settlement" });
        const roll = makeArtifact({ epochId, phase: "roll-epoch" });

        written.push(artifactPath(epochId, "stage-settlement"), artifactPath(epochId, "roll-epoch"));

        expect(() => saveArtifact(stage)).to.not.throw();
        expect(() => saveArtifact(roll)).to.not.throw(); // distinct phase => distinct key, no "already exists"

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

    describe("chain binding (P-02/P-03/P-06 helpers)", () => {
        it("assertArtifactBound refuses a version-1 / unbound artifact with a re-derive hint", () => {
            const legacy = { ...makeArtifact(), artifactVersion: 1 } as any;
            delete legacy.targetChains;
            expect(() => assertArtifactBound(legacy)).to.throw(/Re-derive/);
            const noIdentity = makeArtifact({ targets: { sepolia: makeArtifact().targets.sepolia } });
            expect(() => assertArtifactBound(noIdentity)).to.throw(/no identity recorded for target solana/);
            expect(() => assertArtifactBound(makeArtifact())).to.not.throw();
        });

        it("assertNotExpired passes up to expiresAtSec and refuses after", () => {
            const a = makeArtifact({ expiresAtSec: 5000 });
            expect(() => assertNotExpired(a, 5000)).to.not.throw();
            expect(() => assertNotExpired(a, 5001)).to.throw(/EXPIRED/);
        });

        it("artifactTtlSeconds defaults to 24h and honours ARTIFACT_TTL_SECONDS", () => {
            expect(artifactTtlSeconds({})).to.equal(24 * 3600);
            expect(artifactTtlSeconds({ ARTIFACT_TTL_SECONDS: "600" })).to.equal(600);
            expect(() => artifactTtlSeconds({ ARTIFACT_TTL_SECONDS: "-1" })).to.throw(/positive integer/);
        });

        it("scheduleMatchesTarget compares rate/rateEnd/pending/pendingEnd against the artifact's target", () => {
            const a = makeArtifact();
            const atTarget = { rate: a.schedule.rate, rateEnd: a.schedule.rateEnd, pendingRate: a.schedule.nextRate, pendingRateEnd: a.schedule.nextRateEnd };
            expect(scheduleMatchesTarget(atTarget, a)).to.equal(true);
            expect(scheduleMatchesTarget({ ...atTarget, pendingRateEnd: 1 }, a)).to.equal(false);
            expect(scheduleMatchesTarget(PRE_STATE, a)).to.equal(false);
        });

        it("preStateMismatches compares anchor fields only when asked (reference chain)", () => {
            const a = makeArtifact();
            const otherChainAnchors = { ...PRE_STATE, baseMultiplier: "1010000000000000001", lastAccrualTime: 901 };
            expect(preStateMismatches(otherChainAnchors, a, false)).to.deep.equal([]);
            expect(preStateMismatches(otherChainAnchors, a, true)).to.have.length(2);
            expect(preStateMismatches({ ...PRE_STATE, rate: "1" }, a, false)[0]).to.match(/^rate:/);
        });

        it("saveArtifactInPlace leaves no tmp file behind (atomic write)", () => {
            const artifact = makeArtifact({ epochId: "test-epoch-artifact-atomic" });
            const p = artifactPath(artifact.epochId, artifact.phase);
            written.push(p);
            saveArtifact(artifact);
            saveArtifactInPlace(artifact);
            const leftovers = fs.readdirSync(path.dirname(p)).filter((f) => f.startsWith(path.basename(p) + ".tmp"));
            expect(leftovers).to.deep.equal([]);
        });
    });
});
