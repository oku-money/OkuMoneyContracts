/**
 * Executes the REAL `broadcastArtifact()` with the subprocess launcher
 * stubbed, so the env/argv contract between this driver and the processes it
 * spawns is actually asserted rather than assumed.
 *
 * The driver must set `PHASE` (what `applyScheduleSingleChain.ts`'s
 * `parseArg("phase")` reads via the camelCase→SCREAMING_SNAKE transform in
 * `cli.ts`), not `EPOCH_PHASE`; only running the real driver catches a
 * mismatch between the two.
 */

import { expect } from "chai";
import fs from "fs";
import os from "os";
import path from "path";
import { broadcastArtifact, SubprocessRunner } from "../../../scripts/operator/broadcastSchedule";
import {
    saveArtifact,
    loadArtifact,
    saveArtifactInPlace,
    artifactPath,
    EpochScheduleArtifact,
    ArtifactTarget,
    ALREADY_APPLIED,
} from "../../../scripts/utils/epochArtifact";
import { loadLedger, upsertLedgerEntry, buildLedgerEntry } from "../../../scripts/utils/carryLedger";
import { DEFAULT_EPOCH_CHAINS, SVM_CHAIN_KEY, canonicalChainSet } from "../../../scripts/config/epochChains";
import { CHAIN_METADATA } from "../../../scripts/config/chains";

