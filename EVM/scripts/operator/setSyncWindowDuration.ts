/**
 * Set the post-step sync window length on OkuM (`OKU_CAP_MANAGER`, cold).
 *
 * Calls `OkuM.setSyncWindowDuration(seconds)`. `0` makes the mechanism inert.
 *
 * DEPLOYMENTS NOW SHIP WITH THE WINDOW ON — `Constants.DEFAULT_SYNC_WINDOW` is
 * 60 seconds, written at `initialize`. That reversed the v0.3 default of 0. A
 * zero default left the protection installed but dormant, and therefore
 * dependent on someone remembering to enable it, which is exactly the class of
 * dependency the auto-arming design exists to remove.
 *
 * THERE IS NO BEGIN/END PROTOCOL ANY MORE. Every `setOkuMultiplier` write arms a
 * window of this length automatically, and it expires unaided. v0.3's
 * `beginSyncWindow.ts` / `endSyncWindow.ts` are deleted along with the
 * instructions they called, and there is no epoch counter: cross-chain parity is
 * verified off-chain by comparing multiplier VALUES, which is strictly stronger
 * than the equal-epoch check it replaces (equal epochs never proved equal
 * values). So this number is the ONLY knob on the mechanism.
 *
 * SIZING. It is a cross-chain propagation budget, not an economic parameter. It
 * needs to cover the interval between the first chain's multiplier write and the
 * last's — nothing more. Bounded by MAX_SYNC_WINDOW (15 minutes), so no key,
 * cold included, can turn it into an indefinite pause held below the
 * PSM_UNPAUSER threshold.
 *
 * WHAT IT BLOCKS WHILE ENGAGED: `SubscriptionModule.mint`, `redeem`,
 * `redeemUiAmount`, `processQueue`, and the wrapper's `wrap` / `unwrap`. The
 * gating rule is exactly "an operation is gated iff it prices through the
 * multiplier", which is why `depositBuffer`, `withdrawUsdc` and `advanceHead`
 * are exempt: they move value at par or move none.
 *
 * DO NOT REACH FOR A LONGER WINDOW TO DETER STEP ARBITRAGE. That attack holds
 * raw OkuM across a step and needs no transaction while the window is open, so
 * length is irrelevant to it. The control is step coverage — `tin + tout >=
 * stepBps`, enforced by `setOkuMultiplier` itself (setFees.ts).
 *
 * Usage:
 *   SECONDS=60 npx hardhat run scripts/operator/setSyncWindowDuration.ts --network base --yes-mainnet
 *   SECONDS=0  npx hardhat run scripts/operator/setSyncWindowDuration.ts --network base
 *
 * Environment:
 *   SECONDS        Required. Window length in seconds (0 = inert).
 *   DRY_RUN=true   Simulate without submitting
 *   --yes-mainnet  Required to broadcast on a mainnet network
 */

import { logger } from "../utils/logger";
import {
  DRY_RUN,
  MAX_SYNC_WINDOW_SECONDS,
  requireArg,
  runScript,
  setup,
  submit,
} from "./_shared";

async function main() {
  const { contract: okuM } = await setup("setSyncWindowDuration", "OkuM");

  const seconds = BigInt(requireArg("seconds"));
  const current: bigint = await (okuM as any).syncWindowDuration();
  const locked: boolean = await (okuM as any).isSyncLocked();
  const lockedUntil: bigint = await (okuM as any).syncLockedUntil();

  logger.info("");
  logger.info(`current duration: ${current}s`);
  logger.info(`new duration:     ${seconds}s`);
  logger.info(`currently locked: ${locked}`);
  if (lockedUntil > 0n) {
    logger.info(
      `last armed until: ${new Date(Number(lockedUntil) * 1000).toISOString()}`
    );
  }

  if (seconds > MAX_SYNC_WINDOW_SECONDS) {
    throw new Error(
      `${seconds}s exceeds MAX_SYNC_WINDOW (${MAX_SYNC_WINDOW_SECONDS}s); the ` +
        `contract reverts SyncWindowTooLong. This bound is a compile-time constant ` +
        `and cannot be raised by any key — it is the liveness backstop that stops ` +
        `the mechanism becoming an indefinite pause.`
    );
  }

  if (seconds === 0n && current !== 0n) {
    logger.warning(
      "Disabling the window. Multiplier steps will land UNFENCED: for the interval " +
        "between this chain's write and the last chain's, the two sides price a raw " +
        "OkuM differently, and anything converting value through the multiplier in " +
        "that window settles at a stale price on one side. Only correct on a " +
        "single-chain deployment."
    );
  }
  if (seconds !== 0n && current === 0n) {
    logger.info(
      "Enabling the window. It takes effect on the NEXT step, not retroactively."
    );
  }

  if (locked) {
    logger.warning(
      "A window is currently ENGAGED. Changing the duration does not alter the live " +
        "window — `lockedUntil` was already written — it only affects windows armed " +
        "after this call. Shortening it will not release the current lock early; " +
        "there is no close instruction, deliberately."
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("setSyncWindowDuration", () => (okuM as any).setSyncWindowDuration(seconds));

  const updated: bigint = await (okuM as any).syncWindowDuration();
  if (updated !== seconds) {
    throw new Error(`POST-CONDITION FAILED: duration is ${updated}, expected ${seconds}`);
  }
  logger.success(`syncWindowDuration = ${updated}s`);
  logger.warning(
    "Apply the SAME value on every chain so the fences around one orchestrator tick " +
      "are symmetric."
  );
}

runScript(main);
