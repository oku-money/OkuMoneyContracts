/**
 * Open a cross-chain multiplier sync window (`OKU_RATE_SETTER`).
 *
 * STEP 1 OF 3 in the multiplier-tick protocol:
 *
 *   1. beginSyncWindow(N)  on EVERY chain      <- this script
 *   2. setYieldRate (EVM) / set_multiplier (SVM) on every chain
 *   3. endSyncWindow(N)    on EVERY chain      <- endSyncWindow.ts
 *
 * WHY. A multiplier tick is not atomic across chains. Between the EVM write and
 * the SVM write the two sides price a raw token differently, so anything that
 * converts value through the multiplier in that interval settles at a stale
 * price on one side. While the window is open, `LitePSM.mint`, `redeem`,
 * `redeemUiAmount` and `processQueue` all revert.
 *
 * WHAT THIS IS NOT. It is not a pause and it is not a defence against holding
 * raw across a discrete multiplier step. On EVM there is no such step (accrual
 * is continuous); on SVM the `tout` fee is what handles that. Widening this
 * window does not deter a hold-across-the-step attacker — they never transact
 * while it is open.
 *
 * EPOCH. `epoch` must be exactly `syncEpoch() + 1`, and the SAME number must be
 * used on every chain for this tick. That is what makes
 * `syncEpoch()_evm == sync_epoch_svm` a meaningful "no tick in flight" check —
 * verify it with `checkSyncParity.ts` before and after.
 *
 * SAFETY. The window auto-expires after `syncWindowDuration()` (bounded by
 * `MAX_SYNC_WINDOW`), so forgetting step 3 delays users rather than stranding
 * them. `MIN_SYNC_WINDOW_GAP` between windows bounds the duty cycle.
 *
 * Usage:
 *   npx hardhat run scripts/operator/beginSyncWindow.ts --network base --yes-mainnet
 *   EPOCH=42 npx hardhat run scripts/operator/beginSyncWindow.ts --network base
 *   DRY_RUN=true npx hardhat run scripts/operator/beginSyncWindow.ts --network base
 *
 * Environment:
 *   EPOCH          Explicit tick number. Omit to use syncEpoch() + 1.
 *   DRY_RUN=true   Simulate without submitting
 *   --yes-mainnet  Required to broadcast on a mainnet network
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import { DRY_RUN, parseArg, runScript, setup, submit } from "./_shared";

async function main() {
  const { contract: token } = await setup("beginSyncWindow", "OkuDollar");

  const duration: bigint = await (token as any).syncWindowDuration();
  const currentEpoch: bigint = await (token as any).syncEpoch();
  const lockedUntil: bigint = await (token as any).syncLockedUntil();
  const locked: boolean = await (token as any).isSyncLocked();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

  const explicit = parseArg("epoch");
  const epoch = explicit !== undefined ? BigInt(explicit) : currentEpoch + 1n;

  logger.info(`syncEpoch:           ${currentEpoch}`);
  logger.info(`requested epoch:     ${epoch}${explicit === undefined ? " (auto)" : ""}`);
  logger.info(`syncWindowDuration:  ${duration}s`);
  logger.info(`currently locked:    ${locked}`);

  if (duration === 0n) {
    logger.warning(
      "syncWindowDuration is 0 — the window mechanism is INERT. This call will " +
        "advance the epoch but block nothing. Set a duration with " +
        "setSyncWindowDuration.ts first if you intend to gate the tick."
    );
  }

  if (epoch !== currentEpoch + 1n) {
    throw new Error(
      `PRE-CONDITION FAILED: epoch must be exactly syncEpoch() + 1 ` +
        `(${currentEpoch + 1n}), got ${epoch}. Strict succession is what keeps the ` +
        `cross-chain parity check meaningful.`
    );
  }

  if (locked) {
    throw new Error(
      `A window is already open until ${new Date(Number(lockedUntil) * 1000).toISOString()}. ` +
        `Close it with endSyncWindow.ts (epoch ${currentEpoch}) or wait for expiry.`
    );
  }

  // Mirror the on-chain gap rule so the failure is legible rather than a revert.
  const MIN_GAP = 6n * 60n * 60n;
  if (lockedUntil !== 0n && now < lockedUntil + MIN_GAP) {
    const earliest = new Date(Number(lockedUntil + MIN_GAP) * 1000).toISOString();
    throw new Error(
      `MIN_SYNC_WINDOW_GAP has not elapsed. Earliest next open: ${earliest}. ` +
        `This bound is what guarantees the redemption-availability floor.`
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("beginSyncWindow", () => (token as any).beginSyncWindow(epoch));

  const newLockedUntil: bigint = await (token as any).syncLockedUntil();
  const newEpoch: bigint = await (token as any).syncEpoch();

  logger.success(`Window open for epoch ${newEpoch}`);
  logger.info(`Lifts at ${new Date(Number(newLockedUntil) * 1000).toISOString()} (auto-expiry)`);
  logger.warning(
    `NEXT: write the multiplier on every chain with THE SAME epoch (${newEpoch}), ` +
      `then run endSyncWindow.ts --epoch=${newEpoch} on every chain.`
  );
}

runScript(main);
