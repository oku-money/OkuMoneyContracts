/**
 * Carry ledger — the durable record of every `realisedYieldToRatePerSecond`
 * call, needed to (a) thread `carryForwardUsd` into the next epoch's
 * `carryInUsd` and (b) report cumulative conservation: that cumulative
 * dollars expressed as rate equal cumulative realised yield, up to the
 * outstanding carry balance (see EVM/README.md § Rear-Facing Epoch
 * Accounting, "cumulative conservation").
 *
 * OPERATIONAL NOTE: like `scripts/utils/globalValue.ts`'s sample store, this
 * on-disk ledger is a REFERENCE implementation, not a production design. The
 * carry balance is cross-chain-critical state — every chain must apply the
 * identical schedule derived from the identical carry — with NO on-chain
 * representation or verification today (`okuMRatePerSecond()` is verifiable
 * on-chain; the carry balance behind it is not). Before relying on this for
 * real rate decisions across multiple operators, move it to a durable,
 * shared, signed/versioned store. See TRACKER.md.
 */

import fs from "fs";
import path from "path";
import type { RateWithCarry } from "./yieldRate";

/** One epoch's rate derivation, recorded for audit + cumulative reporting. */
export interface CarryLedgerEntry {
  /** Operator-assigned identifier for the epoch (e.g. "2025-01" or a sequence number). */
  epochId: string;
  /** When this entry was recorded, Unix seconds. */
  timestampSec: number;
  /** Confirmed dollar yield for the closed (measurement) epoch. */
  realisedYieldUsd: number;
  /** Carry-in applied (from the previous entry's `carryForwardUsd`, or an ex-post `reconcileActualPayout`). */
  carryInUsd: number;
  /** Time-weighted average value used as the denominator (see "Two V's" in yieldRate.ts). */
  measuredAvgValueUsd: number;
  /** conservativeFactor used, if any (1 = pure rear-facing, no withholding). */
  conservativeFactor: number;
  /** Resulting per-second rate, as a decimal string (bigint doesn't survive JSON). */
  ratePerSecond: string;
  /** Carry to thread into the NEXT entry's `carryInUsd`. */
  carryForwardUsd: number;
}

/** Build a ledger entry from a {@link realisedYieldToRatePerSecond} call's inputs + result. */
export function buildLedgerEntry(params: {
  epochId: string;
  realisedYieldUsd: number;
  carryInUsd: number;
  measuredAvgValueUsd: number;
  conservativeFactor: number;
  result: RateWithCarry;
  timestampSec?: number;
}): CarryLedgerEntry {
  return {
    epochId: params.epochId,
    timestampSec: params.timestampSec ?? Math.floor(Date.now() / 1000),
    realisedYieldUsd: params.realisedYieldUsd,
    carryInUsd: params.carryInUsd,
    measuredAvgValueUsd: params.measuredAvgValueUsd,
    conservativeFactor: params.conservativeFactor,
    ratePerSecond: params.result.ratePerSecond.toString(),
    carryForwardUsd: params.result.carryForwardUsd,
  };
}

const DEFAULT_LEDGER_PATH = path.join(__dirname, "../config/carryLedger.json");

/** Append one entry to the on-disk ledger (see module doc for the "reference implementation" caveat). */
export function appendLedgerEntry(entry: CarryLedgerEntry, ledgerPath = DEFAULT_LEDGER_PATH): void {
  const existing = loadLedger(ledgerPath);
  existing.push(entry);
  fs.writeFileSync(ledgerPath, JSON.stringify(existing, null, 2) + "\n");
}

/**
 * Write one entry per EPOCH, not per invocation.
 *
 * `appendLedgerEntry` is a blind push — call it once per chain a broadcast
 * touches (as the old single-chain `runEpoch.ts` did) and one logical epoch
 * roll produces N ledger entries, with the carry balance drifting between the
 * first chain's run and the last chain's run (§ `EpochScheduleArtifact` in
 * `deriveEpochSchedule.ts`).
 *
 * This is the replacement `broadcastSchedule.ts` uses: keyed on `epochId`, it
 * replaces an existing entry for that epoch rather than duplicating it, so
 * calling it more than once for the same epoch (e.g. a re-run after a partial
 * broadcast failure) is idempotent. It refuses to SILENTLY replace a
 * DIFFERENT derivation for the same epochId — that would hide a real
 * inconsistency (the schedule was re-derived with different inputs but kept
 * the same label) behind an ordinary re-run.
 */
