/**
 * Shared plumbing for the operator scripts.
 *
 * Extracted in the v0.3 refactor: every operator script previously carried its
 * own copy of the arg parser and the fork-impersonation logic, which had already
 * drifted between files. One copy, one behaviour.
 */

import { ethers, network } from "hardhat";
import { Contract, Signer } from "ethers";

import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { DEV_WALLET_ADDRESS } from "../config/chains";

export const PRECISION = 10n ** 18n;
export const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
export const BASIS_POINTS = 10_000n;

/** Mirrors `Constants.MAX_IMPLIED_APR` (bps) — keep in sync with Solidity. */
export const MAX_IMPLIED_APR_BPS = 1000n;
/** Mirrors `Constants.MAX_RATE_DURATION`. */
export const MAX_RATE_DURATION_SECONDS = 30n * 24n * 60n * 60n;

export const DRY_RUN = process.env.DRY_RUN === "true";
export const YES_MAINNET =
  process.argv.includes("--yes-mainnet") || process.env.YES_MAINNET === "true";

/** `--name=value`, `--name value`, or the SCREAMING_SNAKE env var. */
export function parseArg(name: string): string | undefined {
  const flag = process.argv.find(
    (x) => x.startsWith(`--${name}=`) || x === `--${name}`
  );
  if (flag) {
    if (flag.includes("=")) return flag.split("=").slice(1).join("=");
    const idx = process.argv.indexOf(flag);
    const next = process.argv[idx + 1];
    if (next && !next.startsWith("--")) return next;
  }
  return process.env[name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()];
}

export function requireArg(name: string): string {
  const v = parseArg(name);
  if (v === undefined || v === "") {
    throw new Error(`Required: --${name}=<value> or the matching env var`);
  }
  return v;
}

/**
 * Resolve the signer for a privileged call.
 *
 * On a fork the hardhat mnemonic accounts hold no roles, so impersonate the dev
 * wallet that testnet deploys grant everything to. On a live network we trust
 * that `PRIVATE_KEY`'s signer holds the role — if it does not, the contract
 * reverts with `AccessControlUnauthorizedAccount`, which is the correct outcome.
 */
export async function resolveOperatorSigner(isFork: boolean): Promise<Signer> {
  const [primary] = await ethers.getSigners();

  if (primary && (await primary.getAddress()).toLowerCase() === DEV_WALLET_ADDRESS.toLowerCase()) {
    return primary;
  }

  if (!isFork) {
    if (DRY_RUN) {
      logger.warning(
        `DRY_RUN: using a read-only VoidSigner for ${DEV_WALLET_ADDRESS}; no key required`
      );
      return new ethers.VoidSigner(DEV_WALLET_ADDRESS, ethers.provider);
    }
    return primary;
  }

  logger.info(`Impersonating dev wallet ${DEV_WALLET_ADDRESS} on fork...`);
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [DEV_WALLET_ADDRESS],
  });
  const balance = await ethers.provider.getBalance(DEV_WALLET_ADDRESS);
  if (balance < ethers.parseEther("0.5")) {
    await primary.sendTransaction({ to: DEV_WALLET_ADDRESS, value: ethers.parseEther("1") });
    logger.info(`Funded ${DEV_WALLET_ADDRESS} with 1 ETH for gas`);
  }
  return ethers.getSigner(DEV_WALLET_ADDRESS);
}

/** Boilerplate: resolve context, apply the mainnet guard, load a contract. */
export async function setup(
  label: string,
  contractName: "OkuDollar" | "LitePSM" | "RedemptionQueue" | "OkuMultiplierAdapter"
): Promise<{ contract: Contract; signer: Signer; bookKey: string; networkName: string; isFork: boolean }> {
  const ctx = await resolveNetworkContext();
  logger.header(`${label} (${ctx.networkName})`);
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const address = loadAddress(ctx.bookKey, contractName);
  if (!address) {
    throw new Error(`Missing ${contractName} in the address book for ${ctx.bookKey}`);
  }

  const signer = await resolveOperatorSigner(ctx.isFork);
  const contract = (await getDeployedContract(contractName, address)).connect(signer) as Contract;

  logger.info(`Signer:   ${await signer.getAddress()}`);
  logger.info(`${contractName}: ${address}`);

  return {
    contract,
    signer,
    bookKey: ctx.bookKey,
    networkName: ctx.networkName,
    isFork: ctx.isFork,
  };
}

/** Submit unless DRY_RUN, then log the hash. */
export async function submit(label: string, fn: () => Promise<any>): Promise<void> {
  if (DRY_RUN) {
    logger.success(`DRY_RUN=true — not submitting "${label}"`);
    return;
  }
  const tx = await fn();
  const receipt = await tx.wait(1);
  logger.success(`${label} tx: ${receipt.hash}`);
}

/** Nominal (simple) annualization, matching `ScaledUIAmountUpgradeable._impliedAprBps`. */
export function impliedAprBps(ratePerSecond: bigint): bigint {
  if (ratePerSecond <= PRECISION) return 0n;
  return ((ratePerSecond - PRECISION) * SECONDS_PER_YEAR * BASIS_POINTS) / PRECISION;
}

/** Inverse of the above: the per-second rate that annualizes to `bps`. */
export function ratePerSecondForAprBps(bps: bigint): bigint {
  return PRECISION + (bps * PRECISION) / (BASIS_POINTS * SECONDS_PER_YEAR);
}

export function runScript(main: () => Promise<void>): void {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error(e?.message ?? String(e));
      process.exit(1);
    });
}
