/**
 * Configure the OkuM minter allowance (OKU_ALLOWANCE_MANAGER role required).
 *
 * Calls `OkuM.configureMinterAllowance(minter, allowance)` — the Circle
 * FiatToken pattern: a per-minter cap decremented on every `mint`, so a
 * compromised minter is bounded by its remaining allowance rather than by
 * `maxSupply`. In production the allowance should sit well below `maxSupply`
 * (e.g. 1%) and be rotated weekly. This script is the rotation tool.
 *
 * OkuM ONLY. USDOku has no minter-allowance system: the wrapper is its sole
 * minter and every mint is matched 1:1 by OkuM arriving in the wrapper's buffer,
 * so a cap there would add a way to brick wrapping without bounding any
 * unbacked issuance. If you are looking for a supply control on the dollar leg,
 * the honest ones are the wrapper's sunset lever (wrapperSunset.ts) and OkuM's
 * own cap upstream.
 *
 * Burning does NOT restore allowance, by design — the cap limits gross issuance
 * over the rotation period, not net.
 *
 * See ../../README.md § Orchestrator runbook — Minter allowance rotation policy.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/configureMinterAllowance.ts --network base \
 *       --minter 0xModuleAddress --allowance 10000000000000000000000000   # 10M OkuM (18-dec)
 *   DRY_RUN=true NETWORK=base npx hardhat run scripts/operator/configureMinterAllowance.ts \
 *       --network base --minter 0xModuleAddress --allowance 10000000000000000000000000
 *
 * Environment:
 *   MINTER         Minter address (defaults to the deployed SubscriptionModule)
 *   ALLOWANCE      18-decimal OkuM amount
 *   DRY_RUN=true   Simulate without submitting
 */

import { ethers } from "hardhat";
import { isAddress } from "ethers";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { resolveOperatorSigner } from "./_shared";

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : process.env[name.toUpperCase().replace(/-/g, '_')];
}

const YES_MAINNET = process.argv.includes("--yes-mainnet");
const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`configureMinterAllowance (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const okuMAddr = loadAddress(ctx.bookKey, "OkuM");
  const moduleAddr = loadAddress(ctx.bookKey, "SubscriptionModule");
  if (!okuMAddr) throw new Error(`Missing OkuM in address book for ${ctx.bookKey}`);

  const minterArg = parseArg("minter") ?? parseArg("MINTER");
  const minterAddr = minterArg && isAddress(minterArg) ? minterArg : moduleAddr;
  if (!minterAddr || !isAddress(minterAddr)) {
    throw new Error(
      "Required: --minter=<address> or MINTER env var (or SubscriptionModule in the address book)"
    );
  }

  const allowanceStr = parseArg("allowance") ?? parseArg("ALLOWANCE");
  if (!allowanceStr) throw new Error("Required: --allowance=<18-decimal OkuM> or ALLOWANCE env var");
  const allowance = BigInt(allowanceStr);
  if (allowance < 0n) throw new Error("--allowance must be ≥ 0");

  // Signer resolution goes through the shared helper rather than
  // `getSigners()[0]`: on a fork the mnemonic accounts hold no roles, so every
  // privileged call here would revert AccessControlUnauthorizedAccount against
  // a correctly-wired deployment. On a live network the helper returns the same
  // PRIVATE_KEY signer, so behaviour there is unchanged.
  const signer = await resolveOperatorSigner(ctx.isFork);
  const okuM = (await getDeployedContract("OkuM", okuMAddr)).connect(signer);

  const currentAllowance = await (okuM as any).minterAllowance(minterAddr);
  const maxSupply = await (okuM as any).maxSupply();
  const totalSupply = await (okuM as any).totalSupply();

  logger.info(`Signer (allowanceManager): ${await signer.getAddress()}`);
  logger.info(`Minter:                    ${minterAddr}`);
  logger.info(`Current allowance:         ${ethers.formatEther(currentAllowance)} OkuM`);
  logger.info(`New allowance:             ${ethers.formatEther(allowance)} OkuM`);
  logger.info(`Total supply:              ${ethers.formatEther(totalSupply)} OkuM`);
  logger.info(`Max supply:                ${ethers.formatEther(maxSupply)} OkuM`);
  logger.info(`Allowance as % of max:     ${(Number(allowance) / Number(maxSupply) * 100).toFixed(4)}%`);

  // Not a contract-enforced bound — `mint` checks the supply cap and the
  // allowance independently, so an allowance above `maxSupply` is merely
  // unreachable rather than dangerous. Refused here because an allowance that
  // cannot be spent is always a typo, and the whole point of the mechanism is
  // that the number is small enough to be meaningful.
  if (allowance > maxSupply) {
    throw new Error(
      `New allowance (${ethers.formatEther(allowance)}) exceeds maxSupply ` +
        `(${ethers.formatEther(maxSupply)}), so it could never be fully spent — ` +
        `the supply cap would bind first. This is almost certainly a decimal error.`
    );
  }

  if (minterAddr.toLowerCase() !== (moduleAddr ?? "").toLowerCase()) {
    logger.warning(
      `${minterAddr} is not the SubscriptionModule (${moduleAddr ?? "<not in book>"}). ` +
        `Confirm this address holds OKU_MINTER and is a CONTRACT — an allowance on ` +
        `an EOA is only reachable if a key also holds the mint role, which the ` +
        `mainnet RBAC topology forbids.`
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (okuM as any).configureMinterAllowance(minterAddr, allowance);
  const receipt = await tx.wait(1);
  logger.success(`configureMinterAllowance tx: ${receipt.hash}`);

  const newAllowance = await (okuM as any).minterAllowance(minterAddr);
  logger.success(`Confirmed new allowance: ${ethers.formatEther(newAllowance)} OkuM`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { logger.error(e.message ?? String(e)); process.exit(1); });
