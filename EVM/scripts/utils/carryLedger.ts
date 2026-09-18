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

/**
 * One epoch's rate derivation, recorded for audit + cumulative reporting.
 *
 * ## Two DIFFERENT carry fields — do not conflate them
 *
 * `carryForwardUsd` and `reconciledCarryUsd` answer different questions and
 * are known at different TIMES. Conflating them (setting both to the same
 * value at derivation time) was a real bug: `broadcastSchedule.ts` would feed
 * `carryForwardUsd` into `summarizeLedger().outstandingCarryUsd`, which
 * actually held this entry's carry-IN, propagating the wrong figure into the
 * next epoch and silently double-counting it.
 *
 *   - `carryForwardUsd` — the DERIVATION-TIME residual from
 *     `RateWithCarry.carryForwardUsd` (clamping at `MAX_RATE`, rounding, or
 *     deliberate `conservativeFactor` withholding). Known immediately when
 *     the rate is derived. `deriveBaseRate` (float division, no clamping)
 *     currently always produces `0` here; the field exists for schema
 *     stability and any future derivation path that DOES clamp.
 *
 *   - `reconciledCarryUsd` — the EX-POST reconciliation
 *     (`reconcileActualPayout(target, actual)`) of what this epoch's rate
 *     ACTUALLY paid, once its own time-weighted average is measurable. This
 *     is only knowable one epoch LATER, at the next `roll-epoch`, and is
 *     backfilled onto this entry via {@link backfillReconciliation} at that
 *     point — it is `undefined` until then. THIS is the value that becomes
 *     the NEXT entry's `carryInUsd`.
 */
export interface CarryLedgerEntry {
  /**
   * Operator-assigned identifier (e.g. "2025-01" or a sequence number).
   *
   * ## What this entry actually describes — read before interpreting a row
   *
   * An entry is written by the `roll-epoch` phase, which derives the rate for
   * the epoch that is ABOUT TO START. So `realisedYieldUsd`, `carryInUsd`,
   * `measuredAvgValueUsd` and `ratePerSecond` on this row all describe the
   * epoch this roll OPENED — not the epoch that just closed. The epoch that
   * just closed is referenced only indirectly: its ex-post reconciliation is
   * written back onto ITS OWN (previous) row via {@link reconciledCarryUsd}.
   *
   * `epochId` is a free-form operator label and nothing derives meaning from
   * it — the carry chain is positional (each roll reconciles whatever the
   * ledger's last row is). Label rows by the epoch being OPENED to keep the
   * file readable; mislabelling misleads a human reader but cannot corrupt
   * the arithmetic.
   */
  epochId: string;
  /** When this entry was recorded, Unix seconds. */
  timestampSec: number;
  /** Confirmed dollar yield for the closed (measurement) epoch. */
  realisedYieldUsd: number;
  /** Carry-in applied to THIS epoch's target — the previous epoch's
   *  {@link reconciledCarryUsd} (or an explicit override for the first epoch). */
  carryInUsd: number;
  /** Time-weighted average value used as the denominator (see "Two V's" in yieldRate.ts). */
  measuredAvgValueUsd: number;
  /** conservativeFactor used, if any (1 = pure rear-facing, no withholding). */
  conservativeFactor: number;
  /** Resulting per-second rate, as a decimal string (bigint doesn't survive JSON). */
  ratePerSecond: string;
  /** Derivation-time residual — see interface doc. NOT the value threaded
   *  into the next epoch's `carryInUsd`; that is {@link reconciledCarryUsd}. */
  carryForwardUsd: number;
  /** Ex-post reconciliation, backfilled one epoch later — see interface doc.
   *  `undefined` means "this epoch hasn't been reconciled yet" (it may still
   *  be open, or the next roll simply hasn't happened). */
  reconciledCarryUsd?: number;
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
    // Identical derivation — safe no-op replace (idempotent re-run), but
    // preserve any reconciliation already backfilled onto the prior record;
    // a re-run's `entry` predates reconciliation by construction (it is only
    // ever produced at derivation time, before the NEXT roll backfills it).
    existing[idx] = { ...entry, reconciledCarryUsd: prior.reconciledCarryUsd };
  }
  fs.writeFileSync(ledgerPath, JSON.stringify(existing, null, 2) + "\n");
}

