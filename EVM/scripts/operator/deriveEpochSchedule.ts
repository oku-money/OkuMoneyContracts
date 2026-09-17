/**
 * Pure epoch-schedule derivation, decoupled from submission.
 *
 * ## Why this file exists
 *
 * `runEpoch.ts` used to derive AND submit in one function body, once per
 * `--network` invocation. That has two problems for a protocol with more than
 * one chain:
 *
 *   1. It re-derives from scratch on every chain, so N chains can produce N
 *      different rates unless every derivation input is identical across runs.
 *   2. It never prints the derived WAD integers anywhere a second stack could
 *      read them — `floatRateToBigint`'s output reached the transaction and
 *      nothing else. There was no artifact to hand to SVM.
 *
 * This file derives ONCE and writes a signed-shape JSON artifact containing
 * the WAD integers and absolute timestamps. `broadcastSchedule.ts` reads that
 * artifact and fans it out to every EVM chain and SVM. Splitting these apart
 * is also what makes the carry ledger correct: one derivation, one ledger
 * entry, rather than one per chain.
 *
 * ## The fix this also carries
 *
 * The previous `runRollEpoch` derived `measuredAvgValueUsd` from the LOCAL
 * chain's `totalSupply() * okuMMultiplier()` (`schedule.totalSupplyFloat *
 * schedule.currentMultiplierFloat`). `yieldRate.ts`'s own module doc states the
 * rule this violated: the denominator must be the GLOBAL time-weighted value
 * across every chain, never a single chain's local supply — "that is precisely
 * why `distributeYield` was removed: it produced a different multiplier delta
 * on every chain." Reading from one chain and deriving once removes the
 * violation structurally rather than patching the formula.
 *
 * `stage-settlement`'s synthetic-sample fallback (silently using local supply
 * when the V̄ store is empty) is also removed. A missing sample store is now a
 * hard error: deriving a real rate from an unmeasured V̄ is exactly the failure
 * this file exists to prevent, not something to paper over.
 */

import * as fs from "fs";
import * as path from "path";
import { ethers } from "hardhat";
import { Signer } from "ethers";
import { NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import {
  deriveSettlementRate,
  distributedUsdOverWindow,
  RateSegment,
  deriveBaseRate,
  toOnChainSchedule,
  DEFAULT_SETTLEMENT_FRACTION,
  EpochGrid,
  describeRate,
  reconcileActualPayout,
} from "@okumoney/yield-tooling";
import { sampleGlobalValueUsd, samplesInWindow, valueAt } from "../utils/globalValue";
import { summarizeLedger } from "../utils/carryLedger";

async function readSchedule(okuM: any) {
  const [rateBn, anchorBn, rateEndBn, baseMultBn, multiplierBn] = await Promise.all([
    okuM.okuMRatePerSecond(),
    okuM.okuMLastAccrualTime(),
    okuM.okuMRateEnd(),
    okuM.okuMBaseMultiplier(),
    okuM.okuMMultiplier(),
  ]);
  return {
    rateFloat: Number(rateBn) / 1e18,
    anchorSec: Number(anchorBn),
    rateEndSec: Number(rateEndBn),
    baseMultiplierFloat: Number(baseMultBn) / 1e18,
    currentMultiplierFloat: Number(multiplierBn) / 1e18,
  };
}

/** WAD integers + absolute timestamps, exactly what both stacks submit. */
export interface EpochScheduleArtifact {
  artifactVersion: 1;
  epochId: string;
  phase: "stage-settlement" | "roll-epoch";
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
    carryInUsd: number;
    carryForwardUsd: number;
    globalValueUsd: number;
  };
  /** Populated by `broadcastSchedule.ts` as each chain confirms. Present here
   *  (rather than a separate file) so re-running the broadcaster can see what
   *  already landed and skip it — see that file for the resume logic. */
  receipts: Record<string, { txHash: string; confirmedAtSec: number } | { error: string }>;
}

const ARTIFACT_DIR = path.join(__dirname, "../config/epochs");

export function artifactPath(epochId: string): string {
  return path.join(ARTIFACT_DIR, `${epochId}.json`);
}

export function saveArtifact(artifact: EpochScheduleArtifact): string {
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  const p = artifactPath(artifact.epochId);
  if (fs.existsSync(p)) {
    throw new Error(
      `Artifact already exists for epochId=${artifact.epochId} at ${p}. ` +
        `Each epoch's derivation must be written exactly once — if you need to ` +
        `re-derive, use a new epochId or delete the stale artifact deliberately.`
    );
  }
  fs.writeFileSync(p, JSON.stringify(artifact, null, 2) + "\n");
  return p;
}

