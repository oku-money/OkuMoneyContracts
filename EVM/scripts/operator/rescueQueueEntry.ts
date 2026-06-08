/**
 * Rescue a stuck redemption-queue entry (QUEUE_RESCUER role required).
 *
 * Calls `RedemptionQueue.rescueQueueEntry(index, alternateRecipient)`,
 * which returns the OkuMoney for the entry to `alternateRecipient` and
 * clears the slot without burning. Use when an entry is permanently
 * unprocessable (e.g. the original user has been USDC-blacklisted).
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/rescueQueueEntry.ts --network base \
 *       --index 3 --recipient 0x<rescueDestination>
 *
 * Environment:
 *   INDEX          Queue index to rescue (alternative to --index)
 *   RECIPIENT      Address to receive the OkuM (alternative to --recipient)
 *   DRY_RUN=true   Simulate without submitting
 *   --yes-mainnet  Required to broadcast on a mainnet network
 */

import { ethers } from "hardhat";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : process.env[name.toUpperCase().replace(/-/g, "_")];
}

const YES_MAINNET = process.argv.includes("--yes-mainnet");
const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`rescueQueueEntry (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const indexStr = parseArg("index") ?? parseArg("INDEX");
  const recipientStr = parseArg("recipient") ?? parseArg("RECIPIENT");
  if (!indexStr) throw new Error("Required: --index=<queue index>");
  if (!recipientStr) throw new Error("Required: --recipient=0x...");
  if (!ethers.isAddress(recipientStr)) throw new Error(`Invalid --recipient: ${recipientStr}`);

  const index = BigInt(indexStr);
  if (index < 0n) throw new Error("--index must be >= 0");

  const queueAddr = loadAddress(ctx.bookKey, "RedemptionQueue");
  if (!queueAddr) throw new Error(`Missing RedemptionQueue in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const queue = (await getDeployedContract("RedemptionQueue", queueAddr)).connect(signer);

  const head = await (queue as any).queueHead();
  const tail = await (queue as any).queueTail();
  logger.info(`Signer: ${await signer.getAddress()}`);
  logger.info(`Queue head/tail: ${head} / ${tail}`);
  logger.info(`Rescuing index ${index} -> ${recipientStr}`);

  if (index < BigInt(head) || index >= BigInt(tail)) {
    throw new Error(`--index ${index} out of range [${head}, ${tail})`);
  }

  // Best-effort read of the entry; some impls expose getQueueEntry().
  try {
    const entry = await (queue as any).getQueueEntry(index);
    logger.info(`Entry user: ${entry.user}`);
    logger.info(`Entry okuMAmount: ${ethers.formatUnits(entry.okuMAmount, 18)} OkuM`);
  } catch {
    logger.warning("getQueueEntry() not available; skipping pre-state read");
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (queue as any).rescueQueueEntry(index, recipientStr);
  const receipt = await tx.wait(1);
  logger.success(`rescueQueueEntry tx: ${receipt.hash}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
