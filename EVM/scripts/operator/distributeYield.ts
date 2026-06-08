/**
 * Distribute yield into OkuMoney via the rebaser path (OKUM_REBASER role).
 *
 * Calls `OkuMoney.distributeYield(yieldAmount)`, which proportionally bumps
 * every holder's effective balance by `yieldAmount / totalSupply`. This is
 * the on-chain primitive the orchestrator drives once per yield-distribution
 * window; the rebase changes balances without moving tokens.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/distributeYield.ts --network base \
 *       --amount 1000000000000000000   # 1 OkuM (18 decimals)
 *   DRY_RUN=true NETWORK=base npx hardhat run scripts/operator/distributeYield.ts --network base \
 *       --amount 1000000000000000000
 *
 * Environment:
 *   AMOUNT         18-decimal OkuM yield amount (alternative to --amount flag)
 *   DRY_RUN=true   Simulate without submitting
 *   --yes-mainnet  Required to broadcast on a mainnet network
 */

import { ethers } from "hardhat";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : process.env[name.toUpperCase().replace(/-/g, "_")];
}

const YES_MAINNET = process.argv.includes("--yes-mainnet");
const DRY_RUN = process.env.DRY_RUN === "true";

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`distributeYield (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const amountStr = parseArg("amount") ?? parseArg("AMOUNT");
  if (!amountStr) throw new Error("Required: --amount=<18-decimal OkuM> or AMOUNT env var");
  const amount = BigInt(amountStr);
  if (amount <= 0n) throw new Error("--amount must be > 0");

  const okuMAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!okuMAddr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();

  const okuM = (await getDeployedContract("OkuMoney", okuMAddr)).connect(signer);

  const supplyBefore = await (okuM as any).totalSupply();
  const multiplierBefore = await (okuM as any).okuMMultiplier();
  const signerBalanceBefore = await (okuM as any).balanceOf(signerAddr);

  logger.info(`Signer: ${signerAddr}`);
  logger.info(`Total supply before: ${ethers.formatUnits(supplyBefore, 18)} OkuM`);
  logger.info(`Multiplier before: ${multiplierBefore}`);
  logger.info(`Signer balance before: ${ethers.formatUnits(signerBalanceBefore, 18)} OkuM`);
  logger.info(`Distributing yield: ${ethers.formatUnits(amount, 18)} OkuM`);

  if (supplyBefore === 0n) {
    throw new Error("Total supply is 0; distributeYield would revert with ZeroSupply");
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (okuM as any).distributeYield(amount);
  const receipt = await tx.wait(1);
  logger.success(`distributeYield tx: ${receipt.hash}`);

  const supplyAfter = await (okuM as any).totalSupply();
  const multiplierAfter = await (okuM as any).okuMMultiplier();
  const signerBalanceAfter = await (okuM as any).balanceOf(signerAddr);

  logger.success(`Total supply after: ${ethers.formatUnits(supplyAfter, 18)} OkuM`);
  logger.success(`Multiplier after:   ${multiplierAfter}`);
  logger.success(
    `Signer balance after: ${ethers.formatUnits(signerBalanceAfter, 18)} OkuM ` +
      `(+${ethers.formatUnits(signerBalanceAfter - signerBalanceBefore, 18)})`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
