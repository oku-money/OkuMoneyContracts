/**
 * Redeem rUSDOku for USDC through the PSM.
 *
 * Replaces v0.2's `redeemOkuM.ts`.
 *
 * TWO MODES, and the difference matters:
 *
 *   --raw <amount>   Redeem an exact raw amount. `--raw max` uses the caller's
 *                    full `balanceOf`, which clears the balance EXACTLY.
 *   --ui <amount>    Redeem by dollar amount via `redeemUiAmount`. Convenient,
 *                    but it converts UI -> raw with a floor, so passing your
 *                    displayed balance leaves up to a wei behind.
 *
 * THE MAX-SEND RULE: for a true max-redeem always use `--raw max`. Deriving the
 * amount from the displayed balance is the shape of the May-2026 Sepolia
 * incident — see `test/psm/MaxSend.t.sol` before changing any of this.
 *
 * If the PSM's USDC buffer cannot cover the payout the redemption is QUEUED
 * rather than settled, and this script reports that. A queued holder keeps
 * earning: the escrowed raw amount appreciates with the multiplier.
 *
 * Usage:
 *   npx hardhat run scripts/operator/psmRedeem.ts --network sepolia --raw max
 *   npx hardhat run scripts/operator/psmRedeem.ts --network sepolia --raw 95.238095
 *   npx hardhat run scripts/operator/psmRedeem.ts --network sepolia --ui 100
 */

import { ethers } from "hardhat";

import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { DRY_RUN, parseArg, runScript, setup, submit } from "./_shared";

async function main() {
  const { contract: psm, signer } = await setup("psmRedeem", "LitePSM");

  const tokenAddr = await (psm as any).okuDollar();
  const token = (await getDeployedContract("OkuDollar", tokenAddr)).connect(signer) as any;

  const rawArg = parseArg("raw");
  const uiArg = parseArg("ui");
  if (!!rawArg === !!uiArg) {
    throw new Error("Provide exactly one of --raw=<amount|max> or --ui=<dollars>");
  }

  const who = await signer.getAddress();
  const rawBalance: bigint = await token.balanceOf(who);
  const uiBalance: bigint = await token.balanceOfUI(who);
  const multiplier: bigint = await token.uiMultiplier();

  logger.info(`Caller:        ${who}`);
  logger.info(`uiMultiplier:  ${ethers.formatEther(multiplier)}`);
  logger.info(`Raw balance:   ${ethers.formatEther(rawBalance)}`);
  logger.info(`UI balance:    $${ethers.formatEther(uiBalance)}`);

  const psmAddress = await (psm as any).getAddress();
  const redeemableNow: bigint = await (psm as any).redeemableNow();
  logger.info(`Instant capacity (raw): ${ethers.formatEther(redeemableNow)}`);

  let rawAmount: bigint;
  let useUiEntrypoint = false;
  let uiAmount = 0n;

  if (rawArg) {
    rawAmount = rawArg === "max" ? rawBalance : ethers.parseEther(rawArg);
    if (rawArg === "max") {
      logger.info("Using --raw max: derived from balanceOf, so the balance clears exactly.");
    }
  } else {
    uiAmount = ethers.parseEther(uiArg!);
    rawAmount = await token.fromUIAmount(uiAmount);
    useUiEntrypoint = true;
    logger.warning(
      `--ui floors the UI->raw conversion (${ethers.formatEther(uiAmount)} -> ` +
        `${ethers.formatEther(rawAmount)} raw). For a true max-redeem use --raw max.`
    );
  }

  if (rawAmount === 0n) throw new Error("Resolved raw amount is zero");
  if (rawAmount > rawBalance) {
    throw new Error(
      `Requested ${ethers.formatEther(rawAmount)} raw but balance is ` +
        `${ethers.formatEther(rawBalance)}`
    );
  }

  const quoted: bigint = await (psm as any).quoteRedeem(rawAmount);
  logger.info(`Quoted USDC out: ${ethers.formatUnits(quoted, 6)}`);
  if (rawAmount > redeemableNow) {
    logger.warning("Buffer is short — this redemption will be QUEUED, not settled.");
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("approve", () => token.approve(psmAddress, rawAmount));
  if (useUiEntrypoint) {
    await submit("redeemUiAmount", () => (psm as any).redeemUiAmount(uiAmount));
  } else {
    await submit("redeem", () => (psm as any).redeem(rawAmount));
  }

  const residual: bigint = await token.balanceOf(who);
  logger.success(`Residual raw balance: ${ethers.formatEther(residual)}`);
  if (rawArg === "max" && residual !== 0n) {
    logger.warning(`Expected 0 residual after --raw max, got ${residual}`);
  }
}

runScript(main);
