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

import { ethers } from "hardhat";
import { Signer } from "ethers";
import { NetworkContext, resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";
import {
  deriveSettlementRate,
  distributedUsdOverWindow,
  RateSegment,
  deriveBaseRate,
  toOnChainSchedule,
  floatRateToBigint,
  DEFAULT_SETTLEMENT_FRACTION,
  EpochGrid,
  describeRate,
  reconcileActualPayout,
} from "@okumoney/yield-tooling";
import { sampleGlobalValueUsd, samplesInWindow, valueAt } from "../utils/globalValue";
import { summarizeLedger } from "../utils/carryLedger";
import { participatingChains, parseChainsEnv } from "../config/epochChains";
import {
  EpochScheduleArtifact,
  saveArtifact,
  loadArtifact,
  saveArtifactInPlace,
  artifactPath,
  artifactKey,
  EpochPhase,
} from "../utils/epochArtifact";

// Re-exported for backward compatibility — every I/O helper now lives in
// `epochArtifact.ts` (deliberately hardhat-free; see that file's module doc
// for why `broadcastSchedule.ts` needed this split out of this file).
export { EpochScheduleArtifact, saveArtifact, loadArtifact, saveArtifactInPlace, artifactPath, artifactKey, EpochPhase };

async function readSchedule(okuM: any) {
  const [rateBn, anchorBn, rateEndBn, baseMultBn, multiplierBn] = await Promise.all([
    okuM.okuMRatePerSecond(),
    okuM.okuMLastAccrualTime(),
    okuM.okuMRateEnd(),
    okuM.okuMBaseMultiplier(),
    okuM.okuMMultiplier(),
  ]);
  return {
    // EXACT on-chain value, preserved as a bigint. `rateFloat` below is a lossy
    // convenience view for the float-based derivation maths; it must NOT be
    // used to reconstruct a rate for submission. Near 1e18 a JS number's ULP is
    // 128, so `BigInt(Math.round(Number(rateBn) / 1e18 * 1e18))` can land up to
    // ~128 wei away from `rateBn` — and this artifact is broadcast verbatim to
    // every chain, so a re-anchor that claims to preserve the running rate
    // would in fact perturb it fleet-wide.
    rateBig: rateBn as bigint,
    rateFloat: Number(rateBn) / 1e18,
    anchorSec: Number(anchorBn),
    rateEndSec: Number(rateEndBn),
    baseMultiplierFloat: Number(baseMultBn) / 1e18,
    currentMultiplierFloat: Number(multiplierBn) / 1e18,
  };
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
  // NOT `outstandingCarryUsd` — that is the carry PRODUCED by the epoch that
  // is currently open (pending reconciliation at the next roll). The carry
  // relevant HERE is what was already baked into THIS epoch's own target
  // when its base rate was rolled (`currentEpochCarryInUsd`); re-applying
  // `outstandingCarryUsd` would double-count it (defect #3 in the deploy-
  // readiness audit — see carryLedger.ts's module doc for the full account).
  const carryInUsd = opts.carryInUsd ?? summarizeLedger().currentEpochCarryInUsd;
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
  /** Chains to include in the GLOBAL value sample — defaults to
   *  `participatingChains()` (see `config/epochChains.ts`). Passed through
   *  explicitly so callers can override for testing without mutating shared
   *  config. */
  chains?: string[];
  /**
   * Bypass the live `sampleGlobalValueUsd()` read with a supplied value.
   *
   * TEST-ONLY SEAM, same rationale as `runEpoch.ts`'s
   * `RollEpochOpts.globalValueUsdOverride`: `sampleGlobalValueUsd()` reads
   * real per-chain RPCs for every entry in `participatingChains()`
   * (`sepolia`, `baseSepolia`, etc.) — chains a local single-network drill
   * has no live address-book entries or RPC access for, so it always samples
   * to `0` there. Without this seam, `deriveRollEpoch` would be exercised
   * only by hand against live testnets, never by the operator drill.
   */
  globalValueUsdOverride?: number;
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

  // GLOBAL value only, sampled fresh — not the reference chain's local
  // supply — and scoped to the SAME chain set the broadcaster will target
  // (`participatingChains()`), not every chain in CHAIN_METADATA. Sampling a
  // wider set than the broadcast reaches would inflate V̄ with chains that
  // never receive this rate (defect #4 in the deploy-readiness audit).
  const chains = opts.chains ?? participatingChains();
  const globalNow =
    opts.globalValueUsdOverride !== undefined
      ? { valueUsd: opts.globalValueUsdOverride, timestampSec: 0, perChain: {} }
      : await sampleGlobalValueUsd(chains);
  if (globalNow.valueUsd <= 0) {
    throw new Error(
      "Global value sample is 0 or unreadable — refusing to derive a rate " +
        "against an empty/unknown denominator. Check SVM_* env vars and chain RPCs."
    );
  }

  // Ex-post reconciliation of the PRIOR epoch's ledger entry: what did it
  // ACTUALLY pay against what it targeted? This is a DIFFERENT quantity from
  // this epoch's OWN carryForwardUsd (see carryLedger.ts's module doc) — it
  // becomes THIS epoch's carryInUsd, not this epoch's own carryForwardUsd.
  const priorSummary = summarizeLedger();
  let reconciledCarryUsd = 0;
  let priorEpochId: string | undefined;
  if (priorSummary.latestEntry) {
    priorEpochId = priorSummary.latestEntry.epochId;
    const priorTargetUsd = priorSummary.latestEntry.realisedYieldUsd + priorSummary.latestEntry.carryInUsd;
    // Ex-post reconciliation also needs the GLOBAL delta, not the reference
    // chain's local delta — approximate via the reference chain's multiplier
    // change (identical on every chain by construction) times GLOBAL value at
    // measurement time, which is what the ledger entry actually recorded.
    const priorMeasuredAvgValueUsd = priorSummary.latestEntry.measuredAvgValueUsd;
    const actualPaidUsd =
      priorMeasuredAvgValueUsd * (schedule.currentMultiplierFloat / schedule.baseMultiplierFloat - 1);
    reconciledCarryUsd = reconcileActualPayout(priorTargetUsd, actualPaidUsd);
    logger.info(`Ex-post reconciliation of ${priorEpochId}: target=$${priorTargetUsd.toFixed(2)} actual=$${actualPaidUsd.toFixed(2)} reconciledCarry=$${reconciledCarryUsd.toFixed(2)}`);
  }

  const grid: EpochGrid = { epochStartSec: schedule.rateEndSec, epochLengthSec: opts.epochLengthSec, settlementFraction };
  const nextAdjustedTargetUsd = opts.nextRealisedYieldUsd * conservativeFactor + reconciledCarryUsd;
  const { ratePerSecond: rBaseNextFloat } = deriveBaseRate({
    targetUsd: nextAdjustedTargetUsd,
    baseWindowFraction,
    measuredAvgValueUsd: globalNow.valueUsd,
    grid,
  });
  const baseEndNextSec = Math.floor(schedule.rateEndSec + opts.epochLengthSec * (1 - settlementFraction));

  logger.info(`Next epoch adjusted target: $${nextAdjustedTargetUsd.toFixed(2)} (global V=$${globalNow.valueUsd.toFixed(2)}, chains=${chains.join(",")})`);

  // Re-anchoring the already-running settlement rate at its own value, not
  // re-deriving it — this is the currently active on-chain rate, used verbatim
  // as a bigint (see `readSchedule`: round-tripping it through a JS float would
  // perturb it by up to ~128 wei on every chain at once).
  const rate = schedule.rateBig;
  // MUST clamp. This is the production multi-chain roll path: `broadcastSchedule`
  // fans this artifact out to every chain, so an out-of-range rate does not fail
  // on one chain — it reverts `RateTooHigh` on ALL of them simultaneously, in the
  // settlement window, with yield already halted. `floatRateToBigint` clamps to
  // MAX_RATE instead, and the shortfall is carried forward by the ledger.
  // Every sibling rate-producing path already clamps; this one did not.
  const nextRateBig = floatRateToBigint(rBaseNextFloat);

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
      // Carry-in to THIS epoch's target is the PRIOR epoch's reconciliation —
      // NOT this epoch's own carryForwardUsd (see interface doc + the
      // carryLedger.ts module doc for why conflating them was a bug).
      carryInUsd: reconciledCarryUsd,
      // THIS epoch's own derivation-time residual: `deriveBaseRate` is a
      // pure float division with no clamping, so there is none yet. It will
      // only be known once THIS epoch closes and the NEXT roll reconciles
      // it — see `priorEpochId`/`backfillReconciliation` in broadcastSchedule.ts.
      carryForwardUsd: 0,
      globalValueUsd: globalNow.valueUsd,
      priorEpochId,
    },
    receipts: {},
  };
  const p = saveArtifact(artifact);
  logger.success(`Artifact written: ${p}`);
  return artifact;
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });
    const [signer] = await ethers.getSigners();

    const phase = parseArg("phase");
    const epochId = parseArg("epochId");
    if (!epochId) throw new Error("Required: --epochId=<id> (env: EPOCH_ID)");
    const chains = parseChainsEnv(parseArg("chains"));

    if (phase === "stage-settlement") {
      const realisedYieldUsd = Number(parseArg("realisedYieldUsd"));
      const pendingEndTimestamp = parseArg("pendingEndTimestamp");
      if (!realisedYieldUsd || !pendingEndTimestamp) {
        throw new Error("stage-settlement requires --realisedYieldUsd and --pendingEndTimestamp");
      }
      await deriveStageSettlement(ctx, signer, {
        epochId,
        realisedYieldUsd,
        pendingEndTimestamp: BigInt(pendingEndTimestamp),
        conservativeFactor: parseArg("conservativeFactor") ? Number(parseArg("conservativeFactor")) : undefined,
        carryInUsd: parseArg("carryInUsd") ? Number(parseArg("carryInUsd")) : undefined,
      });
    } else if (phase === "roll-epoch") {
      const nextRealisedYieldUsd = Number(parseArg("nextRealisedYieldUsd"));
      const nextEndTimestamp = parseArg("nextEndTimestamp");
      const epochLengthSec = Number(parseArg("epochLengthSec"));
      if (!nextRealisedYieldUsd || !nextEndTimestamp || !epochLengthSec) {
        throw new Error(
          "roll-epoch requires --nextRealisedYieldUsd, --nextEndTimestamp, and --epochLengthSec " +
            "(NOTE: for internal testing, pass a short override here, e.g. 3600 for 1h — " +
            "the on-chain contracts place no constraint on epoch length; see epoch.ts's module doc)"
        );
      }
      await deriveRollEpoch(ctx, signer, {
        epochId,
        nextRealisedYieldUsd,
        nextEndTimestamp: BigInt(nextEndTimestamp),
        epochLengthSec,
        settlementFraction: parseArg("settlementFraction") ? Number(parseArg("settlementFraction")) : undefined,
        baseWindowFraction: parseArg("baseWindowFraction") ? Number(parseArg("baseWindowFraction")) : undefined,
        conservativeFactor: parseArg("conservativeFactor") ? Number(parseArg("conservativeFactor")) : undefined,
        chains,
      });
    } else {
      throw new Error("Required: --phase=stage-settlement|roll-epoch (env: PHASE)");
    }
  });
}
