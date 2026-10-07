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

/** The six schedule storage fields, as read from `OkuMoney` (or `PsmConfig`). */
export interface OnChainSchedule {
  rate: string; // WAD decimal string
  rateEnd: number;
  pendingRate: string;
  pendingRateEnd: number;
  baseMultiplier: string;
  lastAccrualTime: number;
}

/** Identity a target chain must present before the artifact is applied to it. */
export type ArtifactTarget =
  | { kind: "evm"; chainId: number; okuMoney: string }
  | {
      kind: "svm";
      cluster: string;
      /** `SVM_LITE_PSM_PROGRAM_ID` at derivation, if it was set. */
      programId?: string;
    };

export type ArtifactReceipt =
  | {
      txHash: string;
      confirmedAtSec: number;
      /** Identity the receipt was recorded against; a receipt is only honoured
       *  on a chain presenting the same identity. */
      chainId?: number;
      address?: string;
      cluster?: string;
      /** Set when the chain was found ALREADY carrying the target schedule
       *  (a prior run's tx landed but its receipt was never persisted). */
      recovered?: boolean;
    }
  | { error: string };

/** Placeholder tx hash for a recovered receipt whose tx could not be located. */
export const ALREADY_APPLIED = "<already-applied>";

/** Default artifact lifetime; override with `ARTIFACT_TTL_SECONDS`. */
export const DEFAULT_ARTIFACT_TTL_SECONDS = 24 * 3600;

export function artifactTtlSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.ARTIFACT_TTL_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_ARTIFACT_TTL_SECONDS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`ARTIFACT_TTL_SECONDS must be a positive integer, got "${raw}"`);
  return n;
}

/** WAD integers + absolute timestamps, exactly what both stacks submit. */
export interface EpochScheduleArtifact {
  /** 2 = carries `targetChains` / `targets` / `expectedPreState` /
   *  `expiresAtSec`. Version-1 artifacts are refused by the broadcaster and
   *  the per-chain applier — re-derive. */
  artifactVersion: 2;
  epochId: string;
  phase: EpochPhase;
  derivedAtSec: number;
  /** Wall-clock unix seconds after which nothing may be submitted from this
   *  artifact (default derivation time + 24h, `ARTIFACT_TTL_SECONDS`). */
  expiresAtSec: number;
  /** Chain the derivation read its CURRENT on-chain schedule from. Every
   *  chain is expected to already be running this same schedule — this is
   *  just where the operator happened to read it. */
  referenceChain: string;
  /** The committed target set, canonical (sorted). The broadcaster uses THIS,
   *  refuses a `CHAINS` env that differs, and only finalizes (carry ledger)
   *  once every entry here has a receipt. */
  targetChains: string[];
  /** Per-target identity, keyed by chain name (same keys as `targetChains`). */
  targets: Record<string, ArtifactTarget>;
  /** The reference chain's schedule at derivation. Applying is refused on a
   *  chain whose schedule no longer matches it (or the artifact's target —
   *  see `scheduleMatchesTarget`). `baseMultiplier` / `lastAccrualTime` are
   *  per-chain (each write re-anchors at its own block.timestamp), so they are
   *  only compared on the reference chain itself. */
  expectedPreState: OnChainSchedule;
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
    /** `roll-epoch` only: the reference chain's `okuMMultiplier()` (WAD
     *  string) when this roll was derived — the START of the epoch this roll
     *  opens. Copied onto the carry-ledger entry so the NEXT roll can measure
     *  the epoch's actual growth as `current / start - 1` (the contract's
     *  `okuMBaseMultiplier` re-anchors on every schedule write and cannot). */
    epochStartMultiplier?: string;
  };
  /** Populated as each chain confirms. Present here (rather than a separate
   *  file) so re-running the broadcaster can see what already landed and skip
   *  it — see `broadcastSchedule.ts` for the resume logic. */
  receipts: Record<string, ArtifactReceipt>;
}

/** `true` for a receipt recording a landed (or recovered) transaction. */
export function isConfirmedReceipt(
  r: ArtifactReceipt | undefined
): r is Extract<ArtifactReceipt, { txHash: string }> {
  return !!r && "txHash" in r;
}

