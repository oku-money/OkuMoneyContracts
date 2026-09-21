/**
 * SINGLE-CHAIN path, kept for the operator drill and for hand-driving one
 * chain at a time. For a REAL multi-chain broadcast — one derivation, byte-
 * identical WAD integers on every EVM chain and SVM — use
 * `deriveEpochSchedule.ts` + `broadcastSchedule.ts` instead, which also fixed
 * a real bug this file used to have: `runRollEpoch` derived
 * `measuredAvgValueUsd` from THIS chain's local `totalSupply()`, which
 * `yieldRate.ts`'s own module doc says is exactly the mistake
 * `distributeYield` was removed for. Patched below to sample the GLOBAL value
 * instead; the newer files never had the bug because derivation happens once,
 * not per chain.
 *
 * Base + settlement (B3) epoch runner — the glue that makes the rear-facing
 * epoch accounting model (EVM/README.md § Rear-Facing Epoch Accounting)
 * executable, not just simulated. Two phases, both using the atomic
 * `setOkuMYieldRateWithSuccessor` (see `setOkuMYieldRate.ts`):
 *
 *   PHASE=stage-settlement   (call mid base window; at 24h, a few hours before
 *                             baseEnd — i.e. inside the first 22.4h)
 *     Reads the CURRENT on-chain schedule (active rate/anchor/rateEnd) and
 *     V̄ samples since the anchor, derives the settlement rate that closes
 *     the gap between the (buffer/carry-adjusted) target and what's been
 *     measured distributed so far — projecting the base rate's own
 *     remaining tail — then re-anchors at the SAME active rate (skew-free)
 *     while atomically staging the settlement rate as its successor.
 *
 *   PHASE=roll-epoch         (call once IN the settlement window — at 24h that
 *                             is the final 1.6h of the epoch)
 *     Reconciles what the settlement rate actually delivered so far
 *     (`reconcileActualPayout`) against the target, appends a carry-ledger
 *     entry, derives the NEXT epoch's base rate from a freshly realised
 *     yield figure (folding in the resulting carry), and atomically
 *     re-anchors at the (already-running) settlement rate while staging the
 *     next epoch's base rate as its successor.
 *
 * Both phases honor DRY_RUN=true (derive + print the schedule, submit nothing).
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base PHASE=stage-settlement REALISED_YIELD_USD=40700 \
 *       PENDING_END_TIMESTAMP=1769904000 \
 *       npx hardhat run scripts/operator/runEpoch.ts --network base
 *   NETWORK=base PHASE=roll-epoch NEXT_REALISED_YIELD_USD=41200 \
 *       NEXT_END_TIMESTAMP=1772323200 EPOCH_LENGTH_SEC=86400 \
 *       npx hardhat run scripts/operator/runEpoch.ts --network base
 *
 * Environment (see individual phase functions for the full parameter list):
 *   PHASE=<stage-settlement|roll-epoch>          (required)
 *   EPOCH_ID=<label>             for the carry ledger (default: ISO date)
 *   SETTLEMENT_FRACTION=<0..1>   default DEFAULT_SETTLEMENT_FRACTION (1/15)
 *   BASE_WINDOW_FRACTION=<0..1>  roll-epoch only, default 0.9
 *   CONSERVATIVE_FACTOR=<0..1>   default 1.0 (pure rear-facing, no buffer)
 *   DRY_RUN=true / YES_MAINNET=true  standard guards
 *
 * Also exported as `runStageSettlement()` / `runRollEpoch()` for in-process
 * callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";
import { runSetOkuMYieldRate } from "./setOkuMYieldRate";
import { deriveSettlementRate, distributedUsdOverWindow, RateSegment } from "../utils/epochDistribution";
import { deriveBaseRate, floatRateToBigint, DEFAULT_SETTLEMENT_FRACTION, EpochGrid } from "../utils/epochSchedule";
import { samplesInWindow, valueAt, sampleGlobalValueUsd } from "../utils/globalValue";
import { reconcileActualPayout } from "../utils/yieldRate";
import { upsertLedgerEntry, backfillReconciliation, buildLedgerEntry, summarizeLedger } from "../utils/carryLedger";
import { EPOCH_LENGTH_SECONDS as DEFAULT_EPOCH_LENGTH_SECONDS } from "../config/epoch";

async function readSchedule(okuM: any) {
  const [rateBn, anchorBn, rateEndBn, baseMultBn, totalSupplyBn, multiplierBn] = await Promise.all([
    okuM.okuMRatePerSecond(),
    okuM.okuMLastAccrualTime(),
    okuM.okuMRateEnd(),
    okuM.okuMBaseMultiplier(),
    okuM.totalSupply(),
    okuM.okuMMultiplier(),
  ]);
  return {
    rateFloat: Number(rateBn) / 1e18,
    anchorSec: Number(anchorBn),
    rateEndSec: Number(rateEndBn),
    baseMultiplierFloat: Number(baseMultBn) / 1e18,
    totalSupplyFloat: Number(ethers.formatEther(totalSupplyBn)),
    currentMultiplierFloat: Number(multiplierBn) / 1e18,
  };
}

export interface StageSettlementOpts {
  realisedYieldUsd: number;
  pendingEndTimestamp: bigint;
  conservativeFactor?: number;
  carryInUsd?: number;
  epochId?: string;
  dryRun?: boolean;
}

export async function runStageSettlement(
  ctx: NetworkContext,
  signer: Signer,
  opts: StageSettlementOpts
): Promise<{ rSettleFloat: number; distributedSoFarUsd: number; adjustedTargetUsd: number }> {
  const conservativeFactor = opts.conservativeFactor ?? 1.0;
  const okuMAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!okuMAddr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);
  const okuM = (await getDeployedContract("OkuMoney", okuMAddr)).connect(signer) as any;

  const schedule = await readSchedule(okuM);
  if (schedule.rateEndSec === 0) throw new Error("Accrual is halted (rateEnd=0) — call setOkuMYieldRate first");

  // CHAIN time, not wall-clock: on a live network these are identical, but
  // using Date.now() here was a real bug the operator drill caught — under
  // any time-warped local/testnet workflow (or if the operator's system
  // clock ever drifts from consensus time) it silently diverges from what
  // the contract's `block.timestamp`-anchored schedule actually uses,
  // producing a window with `now < anchorSec` and breaking the sample query.
  const now = (await ethers.provider.getBlock("latest"))!.timestamp;
  // `currentEpochCarryInUsd`, NOT `outstandingCarryUsd` — same fix as
  // `deriveEpochSchedule.ts::deriveStageSettlement`, kept in lockstep because
  // BOTH paths write to the same carry ledger and an operator may use either.
  //
  // The carry relevant here is what was already folded into THIS epoch's
  // target when its base rate was rolled. `outstandingCarryUsd` is the carry
  // the open epoch will PRODUCE (pending ex-post reconciliation at the next
  // roll) — applying it here would double-count it. This was latent while
  // this path ran alone (it always wrote `carryForwardUsd: 0`, so
  // `outstandingCarryUsd` was always 0), but became live the moment the
  // derive/broadcast path started backfilling real non-zero reconciliations
  // into the shared ledger. See carryLedger.ts's module doc.
  const carryInUsd = opts.carryInUsd ?? summarizeLedger().currentEpochCarryInUsd;
  const adjustedTargetUsd = opts.realisedYieldUsd * conservativeFactor + carryInUsd;

  const segment: RateSegment = {
    startSec: schedule.anchorSec,
    endSec: schedule.rateEndSec,
    ratePerSecond: schedule.rateFloat,
    anchorMultiplier: schedule.baseMultiplierFloat,
  };

  // Real deployments: pull persisted samples via samplesInWindow. In a fresh
  // local drill there may be no persisted samples yet — fall back to a
  // synthetic 2-point series anchored on current on-chain state, which
  // degrades gracefully to "no measured distribution yet" rather than throwing.
  let samples;
  try {
    samples = samplesInWindow(schedule.anchorSec, now);
  } catch {
    samples = [
      { timestampSec: schedule.anchorSec, valueUsd: schedule.totalSupplyFloat * schedule.baseMultiplierFloat },
      { timestampSec: now, valueUsd: schedule.totalSupplyFloat * schedule.currentMultiplierFloat },
    ];
  }

  const distributedSoFarUsd = distributedUsdOverWindow(segment ? [segment] : [], samples, schedule.anchorSec, now);
  const forecastValueUsd = valueAt(samples, now);
  const settlementLenSec = Number(opts.pendingEndTimestamp) - schedule.rateEndSec;
  const baseTailSec = Math.max(0, schedule.rateEndSec - now);

  logger.info(`Adjusted target:      $${adjustedTargetUsd.toFixed(2)} (realised=${opts.realisedYieldUsd}, cf=${conservativeFactor}, carryIn=${carryInUsd.toFixed(2)})`);
  logger.info(`Distributed so far:   $${distributedSoFarUsd.toFixed(2)}`);
  logger.info(`Forecast value:       $${forecastValueUsd.toFixed(2)}`);
  logger.info(`Settlement window:    ${settlementLenSec}s, base tail: ${baseTailSec}s`);

  const rSettleFloat = deriveSettlementRate({
    targetUsd: adjustedTargetUsd,
    distributedSoFarUsd,
    settlementForecastAvgValueUsd: forecastValueUsd,
    settlementLenSec,
    baseTailRatePerSecond: schedule.rateFloat,
    baseTailSec,
  });
  logger.info(`Derived settlement rate: ${rSettleFloat}`);

  if (!opts.dryRun) {
    await runSetOkuMYieldRate(ctx, signer, {
      mode: "withSuccessor",
      rate: floatRateToBigint(schedule.rateFloat),
      endTimestamp: BigInt(schedule.rateEndSec),
      nextRate: floatRateToBigint(rSettleFloat),
      pendingEndTimestamp: opts.pendingEndTimestamp,
    });
  } else {
    logger.success("DRY_RUN=true — not submitting");
  }

  return { rSettleFloat, distributedSoFarUsd, adjustedTargetUsd };
}

export interface RollEpochOpts {
  nextRealisedYieldUsd: number;
  nextEndTimestamp: bigint;
  epochLengthSec: number;
  settlementFraction?: number;
  baseWindowFraction?: number;
  conservativeFactor?: number;
  epochId?: string;
  dryRun?: boolean;
  /**
   * Bypass the live `sampleGlobalValueUsd()` read with a supplied value.
   *
   * TEST-ONLY SEAM. `sampleGlobalValueUsd()` is inherently multi-chain
   * (`CHAIN_METADATA`-driven, reads via `JsonRpcProvider` per configured
   * chain) — it cannot be exercised against a local single-chain hardhat
   * network, for the same reason `checkMultiplierDrift.ts` and the
   * `globalValue` drill test aren't (see that test's own module doc). Without
   * this seam, fixing the local-supply bug here would have made the operator
   * drill's roll-epoch case unrunnable locally rather than just documenting
   * an existing multi-chain-only limitation.
   */
  globalValueUsdOverride?: number;
}