export function loadArtifact(epochId: string): EpochScheduleArtifact {
  const p = artifactPath(epochId);
  if (!fs.existsSync(p)) throw new Error(`No artifact for epochId=${epochId} at ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf-8"));
}

export function saveArtifactInPlace(artifact: EpochScheduleArtifact): void {
  fs.writeFileSync(artifactPath(artifact.epochId), JSON.stringify(artifact, null, 2) + "\n");
}

async function referenceOkuM(ctx: NetworkContext, signer: Signer) {
  const addr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!addr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);
  return (await getDeployedContract("OkuMoney", addr)).connect(signer) as any;
}

export interface DeriveStageSettlementOpts {
  epochId: string;
  realisedYieldUsd: number;
  pendingEndTimestamp: bigint;
  conservativeFactor?: number;
  carryInUsd?: number;
}

/** Derive the `stage-settlement` schedule and write its artifact. Submits nothing. */
export async function deriveStageSettlement(
  ctx: NetworkContext,
  signer: Signer,
  opts: DeriveStageSettlementOpts
): Promise<EpochScheduleArtifact> {
  const conservativeFactor = opts.conservativeFactor ?? 1.0;
  const okuM = await referenceOkuM(ctx, signer);
  const schedule = await readSchedule(okuM);
  if (schedule.rateEndSec === 0) {
    throw new Error("Accrual is halted (rateEnd=0) — call setOkuMYieldRate first");
  }

  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  const carryInUsd = opts.carryInUsd ?? summarizeLedger().outstandingCarryUsd;
  const adjustedTargetUsd = opts.realisedYieldUsd * conservativeFactor + carryInUsd;

  const segment: RateSegment = {
    startSec: schedule.anchorSec,
    endSec: schedule.rateEndSec,
    ratePerSecond: schedule.rateFloat,
    anchorMultiplier: schedule.baseMultiplierFloat,
  };

  // GLOBAL samples only. No local-supply fallback: if the V̄ store has no
  // samples in this window, that is a real gap in measurement and must fail
  // loudly rather than derive a rate from one chain's supply.
  const samples = samplesInWindow(schedule.anchorSec, now);
  const distributedSoFarUsd = distributedUsdOverWindow([segment], samples, schedule.anchorSec, now);
  const forecastValueUsd = valueAt(samples, now);
  const settlementLenSec = Number(opts.pendingEndTimestamp) - schedule.rateEndSec;
  const baseTailSec = Math.max(0, schedule.rateEndSec - now);

  logger.info(`Adjusted target:      $${adjustedTargetUsd.toFixed(2)} (realised=${opts.realisedYieldUsd}, cf=${conservativeFactor}, carryIn=${carryInUsd.toFixed(2)})`);
  logger.info(`Distributed so far:   $${distributedSoFarUsd.toFixed(2)} (global)`);
  logger.info(`Forecast value:       $${forecastValueUsd.toFixed(2)} (global)`);
  logger.info(`Settlement window:    ${settlementLenSec}s, base tail: ${baseTailSec}s`);

  const rSettleFloat = deriveSettlementRate({
    targetUsd: adjustedTargetUsd,
    distributedSoFarUsd,
    settlementForecastAvgValueUsd: forecastValueUsd,
    settlementLenSec,
    baseTailRatePerSecond: schedule.rateFloat,
    baseTailSec,
  });

  const onChain = toOnChainSchedule({
    rBaseFloat: schedule.rateFloat,
    rSettleFloat,
    grid: { epochStartSec: schedule.anchorSec, epochLengthSec: settlementLenSec + (schedule.rateEndSec - schedule.anchorSec), settlementFraction: 0 },
  });
  // toOnChainSchedule's grid-derived endpoints don't apply cleanly to a
  // re-anchor-at-same-rate call, so build the schedule fields directly rather
  // than force this case through a grid abstraction meant for a fresh epoch.
  const rate = onChain.rBase;
  const nextRate = onChain.rSettle;

  logger.info(`Derived settlement rate: ${describeRate(nextRate)}`);

  const artifact: EpochScheduleArtifact = {
    artifactVersion: 1,
    epochId: opts.epochId,
    phase: "stage-settlement",
    derivedAtSec: now,
    referenceChain: ctx.bookKey,
    schedule: {
      rate: rate.toString(),
      rateEnd: schedule.rateEndSec,
      nextRate: nextRate.toString(),
      nextRateEnd: Number(opts.pendingEndTimestamp),
    },
    meta: {
      realisedYieldUsd: opts.realisedYieldUsd,
      conservativeFactor,
      carryInUsd,
      carryForwardUsd: 0, // stage-settlement doesn't close an epoch; nothing to carry yet
      globalValueUsd: forecastValueUsd,
    },
    receipts: {},
  };
  const p = saveArtifact(artifact);
  logger.success(`Artifact written: ${p}`);
  return artifact;
}

export interface DeriveRollEpochOpts {
  epochId: string;
  nextRealisedYieldUsd: number;
  nextEndTimestamp: bigint;
  epochLengthSec: number;
  settlementFraction?: number;
  baseWindowFraction?: number;
  conservativeFactor?: number;
}

/** Derive the `roll-epoch` schedule and write its artifact. Submits nothing;
 *  does NOT touch the carry ledger — that happens once, after every chain has
 *  confirmed, in `broadcastSchedule.ts`. */
export async function deriveRollEpoch(
  ctx: NetworkContext,
  signer: Signer,
  opts: DeriveRollEpochOpts
): Promise<EpochScheduleArtifact> {
  const settlementFraction = opts.settlementFraction ?? DEFAULT_SETTLEMENT_FRACTION;
  const baseWindowFraction = opts.baseWindowFraction ?? 0.9;
  const conservativeFactor = opts.conservativeFactor ?? 1.0;

  const okuM = await referenceOkuM(ctx, signer);
  const schedule = await readSchedule(okuM);

  // GLOBAL value only, sampled fresh — not the reference chain's local supply.
  const globalNow = await sampleGlobalValueUsd();
  if (globalNow.valueUsd <= 0) {
    throw new Error(
      "Global value sample is 0 or unreadable — refusing to derive a rate " +
        "against an empty/unknown denominator. Check SVM_* env vars and chain RPCs."
    );
  }

  const priorSummary = summarizeLedger();
  let carryForwardUsd = 0;
  if (priorSummary.latestEntry) {
    const priorTargetUsd = priorSummary.latestEntry.realisedYieldUsd + priorSummary.latestEntry.carryInUsd;
    // Ex-post reconciliation also needs the GLOBAL delta, not the reference
    // chain's local delta — approximate via the reference chain's multiplier
    // change (identical on every chain by construction) times GLOBAL value at
    // measurement time, which is what the ledger entry actually recorded.
    const priorMeasuredAvgValueUsd = priorSummary.latestEntry.measuredAvgValueUsd;
    const actualPaidUsd =
      priorMeasuredAvgValueUsd * (schedule.currentMultiplierFloat / schedule.baseMultiplierFloat - 1);
    carryForwardUsd = reconcileActualPayout(priorTargetUsd, actualPaidUsd);
    logger.info(`Ex-post reconciliation: target=$${priorTargetUsd.toFixed(2)} actual=$${actualPaidUsd.toFixed(2)} carryForward=$${carryForwardUsd.toFixed(2)}`);
  }

  const grid: EpochGrid = { epochStartSec: schedule.rateEndSec, epochLengthSec: opts.epochLengthSec, settlementFraction };
  const nextAdjustedTargetUsd = opts.nextRealisedYieldUsd * conservativeFactor + carryForwardUsd;
  const { ratePerSecond: rBaseNextFloat } = deriveBaseRate({
    targetUsd: nextAdjustedTargetUsd,
    baseWindowFraction,
    measuredAvgValueUsd: globalNow.valueUsd,
    grid,
  });
  const baseEndNextSec = Math.floor(schedule.rateEndSec + opts.epochLengthSec * (1 - settlementFraction));

  logger.info(`Next epoch adjusted target: $${nextAdjustedTargetUsd.toFixed(2)} (global V=$${globalNow.valueUsd.toFixed(2)})`);

  // Re-anchoring the already-running settlement rate at its own value, not
  // re-deriving it — this is the currently active on-chain rate, just scaled.
  const rate = BigInt(Math.round(schedule.rateFloat * 1e18));
  const nextRateBig = BigInt(Math.round(rBaseNextFloat * 1e18));

  logger.info(`Derived next base rate:     ${describeRate(nextRateBig)}`);

  const artifact: EpochScheduleArtifact = {
    artifactVersion: 1,
    epochId: opts.epochId,
    phase: "roll-epoch",
    derivedAtSec: Math.floor(Date.now() / 1000),
    referenceChain: ctx.bookKey,
    schedule: {
      rate: rate.toString(),
      rateEnd: Number(opts.nextEndTimestamp),
      nextRate: nextRateBig.toString(),
      nextRateEnd: baseEndNextSec,
    },
    meta: {
      realisedYieldUsd: opts.nextRealisedYieldUsd,
      conservativeFactor,
      carryInUsd: carryForwardUsd,
      carryForwardUsd, // roll-epoch DOES close an epoch — this is what the ledger entry uses
      globalValueUsd: globalNow.valueUsd,
    },
    receipts: {},
  };
  const p = saveArtifact(artifact);
  logger.success(`Artifact written: ${p}`);
  return artifact;
}
