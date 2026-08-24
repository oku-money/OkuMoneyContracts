/**
 * Close a cross-chain multiplier sync window (`OKU_RATE_SETTER`).
 *
 * STEP 3 OF 3 in the multiplier-tick protocol — see `beginSyncWindow.ts`.
 *
 * Call this only once the tick has been confirmed landed on EVERY chain.
 * Closing early on one chain while another is still mid-write reopens exactly
 * the mispricing window the mechanism exists to prevent.
 *
 * `epoch` must equal the current `syncEpoch()`. That is deliberate: it makes a
 * stale or replayed release unable to close a window it never observed.
 *
 * Not strictly required — the window auto-expires after
 * `syncWindowDuration()` — but calling it restores mint/redeem immediately
 * instead of making users wait out the full window.
 *
 * Usage:
 *   npx hardhat run scripts/operator/endSyncWindow.ts --network base --yes-mainnet
 *   EPOCH=42 npx hardhat run scripts/operator/endSyncWindow.ts --network base
 *   DRY_RUN=true npx hardhat run scripts/operator/endSyncWindow.ts --network base
 *
 * Environment:
 *   EPOCH          Explicit tick number. Omit to use the current syncEpoch().
 *   DRY_RUN=true   Simulate without submitting
 *   --yes-mainnet  Required to broadcast on a mainnet network
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import { DRY_RUN, parseArg, runScript, setup, submit } from "./_shared";

async function main() {
  const { contract: token } = await setup("endSyncWindow", "OkuDollar");

  const currentEpoch: bigint = await (token as any).syncEpoch();
  const lockedUntil: bigint = await (token as any).syncLockedUntil();
  const locked: boolean = await (token as any).isSyncLocked();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

  const explicit = parseArg("epoch");
  const epoch = explicit !== undefined ? BigInt(explicit) : currentEpoch;

  logger.info(`syncEpoch:        ${currentEpoch}`);
  logger.info(`requested epoch:  ${epoch}${explicit === undefined ? " (auto)" : ""}`);
  logger.info(`currently locked: ${locked}`);
  if (lockedUntil > now) {
    logger.info(
      `would otherwise lift at ${new Date(Number(lockedUntil) * 1000).toISOString()} ` +
        `(${lockedUntil - now}s away)`
    );
  }

  if (epoch !== currentEpoch) {
    throw new Error(
      `PRE-CONDITION FAILED: epoch must equal syncEpoch() (${currentEpoch}), got ${epoch}. ` +
        `The equality check is what stops a stale release closing a window it never saw.`
    );
  }

  if (!locked) {
    logger.warning(
      "No window is currently open — this call will be a no-op in effect. " +
        "If you expected one to be open, the window may have already auto-expired, " +
        "which means the tick took longer than syncWindowDuration()."
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("endSyncWindow", () => (token as any).endSyncWindow(epoch));

  const stillLocked: boolean = await (token as any).isSyncLocked();
  if (stillLocked) {
    throw new Error(
      "POST-CONDITION FAILED: still sync-locked after endSyncWindow. " +
        "Mint/redeem remain blocked; investigate before retrying."
    );
  }

  logger.success(`Window closed for epoch ${epoch} — mint/redeem restored.`);
  logger.info("Verify cross-chain agreement with checkSyncParity.ts.");
}

runScript(main);
