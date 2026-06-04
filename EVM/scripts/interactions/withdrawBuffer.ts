/**
 * Withdraw USDC from the LitePSM buffer (PSM_BUFFER_WITHDRAWER role required).
 *
 * Calls `LitePSM.withdrawUsdc(to, amount)`, which pulls USDC out of the PSM's
 * reserve buffer. The PSM enforces that the remaining balance covers all
 * queued redemption obligations; the call reverts with WouldStrandQueue if it
 * would leave insufficient buffer.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/interactions/withdrawBuffer.ts --network base \
 *       --amount 1000000000 --to 0xRecipientAddress
 *   DRY_RUN=true NETWORK=base npx hardhat run scripts/interactions/withdrawBuffer.ts --network base \
 *       --amount 1000000000 --to 0xRecipientAddress
 *
 * Environment:
 *   AMOUNT         6-decimal USDC amount (alternative to CLI flag)
 *   TO             Recipient address (defaults to signer)
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
  logger.header(`withdrawBuffer (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const amountStr = parseArg("amount") ?? parseArg("AMOUNT");
  if (!amountStr) throw new Error("Required: --amount=<6-decimal USDC> or AMOUNT env var");
  const amount = BigInt(amountStr);
  if (amount <= 0n) throw new Error("--amount must be > 0");

  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  const usdcAddr = loadAddress(ctx.bookKey, "MockUSDC") ?? loadAddress(ctx.bookKey, "USDC");
  if (!psmAddr || !usdcAddr) throw new Error(`Missing LitePSM or USDC in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();

  const toStr = parseArg("to") ?? parseArg("TO");
  const recipient = toStr && isAddress(toStr) ? toStr : signerAddr;

  const psm = (await getDeployedContract("LitePSM", psmAddr)).connect(signer);
  const usdc = (await ethers.getContractAt("IERC20", usdcAddr)).connect(signer);

  const bufferBefore = await usdc.balanceOf(psmAddr);
  const recipientBefore = await usdc.balanceOf(recipient);

  logger.info(`Signer (withdrawer): ${signerAddr}`);
  logger.info(`Recipient:           ${recipient}`);
  logger.info(`PSM buffer:          ${Number(bufferBefore) / 1e6} USDC`);
  logger.info(`Withdrawing:         ${Number(amount) / 1e6} USDC`);

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (psm as any).withdrawUsdc(recipient, amount);
  const receipt = await tx.wait(1);
  logger.success(`withdrawUsdc tx: ${receipt.hash}`);

  const bufferAfter = await usdc.balanceOf(psmAddr);
  const recipientAfter = await usdc.balanceOf(recipient);
  logger.success(`PSM buffer after: ${Number(bufferAfter) / 1e6} (Δ${Number(bufferAfter - bufferBefore) / 1e6})`);
  logger.success(`Recipient USDC:   ${Number(recipientAfter) / 1e6} (+${Number(recipientAfter - recipientBefore) / 1e6})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { logger.error(e.message ?? String(e)); process.exit(1); });
