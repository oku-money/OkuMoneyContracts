/**
 * Configure OkuMoney minter allowance (OKUM_ALLOWANCE_MANAGER role required).
 *
 * Calls `OkuMoney.configureMinterAllowance(minter, allowance)`.
 * In production, minterAllowance should be set well below maxSupply (e.g. 1%
 * of max supply) and rotated weekly. This script is the rotation tool.
 *
 * See ../../README.md § Orchestrator runbook — Minter allowance rotation policy.
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base MINTER=0xPsmAddress ALLOWANCE=10000000000000000000000000 \
 *       npx hardhat run scripts/operator/configureMinterAllowance.ts --network base
 *
 * Environment:
 *   MINTER            Minter address (defaults to deployed LitePSM)
 *   ALLOWANCE         18-decimal OkuM amount
 *   DRY_RUN=true      Simulate without submitting
 *   YES_MAINNET=true  Required to broadcast on a mainnet network
 *
 * Also exported as `runConfigureMinterAllowance()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { isAddress, Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract, waitMined } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";

export interface ConfigureMinterAllowanceResult {
  previousAllowance: bigint;
  newAllowance: bigint;
  txHash?: string;
}

export async function runConfigureMinterAllowance(
  ctx: NetworkContext,
  signer: Signer,
  minter: string,
  allowance: bigint,
  dryRun = false
): Promise<ConfigureMinterAllowanceResult> {
  if (!isAddress(minter)) throw new Error(`Invalid minter: ${minter}`);
  if (allowance < 0n) throw new Error("allowance must be >= 0");

  const okuMoneyAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!okuMoneyAddr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);

  const okuMoney = (await getDeployedContract("OkuMoney", okuMoneyAddr)).connect(signer);

  const currentAllowance = await okuMoney.minterAllowance(minter);
  const maxSupply = await okuMoney.maxSupply();

  logger.info(`Signer (allowanceManager): ${await signer.getAddress()}`);
  logger.info(`Minter:                    ${minter}`);
  logger.info(`Current allowance:         ${ethers.formatEther(currentAllowance)} OkuM`);
  logger.info(`New allowance:             ${ethers.formatEther(allowance)} OkuM`);
  logger.info(`Max supply:                ${ethers.formatEther(maxSupply)} OkuM`);

  if (allowance > maxSupply) {
    throw new Error(`New allowance (${ethers.formatEther(allowance)}) exceeds maxSupply (${ethers.formatEther(maxSupply)})`);
  }
  if (dryRun) {
    logger.success("DRY_RUN=true — not submitting");
    return { previousAllowance: currentAllowance, newAllowance: currentAllowance };
  }

  const tx = await okuMoney.configureMinterAllowance(minter, allowance);
  const receipt = await waitMined(tx);
  logger.success(`configureMinterAllowance tx: ${receipt.hash}`);

  const newAllowance = await okuMoney.minterAllowance(minter);
  logger.success(`Confirmed new allowance: ${ethers.formatEther(newAllowance)} OkuM`);
  return { previousAllowance: currentAllowance, newAllowance, txHash: receipt.hash };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`configureMinterAllowance (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
    const minterArg = parseArg("minter");
    // A malformed --minter must fail, not silently re-point the allowance
    // change at LitePSM. Omitting it entirely still defaults to LitePSM.
    if (minterArg !== undefined && !isAddress(minterArg)) {
      throw new Error(`--minter is not a valid address: ${minterArg}`);
    }
    const minter = minterArg ?? psmAddr;
    if (!minter || !isAddress(minter)) {
      throw new Error("Required: --minter=<address> (or LitePSM in address book)");
    }
    const allowanceStr = parseArg("allowance");
    if (!allowanceStr) throw new Error("Required: --allowance=<18-decimal OkuM>");

    const [signer] = await ethers.getSigners();
    await runConfigureMinterAllowance(ctx, signer, minter, BigInt(allowanceStr), isDryRun());
  });
}
