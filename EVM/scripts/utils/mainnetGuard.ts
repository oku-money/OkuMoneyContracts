/**
 * Shared mainnet guard for operator scripts.
 *
 * Usage:
 *   import { mainnetGuard } from "../utils/mainnetGuard";
 *   mainnetGuard(ctx.networkName, { yesMainnet: process.argv.includes("--yes-mainnet"), dryRun: DRY_RUN });
 */

import { logger } from "./logger";

const MAINNET_NETWORKS = new Set(["base", "bsc", "mainnet", "ethereum"]);

export interface GuardOptions {
  /** Pass true if --yes-mainnet flag was supplied. */
  yesMainnet?: boolean;
  /** DRY_RUN=true is always safe; skip the gate. */
  dryRun?: boolean;
}

/**
 * Throw if networkName is a production network unless --yes-mainnet is passed.
 * Warn but allow when yesMainnet=true or dryRun=true.
 */
export function mainnetGuard(networkName: string, opts: GuardOptions = {}): void {
  if (!MAINNET_NETWORKS.has(networkName)) return;
  if (opts.dryRun) {
    logger.warning(`DRY_RUN on mainnet network ${networkName} — review carefully before live use.`);
    return;
  }
  if (opts.yesMainnet) {
    logger.warning(`--yes-mainnet passed; proceeding on ${networkName}.`);
    return;
  }
  throw new Error(
    `Refusing to broadcast on ${networkName}. Set YES_MAINNET=true to confirm, ` +
      `or DRY_RUN=true to simulate.\n` +
      `  (Use the env var, not --yes-mainnet: \`hardhat run\` rejects unknown ` +
      `CLI flags with HH305 before the script ever runs.)`
  );
}