/** Refuse artifacts without the chain/pre-state/expiry binding (version 1). */
export function assertArtifactBound(a: EpochScheduleArtifact): void {
  const v = (a as { artifactVersion: number }).artifactVersion;
  if (
    v !== 2 ||
    !Array.isArray(a.targetChains) ||
    a.targetChains.length === 0 ||
    !a.targets ||
    !a.expectedPreState ||
    typeof a.expiresAtSec !== "number"
  ) {
    throw new Error(
      `Artifact ${a.epochId}/${a.phase} (artifactVersion=${v}) carries no committed target set, ` +
        "chain identity, expected pre-state or expiry. Re-derive it with the current deriveEpochSchedule.ts."
    );
  }
  for (const c of a.targetChains) {
    if (!a.targets[c]) throw new Error(`Artifact ${a.epochId}/${a.phase}: no identity recorded for target ${c}`);
  }
}

/** Throws if `nowSec` (wall clock) is past the artifact's expiry. */
export function assertNotExpired(a: EpochScheduleArtifact, nowSec = Math.floor(Date.now() / 1000)): void {
  if (nowSec > a.expiresAtSec) {
    throw new Error(
      `Artifact ${a.epochId}/${a.phase} EXPIRED at ${new Date(a.expiresAtSec * 1000).toISOString()} ` +
        `(now ${new Date(nowSec * 1000).toISOString()}). On-chain state may have moved since ` +
        "derivation; re-derive rather than submit a stale schedule."
    );
  }
}

/** Schedule fields comparable across chains (anchors are per-chain). */
export type ScheduleFields = Pick<OnChainSchedule, "rate" | "rateEnd" | "pendingRate" | "pendingRateEnd">;

/** `true` when the chain already carries the artifact's TARGET schedule. */
export function scheduleMatchesTarget(onChain: ScheduleFields, a: EpochScheduleArtifact): boolean {
  return (
    BigInt(onChain.rate) === BigInt(a.schedule.rate) &&
    Number(onChain.rateEnd) === a.schedule.rateEnd &&
    BigInt(onChain.pendingRate) === BigInt(a.schedule.nextRate) &&
    Number(onChain.pendingRateEnd) === a.schedule.nextRateEnd
  );
}

/**
 * Differences between the chain's schedule and the artifact's expected
 * pre-state (empty = matches). Anchor fields are compared only when
 * `includeAnchor` (the reference chain): every other chain re-anchored at its
 * own block.timestamp, so its base/lastAccrualTime legitimately differ.
 */
export function preStateMismatches(
  onChain: ScheduleFields & Partial<OnChainSchedule>,
  a: EpochScheduleArtifact,
  includeAnchor: boolean
): string[] {
  const exp = a.expectedPreState;
  const out: string[] = [];
  const cmp = (k: keyof OnChainSchedule, big: boolean) => {
    const got = onChain[k];
    const want = exp[k];
    const equal = got !== undefined && (big ? BigInt(got) === BigInt(want) : Number(got) === Number(want));
    if (!equal) out.push(`${k}: on-chain ${got ?? "<unread>"} != expected ${want}`);
  };
  cmp("rate", true);
  cmp("rateEnd", false);
  cmp("pendingRate", true);
  cmp("pendingRateEnd", false);
  if (includeAnchor) {
    cmp("baseMultiplier", true);
    cmp("lastAccrualTime", false);
  }
  return out;
}

/** Write JSON via tmp file + rename so a crash mid-write cannot leave a
 *  truncated artifact (and lose every receipt in it). */
export function writeJsonAtomic(p: string, value: unknown): void {
  const tmp = `${p}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(tmp, p);
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
  writeJsonAtomic(p, artifact);
  return p;
}

export function loadArtifact(epochId: string, phase: EpochPhase): EpochScheduleArtifact {
  const p = artifactPath(epochId, phase);
  if (!fs.existsSync(p)) throw new Error(`No artifact for epochId=${epochId} phase=${phase} at ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function saveArtifactInPlace(artifact: EpochScheduleArtifact): void {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  writeJsonAtomic(artifactPath(artifact.epochId, artifact.phase), artifact);
}
