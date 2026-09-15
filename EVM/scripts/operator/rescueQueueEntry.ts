/**
 * Rescue a stuck redemption-queue entry (QUEUE_RESCUER role required).
 *
 * Calls `RedemptionQueue.rescueQueueEntry(index, alternateRecipient)`,
 * which returns the OkuMoney for the entry to `alternateRecipient` and
 * clears the slot without burning. Use when an entry is permanently
 * unprocessable (e.g. the original user has been USDC-blacklisted).
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base INDEX=3 RECIPIENT=0x<rescueDestination> \
 *       npx hardhat run scripts/operator/rescueQueueEntry.ts --network base
 *
 * Environment:
 *   INDEX             Queue index to rescue (required)
 *   RECIPIENT         Address to receive the OkuM (required)
 *   DRY_RUN=true      Simulate without submitting
 *   YES_MAINNET=true  Required to broadcast on a mainnet network
 *
 * Also exported as `runRescueQueueEntry()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";

export interface RescueQueueEntryResult {
  txHash?: string;
}

export async function runRescueQueueEntry(
  ctx: NetworkContext,
  signer: Signer,
  index: bigint,
  recipient: string,
  dryRun = false
): Promise<RescueQueueEntryResult> {
  if (!ethers.isAddress(recipient)) throw new Error(`Invalid recipient: ${recipient}`);
  if (index < 0n) throw new Error("index must be >= 0");

  const queueAddr = loadAddress(ctx.bookKey, "RedemptionQueue");
  if (!queueAddr) throw new Error(`Missing RedemptionQueue in address book for ${ctx.bookKey}`);

  const queue = (await getDeployedContract("RedemptionQueue", queueAddr)).connect(signer);

  const head = await (queue as any).queueHead();
  const tail = await (queue as any).queueTail();
  logger.info(`Signer: ${await signer.getAddress()}`);
  logger.info(`Queue head/tail: ${head} / ${tail}`);
  logger.info(`Rescuing index ${index} -> ${recipient}`);

  if (index < BigInt(head) || index >= BigInt(tail)) {
    throw new Error(`index ${index} out of range [${head}, ${tail})`);
  }

  try {
    const entry = await (queue as any).getQueueEntry(index);
    logger.info(`Entry user: ${entry.user}`);
    logger.info(`Entry okuMAmount: ${ethers.formatUnits(entry.okuMAmount, 18)} OkuM`);
  } catch {
    logger.warning("getQueueEntry() not available; skipping pre-state read");
  }

  if (dryRun) {
    logger.success("DRY_RUN=true — not submitting");
    return {};
  }

  const tx = await (queue as any).rescueQueueEntry(index, recipient);
  const receipt = await tx.wait(1);
  logger.success(`rescueQueueEntry tx: ${receipt.hash}`);
  return { txHash: receipt.hash };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`rescueQueueEntry (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const indexStr = parseArg("index");
    const recipientStr = parseArg("recipient");
    if (!indexStr) throw new Error("Required: --index=<queue index>");
    if (!recipientStr) throw new Error("Required: --recipient=0x...");

    const [signer] = await ethers.getSigners();
    await runRescueQueueEntry(ctx, signer, BigInt(indexStr), recipientStr, isDryRun());
  });
}
