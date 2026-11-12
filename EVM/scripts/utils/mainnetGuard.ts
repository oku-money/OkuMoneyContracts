/**
 * Shared mainnet guard for operator scripts.
 *
 * Usage:
 *   import { mainnetGuard } from "../utils/mainnetGuard";
 *   mainnetGuard(ctx.networkName, { yesMainnet: process.argv.includes("--yes-mainnet"), dryRun: DRY_RUN });
 */

import { logger } from "./logger";
import { isEvmMainnet } from "@okumoney/yield-tooling";
import { isYesMainnet } from "./cli";

/**
 * Re-exported from `@okumoney/yield-tooling` so the EVM and SVM gates share one
 * definition. Every mainnet gate in this package must consume this rather than
 * redeclare a set of its own.
 */
export { EVM_MAINNET_NETWORKS as MAINNET_NETWORKS, isEvmMainnet as isMainnetNetwork } from "@okumoney/yield-tooling";

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
  if (!isEvmMainnet(networkName)) return;
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

/**
 * Mainnets on which an INTERNAL TEST deployment may opt out of the production
 * posture (closed PSM minting, no direct operator grants). A fixed allow-list on
 * purpose: the production chains (ethereum, base, optimism) can never be switched
 * into testnet behaviour by an env var.
 */
export const INTERNAL_TESTING_MAINNETS = ["bsc", "arbitrum"] as const;

/**
 * `true` when `INTERNAL_TESTING_MAINNET=true` is set AND `networkName` is one of
 * {@link INTERNAL_TESTING_MAINNETS}. Such a deployment behaves like the testnets:
 * the deploy script opens PSM minting with the testnet allowance, and
 * `grantRoles.ts` may grant the operational role set to MASTER_EOA. The deployer
 * keeps `DEFAULT_ADMIN_ROLE` and can revoke everything that script grants.
 *
 * This is NOT a substitute for the mainnet confirmation: callers must still pass
 * `mainnetGuard` (YES_MAINNET) / see {@link isInternalTestingMainnetConfirmed}.
 * Never set it for a deployment that is meant to carry real funds.
 */
export function isInternalTestingMainnet(networkName: string): boolean {
  return (
    process.env.INTERNAL_TESTING_MAINNET === "true" &&
    (INTERNAL_TESTING_MAINNETS as readonly string[]).includes(networkName)
  );
}

/** {@link isInternalTestingMainnet} plus an explicit `YES_MAINNET` confirmation. */
export function isInternalTestingMainnetConfirmed(networkName: string): boolean {
  return isInternalTestingMainnet(networkName) && isYesMainnet();
}
