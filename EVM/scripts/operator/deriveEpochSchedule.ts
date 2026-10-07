/**
 * Pure epoch-schedule derivation, decoupled from submission.
 *
 * Derives ONCE and writes a signed-shape JSON artifact containing the WAD
 * integers and absolute timestamps. `broadcastSchedule.ts` reads that artifact
 * and fans it out to every EVM chain and SVM. Deriving once per epoch rather
 * than once per chain is what guarantees every chain receives the same rate,
 * and is what makes the carry ledger correct: one derivation, one ledger entry.
 *
 * `measuredAvgValueUsd` MUST be the GLOBAL time-weighted value across every
 * chain, never a single chain's local `totalSupply() * okuMMultiplier()` — a
 * local denominator produces a different multiplier delta on every chain.
 *
 * A missing V̄ sample store is a hard error, including in `stage-settlement`:
 * deriving a real rate from an unmeasured V̄ is exactly the failure this file
 * exists to prevent, not something to paper over.
 *
 * Every artifact is BOUND at derivation (see `buildBinding`): the sorted
 * committed target set, each target's chainId+OkuMoney address (EVM) or
 * cluster+program id (SVM), the reference chain's schedule as the expected
 * pre-state, and an expiry (`ARTIFACT_TTL_SECONDS`, default 24h). The
 * broadcaster and per-chain applier refuse to submit outside that binding.
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
import { sampleGlobalValueUsd, samplesInWindow, valueAt, warnIfSvmExcluded } from "../utils/globalValue";
import { summarizeLedger, actualPaidUsd } from "../utils/carryLedger";
import {
  participatingChains,
  parseChainsEnv,
  expectedValueChains,
  canonicalChainSet,
  SVM_CHAIN_KEY,
} from "../config/epochChains";
import { CHAIN_METADATA } from "../config/chains";
import {
  EpochScheduleArtifact,
  ArtifactTarget,
  OnChainSchedule,
  saveArtifact,
  loadArtifact,
  saveArtifactInPlace,
  artifactPath,
  artifactKey,
  artifactTtlSeconds,
  EpochPhase,
} from "../utils/epochArtifact";

// Re-exported for convenience; the I/O helpers live in `epochArtifact.ts`,
// which is deliberately hardhat-free.
export { EpochScheduleArtifact, saveArtifact, loadArtifact, saveArtifactInPlace, artifactPath, artifactKey, EpochPhase };

async function readSchedule(okuM: any) {
  const [rateBn, anchorBn, rateEndBn, baseMultBn, multiplierBn, pendingBn, pendingEndBn, effectiveBn] = await Promise.all([
    okuM.okuMRatePerSecond(),
    okuM.okuMLastAccrualTime(),
    okuM.okuMRateEnd(),
    okuM.okuMBaseMultiplier(),
    okuM.okuMMultiplier(),
    okuM.okuMPendingRatePerSecond(),
    okuM.okuMPendingRateEnd(),
    okuM.okuMEffectiveRatePerSecond(),
  ]);
  const preState: OnChainSchedule = {
    rate: (rateBn as bigint).toString(),
    rateEnd: Number(rateEndBn),
    pendingRate: (pendingBn as bigint).toString(),
    pendingRateEnd: Number(pendingEndBn),
    baseMultiplier: (baseMultBn as bigint).toString(),
    lastAccrualTime: Number(anchorBn),
  };
  return {
    preState,
    multiplierBig: multiplierBn as bigint,
    // EXACT on-chain value, preserved as a bigint. `rateFloat` below is a lossy
    // convenience view for the float-based derivation maths; it must NOT be
    // used to reconstruct a rate for submission. Near 1e18 a JS number's ULP is
    // 128, so `BigInt(Math.round(Number(rateBn) / 1e18 * 1e18))` can land up to
    // ~128 wei away from `rateBn` — and this artifact is broadcast verbatim to
    // every chain, so a re-anchor that claims to preserve the running rate
    // would in fact perturb it fleet-wide.
    rateBig: rateBn as bigint,
    // What is accruing NOW: the stored rate until `okuMRateEnd`, then the
    // armed successor (then PRECISION). `rateBig` is raw storage and goes stale
    // once the window has handed over.
    effectiveRateBig: effectiveBn as bigint,
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
  return (await getDeployedContract("OkuMoney", addr)).connect(signer);
}

/**
 * The artifact's chain binding: the committed (sorted) target set, each
 * target's identity, the reference chain's pre-state, and the expiry.
 *
 * EVM targets record `chainId` (CHAIN_METADATA) and the OkuMoney address (the
 * reference chain's from `ctx.bookKey`, so a fork derivation binds the fork's
 * contract; every other target's from its own address-book entry). A target
 * with no address is a derivation error, not something to discover mid-
 * broadcast. SVM records its cluster (`SVM_NETWORK`, default devnet — what the
 * broadcaster passes to the SVM leg) and `SVM_LITE_PSM_PROGRAM_ID` if set.
 */
