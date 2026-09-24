/**
 * Epoch-schedule artifact I/O — pure `fs`, deliberately hardhat-free.
 *
 * Keep this module hardhat-free: `broadcastSchedule.ts` is a chain-agnostic
 * driver that must run standalone (`tsx broadcastSchedule.ts`, no bound
 * `--network`) and spawn per-chain subprocesses. Importing these helpers from
 * `deriveEpochSchedule.ts` instead would pull in hardhat's runtime just to
 * read/write a JSON file, breaking that. `deriveEpochSchedule.ts` re-exports
 * from here.
 *
 * Artifact identity is the PAIR `(epochId, phase)`, not `epochId` alone: one
 * epoch has two phases — `stage-settlement` then `roll-epoch` — under the same
 * `epochId`, so keying on `epochId` alone would make the second phase's
 * `saveArtifact` collide with the first phase's file.
 */

import * as fs from "fs";
import * as path from "path";

export type EpochPhase = "stage-settlement" | "roll-epoch";

/** WAD integers + absolute timestamps, exactly what both stacks submit. */
export interface EpochScheduleArtifact {
  artifactVersion: 1;
  epochId: string;
  phase: EpochPhase;
  derivedAtSec: number;
  /** Chain the derivation read its CURRENT on-chain schedule from. Every
   *  chain is expected to already be running this same schedule — this is
   *  just where the operator happened to read it. */
  referenceChain: string;
  schedule: {
    rate: string; // WAD, decimal string (bigint doesn't survive JSON)
    rateEnd: number;
    nextRate: string;
    nextRateEnd: number;
  };
  meta: {
    realisedYieldUsd: number;
    conservativeFactor: number;
    /** Carry-in APPLIED to this derivation's target — from the prior
     *  `roll-epoch` entry's `carryForwardUsd` (or an explicit override). */
    carryInUsd: number;
    /**
     * Carry-forward PRODUCED by this derivation, from clamping/rounding/
     * deliberate `conservativeFactor` withholding — i.e.
     * `RateWithCarry.carryForwardUsd` from `yieldRate.ts`. This is knowable
     * at derivation time and is DIFFERENT from ex-post reconciliation
     * (actual-vs-target once the epoch has actually run) — see
     * `reconciledCarryUsd` on `carryLedger.ts`'s `CarryLedgerEntry`, which is
     * filled in one epoch LATER, once it's measurable. Do not conflate them.
     * `stage-settlement` doesn't close an epoch, so this is always `0` there.
     */
    carryForwardUsd: number;
    globalValueUsd: number;
    /** Set only by `roll-epoch` derivations that found a prior ledger entry
     *  to reconcile against — the epochId whose `reconciledCarryUsd` this
     *  derivation's `carryInUsd` equals. `broadcastSchedule.ts` uses it to
     *  backfill that PRIOR entry once this artifact's broadcast confirms.
     *  Absent for the very first epoch (no prior entry exists) and for
     *  `stage-settlement` (which doesn't close an epoch). */
    priorEpochId?: string;
  };
  /** Populated by `broadcastSchedule.ts` as each chain confirms. Present here
   *  (rather than a separate file) so re-running the broadcaster can see what
   *  already landed and skip it — see that file for the resume logic. */
  receipts: Record<string, { txHash: string; confirmedAtSec: number } | { error: string }>;
}

const ARTIFACT_DIR = path.join(__dirname, "../config/epochs");

/** `(epochId, phase)` -> on-disk filename. The pairing is the fix for the
 *  epochId-only collision described in the module doc. */
export function artifactKey(epochId: string, phase: EpochPhase): string {
  return `${epochId}-${phase}`;
}

export function artifactPath(epochId: string, phase: EpochPhase): string {
  return path.join(ARTIFACT_DIR, `${artifactKey(epochId, phase)}.json`);
}

export function saveArtifact(artifact: EpochScheduleArtifact): string {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const p = artifactPath(artifact.epochId, artifact.phase);
  if (fs.existsSync(p)) {
    throw new Error(
      `Artifact already exists for epochId=${artifact.epochId} phase=${artifact.phase} at ${p}. ` +
        `Each (epoch, phase) derivation must be written exactly once — if you need to ` +
        `re-derive, use a new epochId or delete the stale artifact deliberately.`
    );
  }
  fs.writeFileSync(p, JSON.stringify(artifact, null, 2) + "\n");
  return p;
}

export function loadArtifact(epochId: string, phase: EpochPhase): EpochScheduleArtifact {
  const p = artifactPath(epochId, phase);
  if (!fs.existsSync(p)) throw new Error(`No artifact for epochId=${epochId} phase=${phase} at ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function saveArtifactInPlace(artifact: EpochScheduleArtifact): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  fs.writeFileSync(
    artifactPath(artifact.epochId, artifact.phase),
    JSON.stringify(artifact, null, 2) + "\n"
  );
}
