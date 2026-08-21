/**
 * Configure OkuDollar minter allowance (OKU_ALLOWANCE_MANAGER role required).
 *
 * Calls `OkuDollar.configureMinterAllowance(minter, allowance)`.
 * In production, minterAllowance should be set well below maxSupply (e.g. 1%
 * of max supply) and rotated weekly. This script is the rotation tool.
 *
 * See ../../README.md § Orchestrator runbook — Minter allowance rotation policy.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/configureMinterAllowance.ts --network base \
 *       --minter 0xPsmAddress --allowance 10000000000000000000000000   # 10M OkuM (18-dec)
 *   DRY_RUN=true NETWORK=base npx hardhat run scripts/operator/configureMinterAllowance.ts \
 *       --network base --minter 0xPsmAddress --allowance 10000000000000000000000000
 *
 * Environment:
 *   MINTER         Minter address (defaults to deployed LitePSM)
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

  const okuDollarAddr = loadAddress(ctx.bookKey, "OkuDollar");
  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  if (!okuDollarAddr) throw new Error(`Missing OkuDollar in address book for ${ctx.bookKey}`);

  const minterArg = parseArg("minter") ?? parseArg("MINTER");
  const minterAddr = minterArg && isAddress(minterArg) ? minterArg : psmAddr;
  if (!minterAddr || !isAddress(minterAddr)) {
    throw new Error("Required: --minter=<address> or MINTER env var (or LitePSM in address book)");
  }

  const allowanceStr = parseArg("allowance") ?? parseArg("ALLOWANCE");
  if (!allowanceStr) throw new Error("Required: --allowance=<18-decimal OkuM> or ALLOWANCE env var");
  const allowance = BigInt(allowanceStr);
  if (allowance < 0n) throw new Error("--allowance must be ≥ 0");

  const [signer] = await ethers.getSigners();
  const okuDollar = (await getDeployedContract("OkuDollar", okuDollarAddr)).connect(signer);

  const currentAllowance = await (okuDollar as any).minterAllowance(minterAddr);
  const maxSupply = await (okuDollar as any).maxSupply();

  logger.info(`Signer (allowanceManager): ${await signer.getAddress()}`);
  logger.info(`Minter:                    ${minterAddr}`);
  logger.info(`Current allowance:         ${ethers.formatEther(currentAllowance)} OkuM`);
  logger.info(`New allowance:             ${ethers.formatEther(allowance)} OkuM`);
  logger.info(`Max supply:                ${ethers.formatEther(maxSupply)} OkuM`);
  logger.info(`Allowance as % of max:     ${(Number(allowance) / Number(maxSupply) * 100).toFixed(4)}%`);

  if (allowance > maxSupply) {
    throw new Error(`New allowance (${ethers.formatEther(allowance)}) exceeds maxSupply (${ethers.formatEther(maxSupply)})`);
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (okuDollar as any).configureMinterAllowance(minterAddr, allowance);
  const receipt = await tx.wait(1);
  logger.success(`configureMinterAllowance tx: ${receipt.hash}`);

  const newAllowance = await (okuDollar as any).minterAllowance(minterAddr);
  logger.success(`Confirmed new allowance: ${ethers.formatEther(newAllowance)} OkuM`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { logger.error(e.message ?? String(e)); process.exit(1); });
