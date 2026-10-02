/**
 * Apply one epoch-schedule artifact's WAD integers to whichever EVM chain
 * this process is bound to.
 *
 * Separate from `broadcastSchedule.ts` because Hardhat's `network` runtime is
 * bound to the process at `hardhat run --network <chain>` and cannot be
 * redirected mid-process (`resolveNetworkContext()` reads that binding, it
 * does not accept a chain name). Broadcasting to N chains is therefore N
 * subprocess invocations of THIS file, one per `--network`, orchestrated by
 * `broadcastSchedule.ts`.
 *
 * Usage:
 *   NETWORK=base EPOCH_ID=2026-01 PHASE=roll-epoch npx hardhat run \
 *     scripts/operator/applyScheduleSingleChain.ts --network base
 *
 * The work is split into two exported, Hardhat-free functions — `parseApplyArgs`
 * and `applyScheduleToChain` — with the Hardhat-bound wiring confined to the
 * `require.main` block. That split exists so the control flow around the chain
 * write is testable: argument validation, the already-confirmed early return,
 * the dry-run path and the receipt write-back are the parts that have broken
 * before, and none of them need a network to exercise. Same reasoning as
 * `broadcastSchedule.ts`'s injectable `SubprocessRunner`.
 */

import type { Signer } from "ethers";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { isYesMainnet, isDryRun, parseArg, runMain } from "../utils/cli";
import { runSetOkuMYieldRate } from "./setOkuMYieldRate";
import type { SetOkuMYieldRateResult } from "./setOkuMYieldRate";
import type { NetworkContext } from "../utils/networkContext";
import {
  loadArtifact,
  saveArtifactInPlace,
  EpochPhase,
  EpochScheduleArtifact,
} from "../utils/epochArtifact";

/** The one on-chain call this script makes, injectable for tests. */
export type RateApplier = (
  ctx: NetworkContext,
  signer: Signer,
  opts: {
    mode: "withSuccessor";
    rate: bigint;
    endTimestamp: bigint;
    nextRate: bigint;
    pendingEndTimestamp: bigint;
    dryRun: boolean;
  }
) => Promise<SetOkuMYieldRateResult>;

export interface ApplyArgs {
  epochId: string;
  phase: EpochPhase;
  dryRun: boolean;
}

/** What `applyScheduleToChain` did, so callers and tests can assert on it. */
export type ApplyOutcome = "already-confirmed" | "dry-run" | "recorded";

/**
 * Read and validate this invocation's arguments from argv/env.
 *
 * Throws rather than defaulting. `phase` in particular must not fall back to
 * a value: the two phases write different schedules, and silently picking one
 * would broadcast a wrong-but-plausible rate to every chain.
 */
export function parseApplyArgs(): ApplyArgs {
  const epochId = parseArg("epochId");
  const phase = parseArg("phase") as EpochPhase | undefined;
  if (!epochId) throw new Error("Required: --epochId=<id> (env: EPOCH_ID)");
  if (phase !== "stage-settlement" && phase !== "roll-epoch") {
    throw new Error("Required: --phase=stage-settlement|roll-epoch (env: PHASE)");
  }
  return { epochId, phase, dryRun: isDryRun() };
}

/**
 * Apply `artifact`'s schedule to the chain `ctx` is bound to, and record the
 * receipt.
 *
 * Idempotent by design: a chain that already carries a `txHash` receipt is
 * skipped, so re-running a partially-failed broadcast cannot double-apply.
 * That matters because `setOkuMYieldRateWithSuccessor` re-anchors the
 * multiplier from the current timestamp — applying it twice is not a no-op.
 */
export async function applyScheduleToChain(
  artifact: EpochScheduleArtifact,
  ctx: NetworkContext,
  signer: Signer,
  dryRun: boolean,
  applyRate: RateApplier = runSetOkuMYieldRate
): Promise<ApplyOutcome> {
  const existing = artifact.receipts[ctx.bookKey];
  if (existing && "txHash" in existing) {
    logger.info(`[${ctx.bookKey}] already confirmed (${existing.txHash}) — nothing to do`);
    return "already-confirmed";
  }

  logger.header(`Applying epoch ${artifact.epochId} to ${ctx.networkName}`);
  logger.info(`rate=${artifact.schedule.rate} end=${artifact.schedule.rateEnd}`);
  logger.info(`nextRate=${artifact.schedule.nextRate} nextEnd=${artifact.schedule.nextRateEnd}`);

  const result = await applyRate(ctx, signer, {
    mode: "withSuccessor",
    rate: BigInt(artifact.schedule.rate),
    endTimestamp: BigInt(artifact.schedule.rateEnd),
    nextRate: BigInt(artifact.schedule.nextRate),
    pendingEndTimestamp: BigInt(artifact.schedule.nextRateEnd),
    dryRun,
  });

  if (dryRun) {
    logger.success(`[${ctx.bookKey}] DRY_RUN — not recorded as a receipt`);
    return "dry-run";
  }

  artifact.receipts[ctx.bookKey] = {
    txHash: result.txHash ?? "unknown",
    confirmedAtSec: Math.floor(Date.now() / 1000),
  };
  saveArtifactInPlace(artifact);
  logger.success(`[${ctx.bookKey}] confirmed and recorded`);
  return "recorded";
}

if (require.main === module) {
  runMain(async () => {
    // Imported lazily so the exports above stay loadable outside a Hardhat run.
    const { ethers } = await import("hardhat");
    const { resolveNetworkContext } = await import("../utils/networkContext");

    const { epochId, phase, dryRun } = parseApplyArgs();

    const ctx = await resolveNetworkContext();
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun });
    const [signer] = await ethers.getSigners();

    const artifact = loadArtifact(epochId, phase);
    await applyScheduleToChain(artifact, ctx, signer, dryRun);
  });
}
