/**
 * Set the cross-chain sync window length (`OKU_CAP_MANAGER`, cold multisig).
 *
 * `0` disables the window entirely, which is the deployed default — the
 * mechanism ships audited but inert and is switched on once the cross-chain
 * tick cadence is settled.
 *
 * SIZING. This is a propagation budget, not an economic parameter. It needs to
 * outlast "the tick has landed on every chain", which the orchestrator confirms
 * explicitly via `endSyncWindow`; the configured value is only the fallback for
 * when that confirmation never arrives. Bounded by `MAX_SYNC_WINDOW`
 * (15 minutes) so no key — cold included — can turn it into an indefinite block.
 *
 * Do NOT reach for a longer window to deter step arbitrage. That attack does not
 * transact during the window, so length is irrelevant to it; the `tout` fee is
 * the control there (SVM only — EVM accrual is continuous and has no step).
 *
 * Usage:
 *   SECONDS=60 npx hardhat run scripts/operator/setSyncWindowDuration.ts --network base --yes-mainnet
 *   SECONDS=0  npx hardhat run scripts/operator/setSyncWindowDuration.ts --network base
 *
 * Environment:
 *   SECONDS        Required. Window length in seconds (0 = disabled).
 *   DRY_RUN=true   Simulate without submitting
 *   --yes-mainnet  Required to broadcast on a mainnet network
 */

import { logger } from "../utils/logger";
import { DRY_RUN, requireArg, runScript, setup, submit } from "./_shared";

const MAX_SYNC_WINDOW = 15n * 60n;

async function main() {
  const { contract: token } = await setup("setSyncWindowDuration", "OkuDollar");

  const seconds = BigInt(requireArg("seconds"));
  const current: bigint = await (token as any).syncWindowDuration();
  const locked: boolean = await (token as any).isSyncLocked();

  logger.info(`current duration: ${current}s`);
  logger.info(`new duration:     ${seconds}s`);

  if (seconds > MAX_SYNC_WINDOW) {
    throw new Error(
      `${seconds}s exceeds MAX_SYNC_WINDOW (${MAX_SYNC_WINDOW}s). This bound is a ` +
        `compile-time constant and cannot be raised by any key.`
    );
  }

  if (seconds === 0n && current !== 0n) {
    logger.warning(
      "Disabling the sync window. Cross-chain ticks will no longer gate mint/redeem, " +
        "so a tick that lands unevenly across chains becomes exploitable for the " +
        "duration of the divergence."
    );
  }

  if (locked) {
    logger.warning(
      "A window is currently OPEN. Changing the duration does not alter the live " +
        "window — it only affects windows armed after this call."
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("setSyncWindowDuration", () => (token as any).setSyncWindowDuration(seconds));

  const updated: bigint = await (token as any).syncWindowDuration();
  if (updated !== seconds) {
    throw new Error(`POST-CONDITION FAILED: duration is ${updated}, expected ${seconds}`);
  }
  logger.success(`syncWindowDuration = ${updated}s`);
  logger.warning("Apply the SAME value on every chain so tick windows are symmetric.");
}

runScript(main);