function buildBinding(
  ctx: NetworkContext,
  preState: OnChainSchedule,
  chains: string[] | undefined
): Pick<EpochScheduleArtifact, "targetChains" | "targets" | "expectedPreState" | "expiresAtSec"> {
  const targetChains = canonicalChainSet(participatingChains({ requested: chains, yesMainnet: isYesMainnet() }));
  const targets: Record<string, ArtifactTarget> = {};
  for (const name of targetChains) {
    if (name === SVM_CHAIN_KEY) {
      const programId = process.env.SVM_LITE_PSM_PROGRAM_ID;
      targets[name] = {
        kind: "svm",
        cluster: process.env.SVM_NETWORK ?? "devnet",
        ...(programId ? { programId } : {}),
      };
      continue;
    }
    let addr: string | undefined;
    try {
      addr = loadAddress(name === ctx.networkName ? ctx.bookKey : name, "OkuMoney");
    } catch {
      addr = undefined;
    }
    if (!addr) throw new Error(`Cannot bind target ${name}: no OkuMoney address in the address book`);
    targets[name] = { kind: "evm", chainId: CHAIN_METADATA[name].chainId, okuMoney: addr };
  }
  return {
    targetChains,
    targets,
    expectedPreState: preState,
    expiresAtSec: Math.floor(Date.now() / 1000) + artifactTtlSeconds(),
  };
}

export interface DeriveStageSettlementOpts {
  epochId: string;
  realisedYieldUsd: number;
  pendingEndTimestamp: bigint;
  conservativeFactor?: number;
  carryInUsd?: number;
  /** Target / V̄ chain scope — defaults to `participatingChains()`. Fixes both
   *  the artifact's committed target set and the chain set every V̄ sample
   *  in the window must cover (`expectedValueChains()`). */
  chains?: string[];
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
  // `outstandingCarryUsd` would double-count it. See carryLedger.ts.
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
  // loudly rather than derive a rate from one chain's supply. Every sample
  // used must cover exactly the current expected chain set, the window start
  // must be covered, and no gap may exceed the default max (see
  // `samplesInWindow`).
  const scope = { requested: opts.chains, yesMainnet: isYesMainnet() };
  const valueChains = expectedValueChains(scope);
  warnIfSvmExcluded(participatingChains(scope), valueChains);
  const samples = samplesInWindow(schedule.anchorSec, now, valueChains);
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
    artifactVersion: 2,
    epochId: opts.epochId,
    phase: "stage-settlement",
    derivedAtSec: now,
    referenceChain: ctx.bookKey,
    ...buildBinding(ctx, schedule.preState, opts.chains),
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
   * TEST-ONLY SEAM: `sampleGlobalValueUsd()` reads real per-chain RPCs for
   * every entry in `participatingChains()` (`sepolia`, `baseSepolia`, etc.) —
   * chains a local single-network drill has no address-book entries or RPC
   * access for, so it always samples to `0` there.
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

