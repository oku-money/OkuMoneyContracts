/**
 * Deposit USDC to the SubscriptionModule buffer (PSM_BUFFER_DEPOSITOR required).
 *
 * Calls `SubscriptionModule.depositBuffer(amount)`, which pulls USDC from the
 * caller's wallet into the module's reserve buffer so instant redemptions can
 * proceed instead of queueing.
 *
 * Not pause-gated, deliberately: topping up the buffer during an incident is the
 * remediation, not an attack surface. It is not sync-gated either — a deposit
 * moves value at par and never prices through `M_oku`, so a stale multiplier
 * cannot mis-price it. That is the whole gating rule: an operation is
 * sync-gated iff it converts value through the multiplier.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/depositBuffer.ts --network base \
 *       --amount 1000000000    # 1000 USDC (6 decimals)
 *   DRY_RUN=true NETWORK=base npx hardhat run scripts/operator/depositBuffer.ts --network base \
 *       --amount 1000000000
 *
 * Environment:
 *   AMOUNT         6-decimal USDC amount (alternative to CLI flag)
 *   DRY_RUN=true   Simulate without submitting
 */

import { ethers } from "hardhat";
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
  logger.header(`depositBuffer (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const amountStr = parseArg("amount") ?? parseArg("AMOUNT");
  if (!amountStr) throw new Error("Required: --amount=<6-decimal USDC> or AMOUNT env var");
  const amount = BigInt(amountStr);
  if (amount <= 0n) throw new Error("--amount must be > 0");

  const psmAddr = loadAddress(ctx.bookKey, "SubscriptionModule");
  const usdcAddr = loadAddress(ctx.bookKey, "MockUSDC") ?? loadAddress(ctx.bookKey, "USDC");
  if (!psmAddr || !usdcAddr) {
    throw new Error(`Missing SubscriptionModule or USDC in address book for ${ctx.bookKey}`);
  }

  // Signer resolution goes through the shared helper rather than
  // `getSigners()[0]`: on a fork the mnemonic accounts hold no roles, so every
  // privileged call here would revert AccessControlUnauthorizedAccount against
  // a correctly-wired deployment. On a live network the helper returns the same
  // PRIVATE_KEY signer, so behaviour there is unchanged.
  const signer = await resolveOperatorSigner(ctx.isFork);
  const signerAddr = await signer.getAddress();

  const psm = (await getDeployedContract("SubscriptionModule", psmAddr)).connect(signer);
  const usdc = (await ethers.getContractAt("IERC20", usdcAddr)).connect(signer);

  const signerBalance = await usdc.balanceOf(signerAddr);
  const bufferBefore = await usdc.balanceOf(psmAddr);

  logger.info(`Signer: ${signerAddr}`);
  logger.info(`Signer USDC: ${Number(signerBalance) / 1e6}`);
  logger.info(`Module buffer before: ${Number(bufferBefore) / 1e6}`);
  logger.info(`Depositing: ${Number(amount) / 1e6} USDC`);

  if (signerBalance < amount) {
    throw new Error(`Insufficient USDC: have ${Number(signerBalance) / 1e6}, need ${Number(amount) / 1e6}`);
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const approveTx = await usdc.approve(psmAddr, amount);
  await approveTx.wait(1);
  logger.success(`Approved ${Number(amount) / 1e6} USDC to PSM`);

  const depositTx = await (psm as any).depositBuffer(amount);
  const receipt = await depositTx.wait(1);
  logger.success(`depositBuffer tx: ${receipt.hash}`);

  const bufferAfter = await usdc.balanceOf(psmAddr);
  logger.success(`Module buffer after: ${Number(bufferAfter) / 1e6} (+${Number(bufferAfter - bufferBefore) / 1e6})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => { logger.error(e.message ?? String(e)); process.exit(1); });