interface RecordedCall {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

const NOW = 10_000;
const PRE_STATE = {
  rate: "1000000000100000000",
  rateEnd: 1500,
  pendingRate: "1000000000300000000",
  pendingRateEnd: 1800,
  baseMultiplier: "1010000000000000000",
  lastAccrualTime: 900,
};
const fakeAddr = (chain: string) => "0x" + Buffer.from(chain).toString("hex").padEnd(40, "0").slice(0, 40);

function bindingFor(chains: readonly string[]): Pick<EpochScheduleArtifact, "targetChains" | "targets"> {
  const targets: Record<string, ArtifactTarget> = {};
  for (const c of chains) {
    targets[c] =
      c === SVM_CHAIN_KEY
        ? { kind: "svm", cluster: "devnet" }
        : { kind: "evm", chainId: CHAIN_METADATA[c].chainId, okuMoney: fakeAddr(c) };
  }
  return { targetChains: canonicalChainSet(chains), targets };
}

/** A receipt as the per-chain child records it (identity-bound). */
function evmReceipt(chain: string, txHash = "0xabc") {
  return { txHash, confirmedAtSec: 1, chainId: CHAIN_METADATA[chain].chainId, address: fakeAddr(chain) };
}

function makeArtifact(overrides: Partial<EpochScheduleArtifact> = {}): EpochScheduleArtifact {
  return {
    artifactVersion: 2,
    epochId: "bcast-test",
    phase: "roll-epoch",
    derivedAtSec: 1000,
    expiresAtSec: NOW + 3600,
    referenceChain: "sepolia",
    ...bindingFor(DEFAULT_EPOCH_CHAINS),
    expectedPreState: PRE_STATE,
    schedule: { rate: "1000000000158549", rateEnd: 2000, nextRate: "1000000000200000", nextRateEnd: 3000 },
    meta: {
      realisedYieldUsd: 40_000,
      conservativeFactor: 1,
      carryInUsd: 0,
      carryForwardUsd: 0,
      globalValueUsd: 10_000_000,
      epochStartMultiplier: "1020000000000000000",
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
    let envBackup: NodeJS.ProcessEnv;
    /** Common seams: no live SVM read, fixed clock. */
    const seams = () => ({ ledgerPath, readSvm: async () => null, nowSec: NOW });

    beforeEach(() => {
        envBackup = { ...process.env };
        delete process.env.SVM_NETWORK;
        delete process.env.SVM_LITE_PSM_PROGRAM_ID;
        calls = [];
        recorder = (command, args, opts) => {
            calls.push({ command, args, cwd: opts.cwd, env: opts.env });
            // Simulate what the real EVM child does on a non-dry run: write its
            // identity-bound receipt back into the artifact.
            const netIdx = args.indexOf("--network");
            if (netIdx !== -1 && opts.env.DRY_RUN !== "true") {
                const chain = args[netIdx + 1];
                const a = loadArtifact(opts.env.EPOCH_ID!, opts.env.PHASE as any);
                a.receipts[chain] = evmReceipt(chain);
                saveArtifactInPlace(a);
            }
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
        process.env = envBackup;
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

    it("passes PHASE (the name parseArg('phase') actually reads) to every EVM subprocess — NOT EPOCH_PHASE", async () => {
        const a = save(makeArtifact({ epochId: "bcast-phase-env" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ...seams() });

        expect(evmCalls().length).to.be.greaterThan(0);
        for (const call of evmCalls()) {
            expect(call.env.PHASE, "PHASE must be set — parseArg('phase') reads exactly this").to.equal("roll-epoch");
            expect(call.env.EPOCH_ID).to.equal("bcast-phase-env");
        }
    });

    it("targets exactly the committed (default participating) set — one EVM subprocess per EVM chain, one SVM subprocess", async () => {
        const a = save(makeArtifact({ epochId: "bcast-targets" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ...seams() });

        const expectedEvm = DEFAULT_EPOCH_CHAINS.filter((c) => c !== SVM_CHAIN_KEY);
        const networksHit = evmCalls().map((c) => c.args[c.args.indexOf("--network") + 1]);
        expect(networksHit).to.have.members([...expectedEvm]);
        expect(svmCalls().length).to.equal(1);
    });

    it("refuses to broadcast to a mainnet chain without yesMainnet", async () => {
        const a = save(makeArtifact({ epochId: "bcast-mainnet-guard" }));
        const err = await rejection(
            broadcastArtifact({
                epochId: a.epochId,
                phase: a.phase,
                dryRun: true,
                chains: ["base"],
                yesMainnet: false,
                run: recorder,
                ...seams(),
            })
        );
        expect(err.message).to.match(/mainnet/i);
        expect(calls.length).to.equal(0); // nothing was spawned
    });

    it("passes the artifact's WAD integers to the SVM leg as argv flags (its parser is argv-only)", async () => {
        const a = save(makeArtifact({ epochId: "bcast-svm-flags" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ...seams() });

        const svm = svmCalls()[0];
        expect(svm.args).to.include("--mode=atomic");
        expect(svm.args).to.include(`--rate=${a.schedule.rate}`);
        expect(svm.args).to.include(`--end=${a.schedule.rateEnd}`);
        expect(svm.args).to.include(`--next-rate=${a.schedule.nextRate}`);
        expect(svm.args).to.include(`--next-end=${a.schedule.nextRateEnd}`);
    });

    it("propagates DRY_RUN to every subprocess and does NOT write the carry ledger", async () => {
        const a = save(makeArtifact({ epochId: "bcast-dryrun" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ...seams() });

        for (const call of calls) expect(call.env.DRY_RUN).to.equal("true");
        expect(loadLedger(ledgerPath)).to.deep.equal([]);
    });

    it("writes exactly ONE carry-ledger entry for a roll-epoch broadcast, not one per chain", async () => {
        const a = save(makeArtifact({ epochId: "bcast-ledger-once" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: recorder, ...seams() });

        const ledger = loadLedger(ledgerPath);
        expect(ledger.length).to.equal(1);
        expect(ledger[0].epochId).to.equal("bcast-ledger-once");
        expect(ledger[0].carryForwardUsd).to.equal(0);
        expect(ledger[0].reconciledCarryUsd, "pending until the NEXT roll reconciles it").to.be.undefined;
        expect(ledger[0].epochStartMultiplier, "the epoch's start multiplier is carried onto the ledger entry")
            .to.equal("1020000000000000000");
    });

    it("does NOT write a carry-ledger entry for a stage-settlement broadcast (it closes no epoch)", async () => {
        const a = save(makeArtifact({ epochId: "bcast-stage", phase: "stage-settlement" }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: recorder, ...seams() });
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
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: recorder, ...seams() });

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
                receipts: { sepolia: evmReceipt("sepolia", "0xalready") },
            })
        );
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ...seams() });

        const networksHit = evmCalls().map((c) => c.args[c.args.indexOf("--network") + 1]);
        expect(networksHit).to.not.include("sepolia");
        expect(networksHit.length).to.be.greaterThan(0); // the others still ran
    });

    it("does NOT honour a receipt recorded for a different identity — the chain is re-dispatched", async () => {
        const a = save(
            makeArtifact({
                epochId: "bcast-foreign-receipt",
                receipts: { sepolia: { ...evmReceipt("sepolia"), chainId: 1 } },
            })
        );
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ...seams() });
        const networksHit = evmCalls().map((c) => c.args[c.args.indexOf("--network") + 1]);
        expect(networksHit).to.include("sepolia");
    });

    it("reports which chains failed and does not write the ledger on partial failure", async () => {
        const a = save(makeArtifact({ epochId: "bcast-partial-fail" }));
        const failing: SubprocessRunner = (command, args, opts) => {
            const network = args[args.indexOf("--network") + 1];
            if (network === "arbSepolia") throw new Error("simulated RPC timeout");
            return recorder(command, args, opts);
        };

        const err = await rejection(
            broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: failing, ...seams() })
        );
        expect(err.message).to.match(/arbSepolia/);
        expect(loadLedger(ledgerPath)).to.deep.equal([]);
    });

