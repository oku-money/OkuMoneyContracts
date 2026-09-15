/**
 * Withdraw USDC from the LitePSM buffer (PSM_BUFFER_WITHDRAWER role required).
 *
 * Calls `LitePSM.withdrawUsdc(to, amount)`, which pulls USDC out of the PSM's
 * reserve buffer. The PSM enforces that the remaining balance covers all
 * queued redemption obligations; the call reverts with WouldStrandQueue if it
 * would leave insufficient buffer.
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base AMOUNT=1000000000 TO=0xRecipientAddress \
 *       npx hardhat run scripts/operator/withdrawBuffer.ts --network base
 *
 * Environment:
 *   AMOUNT            6-decimal USDC amount (required)
 *   TO                Recipient address (defaults to signer)
 *   DRY_RUN=true      Simulate without submitting
 *   YES_MAINNET=true  Required to broadcast on a mainnet network
 *
 * Also exported as `runWithdrawBuffer()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { isAddress, Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";

export interface WithdrawBufferResult {
  bufferBefore: bigint;
  bufferAfter: bigint;
  txHash?: string;
}

export async function runWithdrawBuffer(
  ctx: NetworkContext,
  signer: Signer,
  amount: bigint,
  recipient?: string,
  dryRun = false
): Promise<WithdrawBufferResult> {
  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  const usdcAddr = loadAddress(ctx.bookKey, "MockUSDC") ?? loadAddress(ctx.bookKey, "USDC");
  if (!psmAddr || !usdcAddr) throw new Error(`Missing LitePSM or USDC in address book for ${ctx.bookKey}`);

  const signerAddr = await signer.getAddress();
  const to = recipient && isAddress(recipient) ? recipient : signerAddr;

  const psm = (await getDeployedContract("LitePSM", psmAddr)).connect(signer);
  const usdc = (await ethers.getContractAt("IERC20", usdcAddr)).connect(signer);

  const bufferBefore = await usdc.balanceOf(psmAddr);
  const recipientBefore = await usdc.balanceOf(to);

  logger.info(`Signer (withdrawer): ${signerAddr}`);
  logger.info(`Recipient:           ${to}`);
  logger.info(`PSM buffer:          ${Number(bufferBefore) / 1e6} USDC`);
  logger.info(`Withdrawing:         ${Number(amount) / 1e6} USDC`);

  if (dryRun) {
    logger.success("DRY_RUN=true — not submitting");
    return { bufferBefore, bufferAfter: bufferBefore };
  }

  const tx = await (psm as any).withdrawUsdc(to, amount);
  const receipt = await tx.wait(1);
  logger.success(`withdrawUsdc tx: ${receipt.hash}`);

  const bufferAfter = await usdc.balanceOf(psmAddr);
  const recipientAfter = await usdc.balanceOf(to);
  logger.success(`PSM buffer after: ${Number(bufferAfter) / 1e6} (Δ${Number(bufferAfter - bufferBefore) / 1e6})`);
  logger.success(`Recipient USDC:   ${Number(recipientAfter) / 1e6} (+${Number(recipientAfter - recipientBefore) / 1e6})`);
  return { bufferBefore, bufferAfter, txHash: receipt.hash };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`withdrawBuffer (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const amountStr = parseArg("amount") ?? parseArg("AMOUNT");
    if (!amountStr) throw new Error("Required: --amount=<6-decimal USDC> or AMOUNT env var");
    const to = parseArg("to") ?? parseArg("TO");

    const [signer] = await ethers.getSigners();
    await runWithdrawBuffer(ctx, signer, BigInt(amountStr), to, isDryRun());
  });
}
