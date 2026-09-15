/**
 * Process the LitePSM redemption queue (PSM_QUEUE_PROCESSOR role required).
 *
 * Calls `LitePSM.processQueue(startIndex, endIndex, approveAmount)` in
 * configurable batch sizes, looping until the queue is empty or a --limit is
 * reached. Also calls `RedemptionQueue.advanceHead(maxSlots)` after each batch
 * — `processQueue` no longer auto-advances the cursor, so the next
 * iteration's pending-count check needs the explicit advance.
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base BATCH_SIZE=25 LIMIT=3 \
 *       npx hardhat run scripts/operator/processQueue.ts --network base
 *
 * Environment:
 *   DRY_RUN=true      Print intent without submitting
 *   BATCH_SIZE        Entries per processQueue call (default 50)
 *   LIMIT             Maximum number of batches (default unlimited)
 *   YES_MAINNET=true  Required to broadcast on a mainnet network
 *
 * Also exported as `runProcessQueue()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";

export interface ProcessQueueResult {
  batches: number;
  totalDrained: number;
  finalHead: bigint;
  finalTail: bigint;
}

export async function runProcessQueue(
  ctx: NetworkContext,
  signer: Signer,
  opts: { batchSize?: number; limit?: number; dryRun?: boolean } = {}
): Promise<ProcessQueueResult> {
  const batchSize = opts.batchSize ?? 50;
  const limit = opts.limit ?? 1000;
  const dryRun = opts.dryRun ?? false;
  if (batchSize < 1 || batchSize > 200) throw new Error("batchSize must be 1-200");

  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  const queueAddr = loadAddress(ctx.bookKey, "RedemptionQueue");
  const usdcAddr = loadAddress(ctx.bookKey, "MockUSDC") ?? loadAddress(ctx.bookKey, "USDC");
  if (!psmAddr || !queueAddr || !usdcAddr) {
    throw new Error(`Missing LitePSM/RedemptionQueue/USDC in address book for ${ctx.bookKey}`);
  }

  const psm = (await getDeployedContract("LitePSM", psmAddr)).connect(signer);
  const queue = (await getDeployedContract("RedemptionQueue", queueAddr)).connect(signer);
  const usdc = (await ethers.getContractAt("IERC20", usdcAddr)).connect(signer);

  let totalDrained = 0;
  let batches = 0;

  for (let i = 0; i < limit; i++) {
    const head = await (queue as any).queueHead();
    const tail = await (queue as any).queueTail();
    const pending = tail - head;
    if (pending.toString() === "0") {
      logger.success(`Queue empty after ${batches} batch(es), ${totalDrained} entries drained.`);
      return { batches, totalDrained, finalHead: head, finalTail: tail };
    }

    const thisBatch = pending > BigInt(batchSize) ? BigInt(batchSize) : pending;
    const endIndex = head + thisBatch;
    const psmUsdcBalance = await usdc.balanceOf(psmAddr);

    logger.info(`Batch ${i + 1}: head=${head} end=${endIndex} pending=${pending} buffer=${Number(psmUsdcBalance) / 1e6} USDC`);

    if (dryRun) {
      logger.success(`DRY_RUN=true — would call processQueue(${head}, ${endIndex}, ${psmUsdcBalance})`);
      totalDrained += Number(thisBatch);
      batches++;
      break;
    }

    const tx = await (psm as any).processQueue(head, endIndex, psmUsdcBalance);
    const receipt = await tx.wait(1);
    logger.success(`Batch ${i + 1} tx: ${receipt.hash} (${thisBatch} entries)`);

    const advTx = await (queue as any).advanceHead(thisBatch);
    await advTx.wait(1);

    totalDrained += Number(thisBatch);
    batches++;
  }

  const finalHead = await (queue as any).queueHead();
  const finalTail = await (queue as any).queueTail();
  logger.info(`Final queue state: head=${finalHead} tail=${finalTail} remaining=${finalTail - finalHead}`);
  logger.success(`Done: ${batches} batch(es), ${totalDrained} entries processed.`);
  return { batches, totalDrained, finalHead, finalTail };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`processQueue (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const batchSize = parseInt(parseArg("batch-size") ?? "50", 10);
    const limit = parseInt(parseArg("limit") ?? "1000", 10);

    const [signer] = await ethers.getSigners();
    await runProcessQueue(ctx, signer, { batchSize, limit, dryRun: isDryRun() });
  });
}
