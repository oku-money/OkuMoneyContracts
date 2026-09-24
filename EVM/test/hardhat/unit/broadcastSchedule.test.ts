/**
 * Executes the REAL `broadcastArtifact()` with the subprocess launcher
 * stubbed, so the env/argv contract between this driver and the processes it
 * spawns is actually asserted rather than assumed.
 *
 * This file exists because that contract was broken and nothing caught it:
 * the driver set `EPOCH_PHASE`, while `applyScheduleSingleChain.ts`'s
 * `parseArg("phase")` reads `PHASE` — a name produced by a camelCase→
 * SCREAMING_SNAKE transform inside `cli.ts` that appears literally nowhere at
 * either end. Every EVM chain's subprocess would have aborted immediately.
 * Reading both files could not reveal it; only running the thing could.
 *
 * The prior test for this area asserted a hand-reimplementation of the
 * driver's ledger sequence inside the operator drill — it verified the test
 * author's understanding, not the code, which is exactly how the bug
 * survived a "tested" pass.
 */

import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { broadcastArtifact, SubprocessRunner } from "../../../scripts/operator/broadcastSchedule";
import { saveArtifact, artifactPath, EpochScheduleArtifact } from "../../../scripts/utils/epochArtifact";
import { loadLedger, upsertLedgerEntry, buildLedgerEntry } from "../../../scripts/utils/carryLedger";
import { DEFAULT_EPOCH_CHAINS, SVM_CHAIN_KEY } from "../../../scripts/config/epochChains";

