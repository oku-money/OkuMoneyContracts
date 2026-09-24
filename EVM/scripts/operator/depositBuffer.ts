/**
 * Deposit USDC to the LitePSM buffer (PSM_BUFFER_DEPOSITOR role required).
 *
 * Calls `LitePSM.depositBuffer(amount)`, which pulls USDC from the caller's
 * wallet into the PSM's reserve buffer so instant redemptions can proceed.
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base AMOUNT=1000000000 \
 *       npx hardhat run scripts/operator/depositBuffer.ts --network base   # 1000 USDC (6 dec)
 *
 * Environment:
 *   AMOUNT            6-decimal USDC amount (required)
 *   DRY_RUN=true      Simulate without submitting
 *   YES_MAINNET=true  Required to broadcast on a mainnet network
 *
 * Also exported as `runDepositBuffer()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";

export interface DepositBufferResult {
  bufferBefore: bigint;
  bufferAfter: bigint;
  txHash?: string;
}

export async function runDepositBuffer(
  ctx: NetworkContext,
  signer: Signer,
  amount: bigint,
  dryRun = false
): Promise<DepositBufferResult> {
  if (amount <= 0n) throw new Error("amount must be > 0");

  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  const usdcAddr = loadAddress(ctx.bookKey, "MockUSDC") ?? loadAddress(ctx.bookKey, "USDC");
  if (!psmAddr || !usdcAddr) throw new Error(`Missing LitePSM or USDC in address book for ${ctx.bookKey}`);

  const signerAddr = await signer.getAddress();
  const psm = (await getDeployedContract("LitePSM", psmAddr)).connect(signer);
  const usdc = (await ethers.getContractAt("IERC20", usdcAddr)).connect(signer);

  const signerBalance = await usdc.balanceOf(signerAddr);
  const bufferBefore = await usdc.balanceOf(psmAddr);

  logger.info(`Signer: ${signerAddr}`);
  logger.info(`Signer USDC: ${Number(signerBalance) / 1e6}`);
  logger.info(`PSM buffer before: ${Number(bufferBefore) / 1e6}`);
  logger.info(`Depositing: ${Number(amount) / 1e6} USDC`);

  if (signerBalance < amount) {
    throw new Error(`Insufficient USDC: have ${Number(signerBalance) / 1e6}, need ${Number(amount) / 1e6}`);
  }
  if (dryRun) {
    logger.success("DRY_RUN=true — not submitting");
    return { bufferBefore, bufferAfter: bufferBefore };
  }

  const approveTx = await usdc.approve(psmAddr, amount);
  await approveTx.wait(1);
  logger.success(`Approved ${Number(amount) / 1e6} USDC to PSM`);

  const depositTx = await (psm as any).depositBuffer(amount);
  const receipt = await depositTx.wait(1);
  logger.success(`depositBuffer tx: ${receipt.hash}`);

  const bufferAfter = await usdc.balanceOf(psmAddr);
  logger.success(`PSM buffer after: ${Number(bufferAfter) / 1e6} (+${Number(bufferAfter - bufferBefore) / 1e6})`);
  return { bufferBefore, bufferAfter, txHash: receipt.hash };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`depositBuffer (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const amountStr = parseArg("amount");
    if (!amountStr) throw new Error("Required: --amount=<6-decimal USDC> or AMOUNT env var");

    const [signer] = await ethers.getSigners();
    await runDepositBuffer(ctx, signer, BigInt(amountStr), isDryRun());
  });
}
