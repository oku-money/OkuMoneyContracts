/**
 * Shared plumbing for operator CLIs.
 *
 * Every operator script follows the same shape: resolve the network, guard
 * mainnet, load a proxy from the address book, print what is about to happen,
 * honour DRY_RUN, submit, confirm. This module holds that shape so the scripts
 * themselves are just the operation.
 */

import { ethers } from "hardhat";
import { Contract } from "ethers";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";

export const DRY_RUN = process.env.DRY_RUN === "true";
export const YES_MAINNET = process.argv.includes("--yes-mainnet");

/** `--name=value`, `--name value`, or the NAME / SCREAMING_SNAKE env var. */
export function arg(name: string): string | undefined {
  const flag = process.argv.find(
    (x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `)
  );
  if (flag) return flag.split(/[= ]/)[1];
  return process.env[name.toUpperCase().replace(/-/g, "_")];
}

export function requireArg(name: string, hint: string): string {
  const v = arg(name);
  if (!v) throw new Error(`Required: --${name}=<${hint}> (or ${name.toUpperCase()} env var)`);
  return v;
}

export interface OperatorContext {
  networkName: string;
  bookKey: string;
  signer: any;
  signerAddress: string;
  /** Attach a deployed proxy by contract name, connected to the signer. */
  at(contractName: string): Promise<Contract>;
}

/**
 * Standard preamble: header, mainnet guard, signer resolution, and a proxy
 * loader that fails loudly when the address book is missing an entry.
 */
export async function operatorContext(title: string): Promise<OperatorContext> {
  const ctx = await resolveNetworkContext();
  logger.header(`${title} (${ctx.networkName})`);
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const [signer] = await ethers.getSigners();
  const signerAddress = await signer.getAddress();
  logger.info(`Signer: ${signerAddress}`);

  return {
    networkName: ctx.networkName,
    bookKey: ctx.bookKey,
    signer,
    signerAddress,
    async at(contractName: string): Promise<Contract> {
      const address = loadAddress(ctx.bookKey, contractName);
      if (!address) {
        throw new Error(
          `Missing ${contractName} in the address book for "${ctx.bookKey}". Deploy first.`
        );
      }
      return (await getDeployedContract(contractName, address)).connect(signer) as Contract;
    },
  };
}

/** Submit a transaction unless DRY_RUN, logging the hash on success. */
export async function submit(
  label: string,
  fn: () => Promise<any>
): Promise<void> {
  if (DRY_RUN) {
    logger.success(`DRY_RUN=true — not submitting: ${label}`);
    return;
  }
  const tx = await fn();
  const receipt = await tx.wait(1);
  logger.success(`${label} — tx ${receipt.hash}`);
}

/** Wrap a script body with consistent exit-code and error handling. */
export function run(main: () => Promise<void>): void {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error(e?.message ?? String(e));
      process.exit(1);
    });
}

export { logger, ethers };