export function upsertLedgerEntry(entry: CarryLedgerEntry, ledgerPath = DEFAULT_LEDGER_PATH): void {
  const existing = loadLedger(ledgerPath);
  const idx = existing.findIndex((e) => e.epochId === entry.epochId);
  if (idx === -1) {
    existing.push(entry);
  } else {
    const prior = existing[idx];
    const sameDerivation =
      prior.realisedYieldUsd === entry.realisedYieldUsd &&
      prior.carryInUsd === entry.carryInUsd &&
      prior.measuredAvgValueUsd === entry.measuredAvgValueUsd &&
      prior.conservativeFactor === entry.conservativeFactor &&
      prior.ratePerSecond === entry.ratePerSecond;
    if (!sameDerivation) {
      throw new Error(
        `upsertLedgerEntry: epochId=${entry.epochId} already has a DIFFERENT ` +
          `recorded derivation. Overwriting it would hide a real inconsistency. ` +
          `If the epoch genuinely needs re-deriving, use a new epochId or edit ` +
          `the ledger file deliberately.`
      );
    }
    existing[idx] = entry; // identical derivation — safe no-op replace (idempotent re-run)
  }
  fs.writeFileSync(ledgerPath, JSON.stringify(existing, null, 2) + "\n");
}

/** Load the full ledger, oldest first. Returns `[]` if it doesn't exist yet. */
export function loadLedger(ledgerPath = DEFAULT_LEDGER_PATH): CarryLedgerEntry[] {
  if (!fs.existsSync(ledgerPath)) return [];
  const raw = fs.readFileSync(ledgerPath, "utf-8");
  if (raw.trim().length === 0) return [];
  return JSON.parse(raw) as CarryLedgerEntry[];
}

/** Cumulative conservation summary — see module doc + README for the identity this reports. */
export interface CarryLedgerSummary {
  epochCount: number;
  cumulativeRealisedYieldUsd: number;
  /** The most recent entry's carryForwardUsd — the current outstanding balance. */
  outstandingCarryUsd: number;
  /**
   * Cumulative dollars expressed as rate across all recorded epochs, per the
   * INTERNAL bookkeeping identity: cumulativeAchieved = cumulativeRealised -
   * outstandingCarry. This is only as accurate as each entry's
   * `measuredAvgValueUsd` being correctly time-weighted, and does NOT capture
   * paying-epoch AUM effects — see "Two V's" in yieldRate.ts. For TRUE
   * conservation against on-chain reality, entries should be built from
   * `reconcileActualPayout` outputs once available, not raw
   * `realisedYieldToRatePerSecond` carry alone.
   */
  cumulativeAchievedUsd: number;
  latestEntry: CarryLedgerEntry | null;
}

export function summarizeLedger(ledgerPath = DEFAULT_LEDGER_PATH): CarryLedgerSummary {
  const ledger = loadLedger(ledgerPath);
  if (ledger.length === 0) {
    return {
      epochCount: 0,
      cumulativeRealisedYieldUsd: 0,
      outstandingCarryUsd: 0,
      cumulativeAchievedUsd: 0,
      latestEntry: null,
    };
  }
  const cumulativeRealisedYieldUsd = ledger.reduce((sum, e) => sum + e.realisedYieldUsd, 0);
  const latestEntry = ledger[ledger.length - 1];
  const outstandingCarryUsd = latestEntry.carryForwardUsd;
  return {
    epochCount: ledger.length,
    cumulativeRealisedYieldUsd,
    outstandingCarryUsd,
    cumulativeAchievedUsd: cumulativeRealisedYieldUsd - outstandingCarryUsd,
    latestEntry,
  };
}
