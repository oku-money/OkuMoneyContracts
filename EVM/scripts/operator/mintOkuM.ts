/**
 * Mint OkuMoney via LitePSM (noBridge orchestrator workflow).
 *
 * Calls `LitePSM.mintOkuM(usdcAmount)` as the orchestrator. The PSM holds
 * OKUM_MINTER and mints OkuM from the caller's USDC. The orchestrator does NOT
 * need OKUM_MINTER — any address with USDC can call `mintOkuM`.
 *
 * This script is the destination-chain leg of a noBridge bridge. After the
 * source-chain redeem settles, the orchestrator calls this script on the
 * destination chain with the USDC it custodies from the source-chain payout.
 *
 * Usage:
 *   # Mint 1000 USDC worth of OkuM (6-decimal units):
 *   NETWORK=base npx hardhat run scripts/operator/mintOkuM.ts --network base \
 *       --usdcAmount 1000000000
 *
 *   DRY_RUN=true NETWORK=base npx hardhat run scripts/operator/mintOkuM.ts --network base \
 *       --usdcAmount 1000000000
 *
 * Environment:
 *   USDC_AMOUNT    6-decimal USDC amount (alternative to CLI flag)
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
  logger.header(`mintOkuM (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const usdcAmountStr = parseArg("usdcAmount") ?? parseArg("USDC_AMOUNT");
  if (!usdcAmountStr) {
    throw new Error("Required: --usdcAmount=<6-decimal units> or USDC_AMOUNT env var");
  }
  const usdcAmount = BigInt(usdcAmountStr);
  if (usdcAmount <= 0n) throw new Error("--usdcAmount must be > 0");

  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  const usdcAddr = loadAddress(ctx.bookKey, "MockUSDC") ?? loadAddress(ctx.bookKey, "USDC");
  if (!psmAddr || !usdcAddr) throw new Error(`Missing LitePSM or USDC in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();

  const psm = (await getDeployedContract("LitePSM", psmAddr)).connect(signer);
  const usdc = (await ethers.getContractAt("IERC20", usdcAddr)).connect(signer);

  const okuMoneyAddr2 = loadAddress(ctx.bookKey, "OkuMoney");
  const okuMoneyForRead = okuMoneyAddr2 ? await ethers.getContractAt("OkuMoney", okuMoneyAddr2) : null;
  const okuMBefore = okuMoneyForRead ? BigInt(await (okuMoneyForRead as any).balanceOf(signerAddr)) : 0n;
  const usdcBalance = await usdc.balanceOf(signerAddr);

  logger.info(`Signer: ${signerAddr}`);
  logger.info(`USDC balance: ${Number(usdcBalance) / 1e6}`);
  logger.info(`Minting: ${Number(usdcAmount) / 1e6} USDC → OkuM via PSM at ${psmAddr}`);

  if (usdcBalance < usdcAmount) {
    throw new Error(`Insufficient USDC: have ${Number(usdcBalance) / 1e6}, need ${Number(usdcAmount) / 1e6}`);
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  // Approve PSM to spend USDC
  const approveTx = await usdc.approve(psmAddr, usdcAmount);
  await approveTx.wait(1);
  logger.success(`Approved ${Number(usdcAmount) / 1e6} USDC to PSM`);

  const mintTx = await (psm as any).mintOkuM(usdcAmount);
  const receipt = await mintTx.wait(1);
  logger.success(`mintOkuM tx: ${receipt.hash}`);

  const okuMAfter = okuMoneyForRead ? BigInt(await (okuMoneyForRead as any).balanceOf(signerAddr)) : 0n;
  logger.success(`OkuM received: ${ethers.formatEther(okuMAfter - okuMBefore)}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { logger.error(e.message ?? String(e)); process.exit(1); });
