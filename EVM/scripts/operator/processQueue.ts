/**
 * Process the LitePSM redemption queue (PSM_QUEUE_PROCESSOR role required).
 *
 * Calls `LitePSM.processQueue(startIndex, endIndex, approveAmount)` in
 * configurable batch sizes, looping until the queue is empty or a --limit is
 * reached. Reads queue state on-chain before each batch.
 *
 * After each `processQueue` call this script also calls
 * `RedemptionQueue.advanceHead(maxSlots)` to drive `queueHead` forward past
 * the now-cleared slots — `processQueue` no longer auto-advances the cursor,
 * so the next iteration's pending-count check needs the explicit advance to
 * see an accurate count.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/processQueue.ts --network base
 *   NETWORK=base npx hardhat run scripts/operator/processQueue.ts --network base \
 *       --batch-size 25 --limit 3    # up to 3 batches of 25 entries
 *   DRY_RUN=true NETWORK=base npx hardhat run scripts/operator/processQueue.ts --network base
 *
 * Environment:
 *   DRY_RUN=true   Print intent without submitting
 *   BATCH_SIZE     Entries per processQueue call (default 50)
 *   LIMIT          Maximum number of batches (default unlimited)
 */

import { ethers } from "hardhat";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : process.env[name.toUpperCase().replace(/-/g, '_')];
}

const YES_MAINNET = process.argv.includes("--yes-mainnet");
const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`processQueue (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const batchSize = parseInt(parseArg("batch-size") ?? process.env.BATCH_SIZE ?? "50", 10);
  const limit = parseInt(parseArg("limit") ?? process.env.LIMIT ?? "1000", 10);
  if (batchSize < 1 || batchSize > 200) throw new Error("--batch-size must be 1–200");

  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  const queueAddr = loadAddress(ctx.bookKey, "RedemptionQueue");
  const usdcAddr = loadAddress(ctx.bookKey, "MockUSDC") ?? loadAddress(ctx.bookKey, "USDC");
  if (!psmAddr || !queueAddr || !usdcAddr) {
    throw new Error(`Missing LitePSM/RedemptionQueue/USDC in address book for ${ctx.bookKey}`);
  }

  const [signer] = await ethers.getSigners();
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
      return;
    }

    const thisBatch = pending > BigInt(batchSize) ? BigInt(batchSize) : pending;
    const endIndex = head + thisBatch;
    const psmUsdcBalance = await usdc.balanceOf(psmAddr);

    logger.info(`Batch ${i + 1}: head=${head} end=${endIndex} pending=${pending} buffer=${Number(psmUsdcBalance) / 1e6} USDC`);

    if (DRY_RUN) {
      logger.success("DRY_RUN=true — would call processQueue(" + head + ", " + endIndex + ", " + psmUsdcBalance + ")");
      totalDrained += Number(thisBatch);
      batches++;
      break;
    }

    const tx = await (psm as any).processQueue(head, endIndex, psmUsdcBalance);
    const receipt = await tx.wait(1);
    logger.success(`Batch ${i + 1} tx: ${receipt.hash} (${thisBatch} entries)`);

    // processQueue no longer auto-advances queueHead. Advance the cursor so the
    // next iteration sees an accurate pending count (and the loop's `pending == 0`
    // exit condition can actually fire).
    const advTx = await (queue as any).advanceHead(thisBatch);
    await advTx.wait(1);

    totalDrained += Number(thisBatch);
    batches++;
  }

  const head = await (queue as any).queueHead();
  const tail = await (queue as any).queueTail();
  logger.info(`Final queue state: head=${head} tail=${tail} remaining=${tail - head}`);
  logger.success(`Done: ${batches} batch(es), ${totalDrained} entries processed.`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { logger.error(e.message ?? String(e)); process.exit(1); });