interface RecordedCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function makeArtifact(overrides: Partial<EpochScheduleArtifact> = {}): EpochScheduleArtifact {
  return {
    artifactVersion: 1,
    epochId: "bcast-test",
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

describe("scripts/operator/broadcastSchedule", () => {
    let calls: RecordedCall[];
    let recorder: SubprocessRunner;
    const STUB_SVM_SIGNATURE =
        "5SRzBouhVBeyR5BqDdcVX6YRdbwe8PKLghwwuT3cnc2zDtiYYy6PoqaK6ANMaKe4gz73J54yCpoeVStTeAsuTqm4";
    let ledgerPath: string;
    const written: string[] = [];

    beforeEach(() => {
        calls = [];
        recorder = (command, args, opts) => {
            calls.push({ command, args, cwd: opts.cwd, env: opts.env });
            // The SVM branch parses a real signature out of stdout and refuses
            // to record a receipt without one, so the stub must emit one.
            return `  tx: ${STUB_SVM_SIGNATURE}`;
        };
        ledgerPath = path.join(os.tmpdir(), `bcastLedger.${Date.now()}.${Math.random()}.json`);
    });

    afterEach(() => {
        for (const p of written) if (fs.existsSync(p)) fs.unlinkSync(p);
        written.length = 0;
        if (fs.existsSync(ledgerPath)) fs.unlinkSync(ledgerPath);
    });

    function save(a: EpochScheduleArtifact): EpochScheduleArtifact {
        written.push(artifactPath(a.epochId, a.phase));
        saveArtifact(a);
        return a;
    }

    const evmCalls = () => calls.filter((c) => c.args.some((a) => a.includes("applyScheduleSingleChain.ts")));
    const svmCalls = () => calls.filter((c) => c.args.some((a) => a.includes("set-yield-rate.ts")));

    /** Explicit rejection capture — `chai-as-promised` is not a dependency
     *  of this package, and asserting on a promise that silently resolves
     *  would make these negative tests vacuously pass. */
    async function rejection(p: Promise<unknown>): Promise<Error> {
        try {
            await p;
        } catch (e: any) {
            return e;
        }
        throw new Error("expected the promise to reject, but it resolved");
    }

    it("REGRESSION: passes PHASE (the name parseArg('phase') actually reads) to every EVM subprocess — NOT EPOCH_PHASE", async () => {
        const a = save(makeArtifact({ epochId: "bcast-phase-env" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ledgerPath });

        expect(evmCalls().length).to.be.greaterThan(0);
        for (const call of evmCalls()) {
            expect(call.env.PHASE, "PHASE must be set — parseArg('phase') reads exactly this").to.equal("roll-epoch");
            expect(call.env.EPOCH_ID).to.equal("bcast-phase-env");
        }
    });

    it("targets exactly the participating chain set — one EVM subprocess per EVM chain, one SVM subprocess", async () => {
        const a = save(makeArtifact({ epochId: "bcast-targets" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ledgerPath });

        const expectedEvm = DEFAULT_EPOCH_CHAINS.filter((c) => c !== SVM_CHAIN_KEY);
        const networksHit = evmCalls().map((c) => c.args[c.args.indexOf("--network") + 1]);
        expect(networksHit).to.have.members([...expectedEvm]);
        expect(svmCalls().length).to.equal(1);
    });

    it("REGRESSION (defect #4): refuses to broadcast to a mainnet chain without yesMainnet", async () => {
        const a = save(makeArtifact({ epochId: "bcast-mainnet-guard" }));
        const err = await rejection(
            broadcastArtifact({
                epochId: a.epochId,
                phase: a.phase,
                dryRun: true,
                chains: ["base"],
                yesMainnet: false,
                run: recorder,
                ledgerPath,
            })
        );
        expect(err.message).to.match(/mainnet/i);
        expect(calls.length).to.equal(0); // nothing was spawned
    });

    it("passes the artifact's WAD integers to the SVM leg as argv flags (its parser is argv-only)", async () => {
        const a = save(makeArtifact({ epochId: "bcast-svm-flags" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ledgerPath });

        const svm = svmCalls()[0];
        expect(svm.args).to.include("--mode=atomic");
        expect(svm.args).to.include(`--rate=${a.schedule.rate}`);
        expect(svm.args).to.include(`--end=${a.schedule.rateEnd}`);
        expect(svm.args).to.include(`--next-rate=${a.schedule.nextRate}`);
        expect(svm.args).to.include(`--next-end=${a.schedule.nextRateEnd}`);
    });

    it("propagates DRY_RUN to every subprocess and does NOT write the carry ledger", async () => {
        const a = save(makeArtifact({ epochId: "bcast-dryrun" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ledgerPath });

        for (const call of calls) expect(call.env.DRY_RUN).to.equal("true");
        expect(loadLedger(ledgerPath)).to.deep.equal([]);
    });

    it("writes exactly ONE carry-ledger entry for a roll-epoch broadcast, not one per chain", async () => {
        const a = save(makeArtifact({ epochId: "bcast-ledger-once" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: recorder, ledgerPath });

        const ledger = loadLedger(ledgerPath);
        expect(ledger.length).to.equal(1);
        expect(ledger[0].epochId).to.equal("bcast-ledger-once");
        expect(ledger[0].carryForwardUsd).to.equal(0);
        expect(ledger[0].reconciledCarryUsd, "pending until the NEXT roll reconciles it").to.be.undefined;
    });

    it("does NOT write a carry-ledger entry for a stage-settlement broadcast (it closes no epoch)", async () => {
        const a = save(makeArtifact({ epochId: "bcast-stage", phase: "stage-settlement" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: recorder, ledgerPath });
        expect(loadLedger(ledgerPath)).to.deep.equal([]);
    });

    it("backfills the PRIOR epoch's reconciliation before inserting the new entry", async () => {
        // Seed a prior epoch, as a previous roll would have left it: pending.
        upsertLedgerEntry(
            buildLedgerEntry({
                epochId: "prior-epoch",
                realisedYieldUsd: 1000,
                carryInUsd: 0,
                measuredAvgValueUsd: 1_000_000,
                conservativeFactor: 1,
                result: { ratePerSecond: 1000000000158549n, carryForwardUsd: 0 },
            }),
            ledgerPath
        );

        const a = save(
            makeArtifact({
                epochId: "bcast-backfill",
                meta: {
                    realisedYieldUsd: 2000,
                    conservativeFactor: 1,
                    carryInUsd: 137.5, // the reconciliation deriveRollEpoch computed for prior-epoch
                    carryForwardUsd: 0,
                    globalValueUsd: 1_000_000,
                    priorEpochId: "prior-epoch",
                },
            })
        );
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: recorder, ledgerPath });

        const ledger = loadLedger(ledgerPath);
        const prior = ledger.find((e) => e.epochId === "prior-epoch")!;
        const current = ledger.find((e) => e.epochId === "bcast-backfill")!;
        // The reconciliation lands on the PRIOR entry...
        expect(prior.reconciledCarryUsd).to.equal(137.5);
        expect(prior.carryForwardUsd).to.equal(0); // untouched — a different field
        // ...and is the NEW entry's carry-IN, not its carry-forward.
        expect(current.carryInUsd).to.equal(137.5);
        expect(current.carryForwardUsd).to.equal(0);
        expect(current.reconciledCarryUsd).to.be.undefined;
    });

    it("is resumable: skips chains that already have a confirmed receipt", async () => {
        const a = save(
            makeArtifact({
                epochId: "bcast-resume",
                receipts: { sepolia: { txHash: "0xalready", confirmedAtSec: 1 } },
            })
        );
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ledgerPath });

        const networksHit = evmCalls().map((c) => c.args[c.args.indexOf("--network") + 1]);
        expect(networksHit).to.not.include("sepolia");
        expect(networksHit.length).to.be.greaterThan(0); // the others still ran
    });

    it("reports which chains failed and does not write the ledger on partial failure", async () => {
        const a = save(makeArtifact({ epochId: "bcast-partial-fail" }));
        const failing: SubprocessRunner = (command, args, opts) => {
            const network = args[args.indexOf("--network") + 1];
            if (network === "arbSepolia") throw new Error("simulated RPC timeout");
            return recorder(command, args, opts);
        };

        const err = await rejection(
            broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: failing, ledgerPath })
        );
        expect(err.message).to.match(/arbSepolia/);
        expect(loadLedger(ledgerPath)).to.deep.equal([]);
    });
});
