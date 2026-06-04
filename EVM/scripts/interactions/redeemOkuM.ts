/**
 * Redeem OkuMoney via LitePSM (noBridge orchestrator workflow).
 *
 * Calls `LitePSM.redeemOkuM(okuMAmount)` as the orchestrator. If the PSM
 * buffer has insufficient USDC the transaction still succeeds: the OkuM is
 * escrowed in the redemption queue and paid out when processQueue runs.
 *
 * This is the source-chain leg of a noBridge bridge. Orchestrator pulls OkuM
 * from the user (requires prior user approval), then calls this script to burn
 * OkuM and receive USDC which it custodies for the destination-chain mint.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/interactions/redeemOkuM.ts --network base \
 *       --okuMAmount 1000000000000000000000  # 1000 OkuM (18 decimals)
 *   DRY_RUN=true NETWORK=base npx hardhat run scripts/interactions/redeemOkuM.ts --network base \
 *       --okuMAmount 1000000000000000000000
 *
 * Environment:
 *   OKUM_AMOUNT    18-decimal OkuM amount (alternative to CLI flag)
 *   DRY_RUN=true   Simulate without submitting
 */

import { ethers } from "hardhat";
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
  logger.header(`redeemOkuM (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const okuMAmountStr = parseArg("okuMAmount") ?? parseArg("OKUM_AMOUNT");
  if (!okuMAmountStr) {
    throw new Error("Required: --okuMAmount=<18-decimal units> or OKUM_AMOUNT env var");
  }
  const okuMAmount = BigInt(okuMAmountStr);
  if (okuMAmount <= 0n) throw new Error("--okuMAmount must be > 0");

  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  const okuMoneyAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!psmAddr || !okuMoneyAddr) throw new Error(`Missing LitePSM or OkuMoney in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();

  const psm = (await getDeployedContract("LitePSM", psmAddr)).connect(signer);
  const okuMoney = (await getDeployedContract("OkuMoney", okuMoneyAddr)).connect(signer);
  const usdcAddr = loadAddress(ctx.bookKey, "MockUSDC") ?? loadAddress(ctx.bookKey, "USDC");

  const okuMBalance = await (okuMoney as any).balanceOf(signerAddr);
  const psmMultiplier = await (okuMoney as any).okuMMultiplier();
  const expectedUsdc = (okuMAmount * psmMultiplier) / (10n ** 18n) / (10n ** 12n); // 18-dec OkuM → 6-dec USDC

  logger.info(`Signer: ${signerAddr}`);
  logger.info(`OkuM balance: ${ethers.formatEther(okuMBalance)}`);
  logger.info(`Redeeming: ${ethers.formatEther(okuMAmount)} OkuM ≈ ${Number(expectedUsdc) / 1e6} USDC`);

  if (okuMBalance < okuMAmount) {
    throw new Error(`Insufficient OkuM: have ${ethers.formatEther(okuMBalance)}, need ${ethers.formatEther(okuMAmount)}`);
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  // Approve PSM to spend OkuM
  const approveTx = await (okuMoney as any).approve(psmAddr, okuMAmount);
  await approveTx.wait(1);
  logger.success(`Approved ${ethers.formatEther(okuMAmount)} OkuM to PSM`);

  const redeemTx = await (psm as any).redeemOkuM(okuMAmount);
  const receipt = await redeemTx.wait(1);
  logger.success(`redeemOkuM tx: ${receipt.hash}`);

  if (usdcAddr) {
    const usdc = await ethers.getContractAt("IERC20", usdcAddr);
    const usdcBalance = await usdc.balanceOf(signerAddr);
    logger.success(`USDC balance after: ${Number(usdcBalance) / 1e6}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => { logger.error(e.message ?? String(e)); process.exit(1); });
