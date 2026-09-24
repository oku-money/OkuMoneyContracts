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
 */

import { ethers } from "hardhat";
import { resolveNetworkContext } from "../utils/networkContext";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { isYesMainnet, isDryRun, parseArg, runMain } from "../utils/cli";
import { runSetOkuMYieldRate } from "./setOkuMYieldRate";
import { loadArtifact, saveArtifactInPlace, EpochPhase } from "../utils/epochArtifact";

if (require.main === module) {
  runMain(async () => {
    const epochId = parseArg("epochId");
    const phase = parseArg("phase") as EpochPhase | undefined;
    if (!epochId) throw new Error("Required: --epochId=<id> (env: EPOCH_ID)");
    if (phase !== "stage-settlement" && phase !== "roll-epoch") {
      throw new Error("Required: --phase=stage-settlement|roll-epoch (env: PHASE)");
    }
    const dryRun = isDryRun();

    const ctx = await resolveNetworkContext();
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun });
    const [signer] = await ethers.getSigners();

    const artifact = loadArtifact(epochId, phase);
    const existing = artifact.receipts[ctx.bookKey];
    if (existing && "txHash" in existing) {
      logger.info(`[${ctx.bookKey}] already confirmed (${existing.txHash}) — nothing to do`);
      return;
    }

    logger.header(`Applying epoch ${epochId} to ${ctx.networkName}`);
    logger.info(`rate=${artifact.schedule.rate} end=${artifact.schedule.rateEnd}`);
    logger.info(`nextRate=${artifact.schedule.nextRate} nextEnd=${artifact.schedule.nextRateEnd}`);

    const result = await runSetOkuMYieldRate(ctx, signer, {
      mode: "withSuccessor",
      rate: BigInt(artifact.schedule.rate),
      endTimestamp: BigInt(artifact.schedule.rateEnd),
      nextRate: BigInt(artifact.schedule.nextRate),
      pendingEndTimestamp: BigInt(artifact.schedule.nextRateEnd),
      dryRun,
    });

    if (dryRun) {
      logger.success(`[${ctx.bookKey}] DRY_RUN — not recorded as a receipt`);
      return;
    }

    artifact.receipts[ctx.bookKey] = {
      txHash: result.txHash ?? "unknown",
      confirmedAtSec: Math.floor(Date.now() / 1000),
    };
    saveArtifactInPlace(artifact);
    logger.success(`[${ctx.bookKey}] confirmed and recorded`);
  });
}
