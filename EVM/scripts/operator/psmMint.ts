/**
 * Mint rUSDOku from USDC through the PSM. Permissionless — any USDC holder can
 * call this; the script exists for smoke-testing a fresh deploy.
 *
 * Replaces v0.2's `mintOkuM.ts`. The pricing is unchanged in shape but now reads
 * the single `uiMultiplier()` rather than a separate `okuMMultiplier()`.
 *
 *   raw = (usdcAmount * usdcDecimalMultiplier) * PRECISION / uiMultiplier()
 *
 * At a multiplier of 1.05, depositing 100 USDC yields ~95.24 raw, which DISPLAYS
 * as $100.00. If you are looking at a wallet that does not understand ERC-8056
 * you will see 95.24, not 100 — that is correct, not a bug.
 *
 * Usage:
 *   npx hardhat run scripts/operator/psmMint.ts --network sepolia --usdc 100
 *   DRY_RUN=true USDC=100 npx hardhat run scripts/operator/psmMint.ts --network sepolia
 */

import { ethers } from "hardhat";

import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { DRY_RUN, requireArg, runScript, setup, submit } from "./_shared";

async function main() {
  const { contract: psm, signer, bookKey } = await setup("psmMint", "LitePSM");

  const usdcAddr = loadAddress(bookKey, "MockUSDC") ?? (await (psm as any).usdc());
  const usdc = (await getDeployedContract("MockUSDC", usdcAddr)).connect(signer) as any;
  const tokenAddr = await (psm as any).okuDollar();
  const token = (await getDeployedContract("OkuDollar", tokenAddr)) as any;

  const decimals: number = Number(await usdc.decimals());
  const amount = ethers.parseUnits(requireArg("usdc"), decimals);

  const who = await signer.getAddress();
  const multiplier: bigint = await token.uiMultiplier();
  const quoted: bigint = await (psm as any).quoteMint(amount);

  logger.info(`Caller:          ${who}`);
  logger.info(`USDC in:         ${ethers.formatUnits(amount, decimals)}`);
  logger.info(`uiMultiplier:    ${ethers.formatEther(multiplier)}`);
  logger.info(`Quoted raw out:  ${ethers.formatEther(quoted)}`);
  logger.info(`Displays as:     $${ethers.formatEther(await token.toUIAmount(quoted))}`);

  const balance: bigint = await usdc.balanceOf(who);
  if (balance < amount) {
    throw new Error(
      `Insufficient USDC: have ${ethers.formatUnits(balance, decimals)}, ` +
        `need ${ethers.formatUnits(amount, decimals)}`
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const psmAddress = await (psm as any).getAddress();
  await submit("approve", () => usdc.approve(psmAddress, amount));
  await submit("mint", () => (psm as any).mint(amount));

  const rawAfter: bigint = await token.balanceOf(who);
  logger.success(`Raw balance:  ${ethers.formatEther(rawAfter)}`);
  logger.success(`UI balance:   $${ethers.formatEther(await token.balanceOfUI(who))}`);
}

runScript(main);