  // GLOBAL value only, sampled fresh — not the reference chain's local supply —
  // and scoped to the SAME chain set the broadcaster will target
  // (`participatingChains()`), not every chain in CHAIN_METADATA. A wider
  // sample set than the broadcast reaches would inflate V̄ with chains that
  // never receive this rate. `sampleGlobalValueUsd` throws unless EVERY
  // expected chain was read.
  const chains = participatingChains({ requested: opts.chains, yesMainnet: isYesMainnet() });
  const globalNow =
    opts.globalValueUsdOverride !== undefined
      ? { valueUsd: opts.globalValueUsdOverride, timestampSec: 0, perChain: {} }
      : await sampleGlobalValueUsd(opts.chains);
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
    // Ex-post reconciliation needs the GLOBAL delta, not the reference
    // chain's local delta — approximated as the reference chain's multiplier
    // growth over the WHOLE prior epoch (identical on every chain by
    // construction) times the GLOBAL value the ledger entry recorded.
    //
    // Growth is `current / epochStartMultiplier - 1`, where the start value
    // was recorded at the roll that opened the prior epoch. NOT
    // `current / okuMBaseMultiplier`: the base re-anchors on every schedule
    // write (stage-settlement AND roll), so that ratio covers only the last
    // segment. `actualPaidUsd` refuses entries without a start multiplier.
    //
    // KNOWN LIMITATION: `measuredAvgValueUsd` is the single spot V̄ sampled at
    // that roll, not a time-weighted average over the epoch.
    const actualPaid = actualPaidUsd(priorSummary.latestEntry, schedule.multiplierBig);
    reconciledCarryUsd = reconcileActualPayout(priorTargetUsd, actualPaid);
    logger.info(`Ex-post reconciliation of ${priorEpochId}: target=$${priorTargetUsd.toFixed(2)} actual=$${actualPaid.toFixed(2)} reconciledCarry=$${reconciledCarryUsd.toFixed(2)}`);
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
  // re-deriving it — this is the currently ACTIVE on-chain rate (the effective
  // rate: if the roll lands after `okuMRateEnd`, the successor is what is
  // running, not the stored base rate), used verbatim as a bigint (see
  // `readSchedule`: round-tripping it through a JS float would perturb it by up
  // to ~128 wei on every chain at once).
  const rate = schedule.effectiveRateBig;
  // MUST clamp. This is the production multi-chain roll path: `broadcastSchedule`
  // fans this artifact out to every chain, so an out-of-range rate does not fail
  // on one chain — it reverts `RateTooHigh` on ALL of them simultaneously, in the
  // settlement window, with yield already halted. `floatRateToBigint` clamps to
  // MAX_RATE instead, and the shortfall is carried forward by the ledger.
  const nextRateBig = floatRateToBigint(rBaseNextFloat);

  logger.info(`Derived next base rate:     ${describeRate(nextRateBig)}`);

  const artifact: EpochScheduleArtifact = {
    artifactVersion: 2,
    epochId: opts.epochId,
    phase: "roll-epoch",
    derivedAtSec: Math.floor(Date.now() / 1000),
    referenceChain: ctx.bookKey,
    ...buildBinding(ctx, schedule.preState, opts.chains),
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
      // NOT this epoch's own carryForwardUsd. Do not conflate them; see
      // carryLedger.ts's module doc.
      carryInUsd: reconciledCarryUsd,
      // THIS epoch's own derivation-time residual: `deriveBaseRate` is a
      // pure float division with no clamping, so there is none yet. It will
      // only be known once THIS epoch closes and the NEXT roll reconciles
      // it — see `priorEpochId`/`backfillReconciliation` in broadcastSchedule.ts.
      carryForwardUsd: 0,
      globalValueUsd: globalNow.valueUsd,
      priorEpochId,
      // Start of the epoch this roll opens; the NEXT roll reconciles against it.
      epochStartMultiplier: schedule.multiplierBig.toString(),
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
        chains,
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