/**
 * Backfill the EX-POST reconciliation for a PAST epoch, one epoch after it
 * was recorded — see {@link CarryLedgerEntry.reconciledCarryUsd}. Called by
 * `broadcastSchedule.ts` once a `roll-epoch` derivation (which computed this
 * value from the ledger's own prior entry via `reconcileActualPayout`) has
 * been confirmed on every chain.
 *
 * Idempotent for the same value (a re-run after partial broadcast failure);
 * refuses to silently overwrite a DIFFERENT already-recorded reconciliation,
 * same rationale as `upsertLedgerEntry`'s divergent-derivation guard.
 */
export function backfillReconciliation(
  epochId: string,
  reconciledCarryUsd: number,
  ledgerPath = DEFAULT_LEDGER_PATH
): void {
  const existing = loadLedger(ledgerPath);
  const idx = existing.findIndex((e) => e.epochId === epochId);
  if (idx === -1) {
    throw new Error(`backfillReconciliation: no ledger entry for epochId=${epochId}`);
  }
  const prior = existing[idx].reconciledCarryUsd;
  if (prior !== undefined && prior !== reconciledCarryUsd) {
    throw new Error(
      `backfillReconciliation: epochId=${epochId} already reconciled to a DIFFERENT ` +
        `value ($${prior} vs $${reconciledCarryUsd}). Overwriting would hide a real ` +
        `inconsistency — edit the ledger file deliberately if this is intentional.`
    );
  }
  existing[idx] = { ...existing[idx], reconciledCarryUsd };
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
  /**
   * The carry to apply to the NEXT epoch's target: the latest entry's
   * {@link CarryLedgerEntry.reconciledCarryUsd} if it has been backfilled,
   * else its `carryForwardUsd` (effectively `0` today, since `deriveBaseRate`
   * doesn't clamp) as the best-known figure pending reconciliation. See
   * `pendingReconciliation` to distinguish "reconciled to 0" from "not yet
   * reconciled".
   */
  outstandingCarryUsd: number;
  /** `true` if the latest entry has not yet been reconciled
   *  (`reconciledCarryUsd === undefined`) — i.e. `outstandingCarryUsd` above
   *  is a placeholder, not a measured figure. */
  pendingReconciliation: boolean;
  /** The carry baked into the CURRENTLY OPEN epoch's target (its
   *  `carryInUsd`) — what `deriveStageSettlement` should use as its own
   *  `carryInUsd` default, since that carry was already folded into
   *  `realisedYieldUsd` when this epoch's base rate was rolled. Using
   *  `outstandingCarryUsd` there would double-apply it. */
  currentEpochCarryInUsd: number;
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
      pendingReconciliation: false,
      currentEpochCarryInUsd: 0,
      cumulativeAchievedUsd: 0,
      latestEntry: null,
    };
  }
  const cumulativeRealisedYieldUsd = ledger.reduce((sum, e) => sum + e.realisedYieldUsd, 0);
  const latestEntry = ledger[ledger.length - 1];
  const pendingReconciliation = latestEntry.reconciledCarryUsd === undefined;
  const outstandingCarryUsd = latestEntry.reconciledCarryUsd ?? latestEntry.carryForwardUsd;
  return {
    epochCount: ledger.length,
    cumulativeRealisedYieldUsd,
    outstandingCarryUsd,
    pendingReconciliation,
    currentEpochCarryInUsd: latestEntry.carryInUsd,
    cumulativeAchievedUsd: cumulativeRealisedYieldUsd - outstandingCarryUsd,
    latestEntry,
  };
}
