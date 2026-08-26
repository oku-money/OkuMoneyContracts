/**
 * Process the redemption queue (PSM_QUEUE_PROCESSOR role required).
 *
 * Calls `SubscriptionModule.processQueue(startIndex, endIndex, approveAmount)`
 * in configurable batch sizes, looping until the queue is empty or a --limit is
 * reached. Reads queue state on-chain before each batch.
 *
 * NOT blocked by pause — pause must not lock users into the queue — but IS
 * blocked by the post-step sync window, and the distinction is the point. Pause
 * is unbounded and incident-driven, so gating on it could strand redeemers
 * indefinitely; the sync window is bounded by MAX_SYNC_WINDOW (15 minutes), and
 * leaving it open would be a real hole because the queue prices at the live
 * `M_oku` (cached once per batch) and would otherwise settle mid-propagation.
 *
 * Settlement charges each entry the LOWER of the `tout` snapshotted when it was
 * enqueued and the `tout` in force now, so a fee cut is passed on to people
 * already waiting and a fee rise cannot reach them.
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
import { resolveOperatorSigner } from "./_shared";

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

  const psmAddr = loadAddress(ctx.bookKey, "SubscriptionModule");
  const queueAddr = loadAddress(ctx.bookKey, "RedemptionQueue");
  const usdcAddr = loadAddress(ctx.bookKey, "MockUSDC") ?? loadAddress(ctx.bookKey, "USDC");
  if (!psmAddr || !queueAddr || !usdcAddr) {
    throw new Error(
      `Missing SubscriptionModule/RedemptionQueue/USDC in address book for ${ctx.bookKey}`
    );
  }

  // Signer resolution goes through the shared helper rather than
  // `getSigners()[0]`: on a fork the mnemonic accounts hold no roles, so every
  // privileged call here would revert AccessControlUnauthorizedAccount against
  // a correctly-wired deployment. On a live network the helper returns the same
  // PRIVATE_KEY signer, so behaviour there is unchanged.
  const signer = await resolveOperatorSigner(ctx.isFork);
  const psm = (await getDeployedContract("SubscriptionModule", psmAddr)).connect(signer);
  const queue = (await getDeployedContract("RedemptionQueue", queueAddr)).connect(signer);
  const usdc = (await ethers.getContractAt("IERC20", usdcAddr)).connect(signer);

  // `RedemptionQueue` is the one contract name that survived the v0.3 -> v0.4
  // rename unchanged, so a stale address-book entry attaches cleanly to a
  // RETIRED v0.3 queue and then processes against the wrong token. Cross-check
  // the pairing before touching anything.
  const queueOkuM: string = await (queue as any).okuM();
  const moduleOkuM: string = await (psm as any).okuM();
  if (queueOkuM.toLowerCase() !== moduleOkuM.toLowerCase()) {
    throw new Error(
      `Queue/module disagree on the token: queue.okuM()=${queueOkuM}, ` +
        `module.okuM()=${moduleOkuM}. One of the two address-book entries is stale.`
    );
  }

  // NOTE: the sync window no longer blocks processQueue, and this script no
  // longer refuses to run while one is open. Queued users were being delayed for
  // a price that was already correct: the queue prices at this chain's own
  // `M_oku`, and a peer chain's in-flight mark does not make that wrong.

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

    // Snapshotted for the no-progress check below. `totalQueuedRaw` is the
    // honest measure of work done: `queueHead` also moves when `advanceHead`
    // walks past slots that were already cleared (by a rescue, say), so a
    // head-only check would read a cleanup as progress.
    const queuedBefore: bigint = await (queue as any).totalQueuedRaw();

    const tx = await (psm as any).processQueue(head, endIndex, psmUsdcBalance);
    const receipt = await tx.wait(1);
    logger.success(`Batch ${i + 1} tx: ${receipt.hash} (${thisBatch} entries)`);

    // processQueue no longer auto-advances queueHead. Advance the cursor so the
    // next iteration sees an accurate pending count (and the loop's `pending == 0`
    // exit condition can actually fire).
    const advTx = await (queue as any).advanceHead(thisBatch);
    await advTx.wait(1);

    // NO-PROGRESS BAILOUT. `processQueue` soft-skips a cleared entry and BREAKS
    // on insufficient funds — in both cases the tx succeeds while clearing
    // nothing. Without this check the loop happily burns `--limit` (default
    // 1000) transactions re-attempting a head entry the buffer cannot cover,
    // which on a live network is real money for zero effect.
    //
    // `head` not advancing is not sufficient on its own to conclude failure
    // (a batch can clear entries behind an uncleared head), hence the pair.
    const queuedAfter: bigint = await (queue as any).totalQueuedRaw();
    const newHead = await (queue as any).queueHead();
    if (queuedAfter === queuedBefore && newHead === head) {
      const owed: bigint = await (queue as any).totalQueuedUsdc();
      const buffer: bigint = await usdc.balanceOf(psmAddr);
      logger.warning(
        `Batch ${i + 1} cleared nothing and the cursor did not move — stopping ` +
          `rather than retrying. Almost always the buffer: the head entry's payout ` +
          `exceeds the ${Number(buffer) / 1e6} USDC available, so processQueue hit ` +
          `InsufficientFunds and broke. Total owed across the queue is up to ` +
          `${Number(owed) / 1e6} USDC (fee-free, so an upper bound). Top up with ` +
          `depositBuffer.ts and re-run.\n` +
          `  The other possibility is a stuck recipient (e.g. USDC-blacklisted), ` +
          `which soft-skips forever — check the RedemptionSkipped events on tx ` +
          `${receipt.hash} and use rescueQueueEntry.ts if so.`
      );
      break;
    }

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
