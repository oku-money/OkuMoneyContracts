/**
 * Rescue a stuck redemption-queue entry (QUEUE_RESCUER role required).
 *
 * Calls `RedemptionQueue.rescueQueueEntry(index, alternateRecipient)`, which
 * returns the escrowed OkuM for the entry to `alternateRecipient` and clears the
 * slot WITHOUT burning. Use when an entry is permanently unprocessable — e.g.
 * the original user has been USDC-blacklisted, so `processQueue` can never
 * deliver their payout and soft-skips them forever.
 *
 * This returns SHARES, not dollars: the entry's raw OkuM comes back at whatever
 * `M_oku` is now, which is worth more than when it was queued. No double spend
 * is possible — the entry is cleared and its escrow released in the same call.
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
import { resolveOperatorSigner } from "./_shared";

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

  // Signer resolution goes through the shared helper rather than
  // `getSigners()[0]`: on a fork the mnemonic accounts hold no roles, so every
  // privileged call here would revert AccessControlUnauthorizedAccount against
  // a correctly-wired deployment. On a live network the helper returns the same
  // PRIVATE_KEY signer, so behaviour there is unchanged.
  const signer = await resolveOperatorSigner(ctx.isFork);
  const queue = (await getDeployedContract("RedemptionQueue", queueAddr)).connect(signer);

  const head = await (queue as any).queueHead();
  const tail = await (queue as any).queueTail();
  logger.info(`Signer: ${await signer.getAddress()}`);
  logger.info(`Queue head/tail: ${head} / ${tail}`);
  logger.info(`Rescuing index ${index} -> ${recipientStr}`);

  if (index < BigInt(head) || index >= BigInt(tail)) {
    throw new Error(`--index ${index} out of range [${head}, ${tail})`);
  }

  // Pre-state read. `getQueueEntryValue` is a CONSERVATIVE FLOOR on the payout,
  // not the exact settlement amount: it applies the entry's snapshotted `tout`,
  // whereas settlement charges `min(snapshot, live)`. Erring low is correct for
  // a quote — a holder is never told to expect more than they get.
  try {
    const entry = await (queue as any).getQueueEntry(index);
    logger.info(`Entry user:      ${entry.user}`);
    logger.info(`Entry rawAmount: ${ethers.formatUnits(entry.rawAmount, 18)} OkuM`);
    logger.info(`Entry toutBps:   ${entry.toutBps} (snapshotted at enqueue)`);
    logger.info(
      `Queued at:       ${new Date(Number(entry.timestamp) * 1000).toISOString()}`
    );
    const okuMAddr: string = await (queue as any).okuM();
    const okuM = await ethers.getContractAt("OkuM", okuMAddr);
    logger.info(
      `Current UI value: $${ethers.formatEther(await (okuM as any).toUIAmount(entry.rawAmount))} ` +
        `(appreciated with M_oku while queued)`
    );
  } catch (e: any) {
    logger.warning(`Pre-state read failed (${e?.message?.slice(0, 80) ?? e}); continuing`);
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