export async function runRollEpoch(
  ctx: NetworkContext,
  signer: Signer,
  opts: RollEpochOpts
): Promise<{ carryForwardUsd: number; rBaseNextFloat: number }> {
  const settlementFraction = opts.settlementFraction ?? DEFAULT_SETTLEMENT_FRACTION;
  const baseWindowFraction = opts.baseWindowFraction ?? 0.9;
  const conservativeFactor = opts.conservativeFactor ?? 1.0;

  const okuMAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!okuMAddr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);
  const okuM = (await getDeployedContract("OkuMoney", okuMAddr)).connect(signer) as any;
  const schedule = await readSchedule(okuM);

  // GLOBAL value across every chain (EVM + SVM), NOT this chain's local
  // totalSupply(). See the file-level doc: this is the bug fix.
  const globalValueUsd =
    opts.globalValueUsdOverride ?? (await sampleGlobalValueUsd()).valueUsd;
  if (globalValueUsd <= 0) {
    throw new Error(
      "Global value sample is 0 or unreadable — refusing to derive a rate " +
        "against an empty/unknown denominator."
    );
  }
  const globalNow = { valueUsd: globalValueUsd };

  // Ex-post reconciliation of the JUST-COMPLETED (settlement) window: what was
  // it targeting, and what did it actually deliver? Best-effort — requires the
  // prior stage-settlement call's target to be in the ledger; if absent (e.g.
  // this is the very first epoch), skip reconciliation and start the ledger
  // fresh rather than failing the whole roll.
  const priorSummary = summarizeLedger();
  let carryForwardUsd = 0;
  let priorEpochId: string | undefined;
  if (priorSummary.latestEntry) {
    priorEpochId = priorSummary.latestEntry.epochId;
    const priorTargetUsd = priorSummary.latestEntry.realisedYieldUsd + priorSummary.latestEntry.carryInUsd;
    // GLOBAL delta: the prior entry's own measuredAvgValueUsd was global, so
    // the multiplier's relative change against it (identical on every chain
    // by construction) times that same basis is the global actual payout —
    // not this chain's local supply times the delta.
    const actualPaidUsd =
      priorSummary.latestEntry.measuredAvgValueUsd *
      (schedule.currentMultiplierFloat / schedule.baseMultiplierFloat - 1);
    carryForwardUsd = reconcileActualPayout(priorTargetUsd, actualPaidUsd);
    logger.info(`Ex-post reconciliation of ${priorEpochId}: target=$${priorTargetUsd.toFixed(2)} actual=$${actualPaidUsd.toFixed(2)} reconciledCarry=$${carryForwardUsd.toFixed(2)}`);
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

  logger.info(`Next epoch adjusted target: $${nextAdjustedTargetUsd.toFixed(2)}`);
  logger.info(`Derived next base rate:     ${rBaseNextFloat}`);

  if (!opts.dryRun) {
    await runSetOkuMYieldRate(ctx, signer, {
      mode: "withSuccessor",
      rate: floatRateToBigint(schedule.rateFloat), // the currently-running settlement rate, re-anchored
      endTimestamp: opts.nextEndTimestamp, // its own end (was staged as pendingEndTimestamp previously)
      nextRate: floatRateToBigint(rBaseNextFloat),
      pendingEndTimestamp: BigInt(baseEndNextSec),
    });

    // Ledger write mirrors `broadcastSchedule.ts` exactly — backfill the
    // PRIOR entry's ex-post reconciliation first, then upsert this epoch's
    // entry with its own (not-yet-knowable) carryForward left at 0. Both
    // paths share one ledger file, so they must produce identical state;
    // this path previously used a blind `appendLedgerEntry` and never
    // backfilled, which left `reconciledCarryUsd` permanently undefined on
    // every entry it wrote.
    if (priorEpochId) {
      backfillReconciliation(priorEpochId, carryForwardUsd);
    }
    const entry = buildLedgerEntry({
      epochId: opts.epochId ?? new Date().toISOString().slice(0, 10),
      realisedYieldUsd: opts.nextRealisedYieldUsd,
      carryInUsd: carryForwardUsd,
      measuredAvgValueUsd: globalNow.valueUsd,
      conservativeFactor,
      result: { ratePerSecond: floatRateToBigint(rBaseNextFloat), carryForwardUsd: 0 },
    });
    upsertLedgerEntry(entry);
  } else {
    logger.success("DRY_RUN=true — not submitting, ledger not updated");
  }

  return { carryForwardUsd, rBaseNextFloat };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    const phase = parseArg("phase");
    logger.header(`runEpoch (${ctx.networkName}) [${phase}]`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const [signer] = await ethers.getSigners();

    if (phase === "stage-settlement") {
      const realisedYieldUsd = Number(parseArg("realisedYieldUsd"));
      const pendingEndTimestamp = parseArg("pendingEndTimestamp");
      if (!realisedYieldUsd || !pendingEndTimestamp) {
        throw new Error("stage-settlement requires --realisedYieldUsd and --pendingEndTimestamp");
      }
      await runStageSettlement(ctx, signer, {
        realisedYieldUsd,
        pendingEndTimestamp: BigInt(pendingEndTimestamp),
        conservativeFactor: parseArg("conservativeFactor") ? Number(parseArg("conservativeFactor")) : undefined,
        dryRun: isDryRun(),
      });
    } else if (phase === "roll-epoch") {
      const nextRealisedYieldUsd = Number(parseArg("nextRealisedYieldUsd"));
      const nextEndTimestamp = parseArg("nextEndTimestamp");
      const epochLengthSec = Number(parseArg("epochLengthSec") ?? DEFAULT_EPOCH_LENGTH_SECONDS);
      if (!nextRealisedYieldUsd || !nextEndTimestamp) {
        throw new Error("roll-epoch requires --nextRealisedYieldUsd and --nextEndTimestamp");
      }
      await runRollEpoch(ctx, signer, {
        nextRealisedYieldUsd,
        nextEndTimestamp: BigInt(nextEndTimestamp),
        epochLengthSec,
        baseWindowFraction: parseArg("baseWindowFraction") ? Number(parseArg("baseWindowFraction")) : undefined,
        conservativeFactor: parseArg("conservativeFactor") ? Number(parseArg("conservativeFactor")) : undefined,
        dryRun: isDryRun(),
      });
    } else {
      throw new Error("Required: --phase=stage-settlement|roll-epoch");
    }
  });
}