    // ---------------------------------------------- committed target set (P-02)

    it("uses the artifact's committed target set, not the current default", async () => {
        const a = save(makeArtifact({ epochId: "bcast-committed", ...bindingFor(["sepolia", SVM_CHAIN_KEY]) }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ...seams() });
        expect(evmCalls().map((c) => c.args[c.args.indexOf("--network") + 1])).to.deep.equal(["sepolia"]);
        expect(svmCalls().length).to.equal(1);
    });

    it("refuses a CHAINS scope that differs from the committed set, spawning nothing", async () => {
        const a = save(makeArtifact({ epochId: "bcast-chains-differ" }));
        const err = await rejection(
            broadcastArtifact({
                epochId: a.epochId,
                phase: a.phase,
                dryRun: true,
                chains: ["sepolia", "baseSepolia", "bscTestnet", SVM_CHAIN_KEY], // arbSepolia omitted
                run: recorder,
                ...seams(),
            })
        );
        expect(err.message).to.match(/differs from the artifact's committed target set/);
        expect(calls.length).to.equal(0);
    });

    it("accepts a CHAINS scope naming the committed set in a different order", async () => {
        const a = save(makeArtifact({ epochId: "bcast-chains-same" }));
        await broadcastArtifact({
            epochId: a.epochId,
            phase: a.phase,
            dryRun: true,
            chains: [...DEFAULT_EPOCH_CHAINS].reverse(),
            run: recorder,
            ...seams(),
        });
        expect(evmCalls().length).to.equal(DEFAULT_EPOCH_CHAINS.length - 1);
    });

    it("a re-run cannot omit the failed chain to finalize the epoch", async () => {
        const a = save(makeArtifact({ epochId: "bcast-omit-failed" }));
        const failing: SubprocessRunner = (command, args, opts) => {
            if (args[args.indexOf("--network") + 1] === "arbSepolia") throw new Error("simulated RPC timeout");
            return recorder(command, args, opts);
        };
        await rejection(broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: failing, ...seams() }));
        const err = await rejection(
            broadcastArtifact({
                epochId: a.epochId,
                phase: a.phase,
                dryRun: false,
                chains: ["sepolia", "baseSepolia", "bscTestnet", SVM_CHAIN_KEY],
                run: recorder,
                ...seams(),
            })
        );
        expect(err.message).to.match(/committed target set/);
        expect(loadLedger(ledgerPath)).to.deep.equal([]);
        // Re-running against the committed set retries ONLY arbSepolia, then finalizes.
        calls = [];
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: recorder, ...seams() });
        expect(evmCalls().map((c) => c.args[c.args.indexOf("--network") + 1])).to.deep.equal(["arbSepolia"]);
        expect(loadLedger(ledgerPath).length).to.equal(1);
    });

    it("does not finalize when a child exits 0 without recording a receipt", async () => {
        const a = save(makeArtifact({ epochId: "bcast-no-receipt" }));
        const silent: SubprocessRunner = (command, args, opts) => {
            calls.push({ command, args, cwd: opts.cwd, env: opts.env });
            return `  tx: ${STUB_SVM_SIGNATURE}`; // writes no EVM receipt
        };
        const err = await rejection(
            broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: silent, ...seams() })
        );
        expect(err.message).to.match(/no receipt for committed target/);
        expect(loadLedger(ledgerPath)).to.deep.equal([]);
    });

    it("refuses an unbound (version-1) artifact", async () => {
        const legacy = { ...makeArtifact({ epochId: "bcast-v1" }), artifactVersion: 1 } as any;
        delete legacy.targetChains;
        save(legacy);
        const err = await rejection(
            broadcastArtifact({ epochId: "bcast-v1", phase: "roll-epoch", dryRun: true, run: recorder, ...seams() })
        );
        expect(err.message).to.match(/Re-derive/);
        expect(calls.length).to.equal(0);
    });

    // ------------------------------------------------ expiry / SVM leg (P-03/P-06)

    it("refuses an expired artifact before spawning anything", async () => {
        const a = save(makeArtifact({ epochId: "bcast-expired", expiresAtSec: NOW - 1 }));
        const err = await rejection(
            broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ...seams() })
        );
        expect(err.message).to.match(/EXPIRED/);
        expect(calls.length).to.equal(0);
    });

    it("still finalizes an expired artifact whose targets ALL already confirmed (nothing to submit)", async () => {
        const receipts: EpochScheduleArtifact["receipts"] = {};
        for (const c of DEFAULT_EPOCH_CHAINS) {
            receipts[c] = c === SVM_CHAIN_KEY ? { txHash: STUB_SVM_SIGNATURE, confirmedAtSec: 1, cluster: "devnet" } : evmReceipt(c);
        }
        const a = save(makeArtifact({ epochId: "bcast-expired-done", expiresAtSec: NOW - 1, receipts }));
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: recorder, ...seams() });
        expect(calls.length).to.equal(0);
        expect(loadLedger(ledgerPath).length).to.equal(1);
    });

    it("SVM: records a recovered receipt and does NOT resend when SVM already carries the target", async () => {
        const a = save(makeArtifact({ epochId: "bcast-svm-recovered" }));
        const atTarget = async () => ({
            rate: a.schedule.rate,
            rateEnd: a.schedule.rateEnd,
            pendingRate: a.schedule.nextRate,
            pendingRateEnd: a.schedule.nextRateEnd,
        });
        await broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: recorder, ...seams(), readSvm: atTarget });
        expect(svmCalls().length).to.equal(0);
        const r = loadArtifact(a.epochId, a.phase).receipts[SVM_CHAIN_KEY] as any;
        expect(r).to.include({ txHash: ALREADY_APPLIED, recovered: true, cluster: "devnet" });
        expect(loadLedger(ledgerPath).length).to.equal(1);
    });

    it("SVM: refuses (and does not spawn) when SVM's schedule matches neither pre-state nor target", async () => {
        const a = save(makeArtifact({ epochId: "bcast-svm-moved" }));
        const moved = async () => ({ ...PRE_STATE, pendingRateEnd: 1 });
        const err = await rejection(
            broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: false, run: recorder, ...seams(), readSvm: moved })
        );
        expect(err.message).to.match(/solana/);
        expect(svmCalls().length).to.equal(0);
        expect(loadLedger(ledgerPath)).to.deep.equal([]);
    });

    it("SVM: proceeds when SVM still matches the expected pre-state", async () => {
        const a = save(makeArtifact({ epochId: "bcast-svm-prestate" }));
        await broadcastArtifact({
            epochId: a.epochId,
            phase: a.phase,
            dryRun: false,
            run: recorder,
            ...seams(),
            readSvm: async () => ({ ...PRE_STATE }),
        });
        expect(svmCalls().length).to.equal(1);
        expect((loadArtifact(a.epochId, a.phase).receipts[SVM_CHAIN_KEY] as any).txHash).to.equal(STUB_SVM_SIGNATURE);
    });

    it("SVM: refuses a cluster that differs from the committed one", async () => {
        process.env.SVM_NETWORK = "mainnet-beta";
        const a = save(makeArtifact({ epochId: "bcast-svm-cluster" }));
        const err = await rejection(
            broadcastArtifact({ epochId: a.epochId, phase: a.phase, dryRun: true, run: recorder, ...seams(), yesMainnet: true })
        );
        expect(err.message).to.match(/solana/);
        expect(svmCalls().length).to.equal(0);
    });
});
