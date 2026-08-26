/**
 * Shared plumbing for the operator scripts.
 *
 * Extracted in the v0.3 refactor: every operator script previously carried its
 * own copy of the arg parser and the fork-impersonation logic, which had already
 * drifted between files. One copy, one behaviour.
 *
 * v0.4 additionally centralises the Solidity constant mirrors. They were
 * duplicated per script (`const MAX_FEE_BPS = 100n` in setFees.ts, etc.), which
 * was survivable with one bound per script and is not survivable now that a
 * single operation can be constrained by three of them at once.
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

// ---------------------------------------------------------------------------
// Mirrors of `src/lib/Constants.sol` — keep in sync with Solidity.
//
// These exist so a script can explain a bound BEFORE the node rejects the tx.
// A revert selector on a hardware-wallet screen is not an explanation.
// ---------------------------------------------------------------------------

/** `Constants.MAX_IMPLIED_APR` (bps). Binds `USDOku.setUsdOkuRate`. */
export const MAX_IMPLIED_APR_BPS = 1000n;
/** `Constants.MAX_RATE_DURATION`. Binds `USDOku.setUsdOkuRate`. */
export const MAX_RATE_DURATION_SECONDS = 30n * 24n * 60n * 60n;
/** `Constants.MAX_STEP_BPS`. Ceiling on a single `M_oku` step. */
export const MAX_STEP_BPS = 100n;
/** `Constants.MAX_FEE_BPS`. Ceiling on `tin` and on `tout`, each. */
export const MAX_FEE_BPS = 100n;
/** `Constants.MAX_SOLVENCY_GAP_BPS`. How far `M_usd` liability may outrun backing. */
export const MAX_SOLVENCY_GAP_BPS = 100n;
/** `Constants.MAX_SYNC_WINDOW`. Ceiling on the post-step sync window. */
export const MAX_SYNC_WINDOW_SECONDS = 15n * 60n;
/** `Constants.MAX_MULTIPLIER`. Absolute ceiling on `M_oku` and on projected `M_usd`. */
export const MAX_MULTIPLIER = 10n ** 24n;

export const DRY_RUN = process.env.DRY_RUN === "true";
export const YES_MAINNET =
  process.argv.includes("--yes-mainnet") || process.env.YES_MAINNET === "true";

/**
 * Every contract an operator script can address, by hardhat contract name.
 *
 * The name doubles as the address-book key (see utils/addressBook.ts), so this
 * union is also the set of valid book keys. Note `RedemptionQueue` survived the
 * v0.3 -> v0.4 rename unchanged while its siblings did not — a stale book entry
 * under that key will attach cleanly to a RETIRED v0.3 queue, so scripts that
 * touch it should cross-check `queue.okuM()` against the OkuM they expect.
 */
export type OperatorContract =
  | "OkuM"
  | "USDOku"
  | "USDOkuWrapper"
  | "SubscriptionModule"
  | "RedemptionQueue"
  | "OkuMultiplierAdapter";

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
  contractName: OperatorContract
): Promise<{
  contract: Contract;
  signer: Signer;
  bookKey: string;
  networkName: string;
  isFork: boolean;
}> {
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

/**
 * Attach a SECOND contract from the same address book, bound to the same signer.
 *
 * The two-token model made this routine: almost every write against one
 * contract now has a precondition living on another (fees on the module gate
 * steps on OkuM; wrapper backing gates rates on USDOku), and reading that
 * precondition is the difference between explaining a revert and reproducing it.
 */
export async function attachAlso(
  contractName: OperatorContract,
  bookKey: string,
  signer: Signer
): Promise<Contract> {
  const address = loadAddress(bookKey, contractName);
  if (!address) {
    throw new Error(`Missing ${contractName} in the address book for ${bookKey}`);
  }
  const contract = (await getDeployedContract(contractName, address)).connect(signer) as Contract;
  logger.info(`${contractName}: ${address}`);
  return contract;
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

/**
 * Nominal (simple) annualization of a per-second rate, in bps.
 *
 * Mirrors `USDOku._impliedAprBps`. Note this lives on USDOku ONLY: OkuM has no
 * per-second rate at all any more, it steps. Annualizing an OkuM step means
 * dividing by the mark interval, which is an off-chain policy number this
 * module has no business guessing at.
 */
export function impliedAprBps(ratePerSecond: bigint): bigint {
  if (ratePerSecond <= PRECISION) return 0n;
  return ((ratePerSecond - PRECISION) * SECONDS_PER_YEAR * BASIS_POINTS) / PRECISION;
}

/** Inverse of the above: the per-second rate that annualizes to `bps`. */
export function ratePerSecondForAprBps(bps: bigint): bigint {
  return PRECISION + (bps * PRECISION) / (BASIS_POINTS * SECONDS_PER_YEAR);
}

/**
 * Step size in basis points of `oldMultiplier`, rounded UP.
 *
 * Mirrors `ScaledUIAmountUpgradeable._stepMultiplier`, INCLUDING the rounding
 * direction, which is not cosmetic: the coverage comparison is
 * `tin + tout >= stepBps`, so rounding the step down here would let a script
 * green-light a step the contract then refuses.
 */
export function stepBps(oldMultiplier: bigint, newMultiplier: bigint): bigint {
  if (newMultiplier <= oldMultiplier) return 0n;
  const numerator = (newMultiplier - oldMultiplier) * BASIS_POINTS;
  return (numerator + oldMultiplier - 1n) / oldMultiplier; // ceilDiv
}

export function runScript(main: () => Promise<void>): void {
  main()
    .then(() => process.exit(0))
    .catch((e) => {
      logger.error(e?.message ?? String(e));
      process.exit(1);
    });
}
