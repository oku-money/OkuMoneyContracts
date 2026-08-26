/**
 * Redeem OkuM for USDC through the SubscriptionModule.
 *
 * File name kept as `psmRedeem.ts` across the `LitePSM -> SubscriptionModule`
 * rename; see psmMint.ts for why.
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
 * `InsufficientBalance()` incident — see `test/psm/MaxSend.t.sol` before
 * changing any of this. It stays benign only because `fromUIAmount` floors;
 * "fixing" the dust by rounding up makes it revert.
 *
 * If the module's USDC buffer cannot cover the payout the redemption is QUEUED
 * rather than settled, and this script reports that. A queued holder keeps
 * earning: the escrowed raw amount appreciates with `M_oku`, and settlement
 * charges the LOWER of the fee snapshotted at enqueue and the fee prevailing at
 * processing.
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
  const { contract: moduleContract, signer } =
    await setup("psmRedeem", "SubscriptionModule");

  const tokenAddr = await (moduleContract as any).okuM();
  const okuM = (await getDeployedContract("OkuM", tokenAddr)).connect(signer) as any;

  const rawArg = parseArg("raw");
  const uiArg = parseArg("ui");
  if (!!rawArg === !!uiArg) {
    throw new Error("Provide exactly one of --raw=<amount|max> or --ui=<dollars>");
  }

  const who = await signer.getAddress();
  const rawBalance: bigint = await okuM.balanceOf(who);
  const uiBalance: bigint = await okuM.balanceOfUI(who);
  const multiplier: bigint = await okuM.uiMultiplier();
  const tout: bigint = await (moduleContract as any).tout();

  logger.info(`Caller:        ${who}`);
  logger.info(`M_oku:         ${ethers.formatEther(multiplier)}`);
  logger.info(`tout:          ${tout}bps (already reflected in the quote)`);
  logger.info(`Raw balance:   ${ethers.formatEther(rawBalance)} OkuM`);
  logger.info(`UI balance:    $${ethers.formatEther(uiBalance)}`);

  if (await okuM.isSyncLocked()) {
    const until: bigint = await okuM.syncLockedUntil();
    throw new Error(
      `A multiplier step is propagating: the module reverts SyncWindowActive until ` +
        `${new Date(Number(until) * 1000).toISOString()}. Bounded and auto-expiring — retry.`
    );
  }

  const moduleAddress = await (moduleContract as any).getAddress();
  const redeemableNow: bigint = await (moduleContract as any).redeemableNow();
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
    rawAmount = await okuM.fromUIAmount(uiAmount);
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

  const usdcDecimals = Number(
    await (await ethers.getContractAt("MockUSDC", await okuM.asset())).decimals()
  );
  const quoted: bigint = await (moduleContract as any).quoteRedeem(rawAmount);
  logger.info(`Quoted USDC out: ${ethers.formatUnits(quoted, usdcDecimals)}`);
  if (rawAmount > redeemableNow) {
    logger.warning(
      "Buffer is short — this redemption will be QUEUED, not settled, and this " +
        "script will report 0 USDC received. The escrowed OkuM keeps appreciating " +
        "with M_oku while it waits."
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("approve", () => okuM.approve(moduleAddress, rawAmount));
  if (useUiEntrypoint) {
    await submit("redeemUiAmount", () => (moduleContract as any).redeemUiAmount(uiAmount));
  } else {
    await submit("redeem", () => (moduleContract as any).redeem(rawAmount));
  }

  const residual: bigint = await okuM.balanceOf(who);
  logger.success(`Residual raw balance: ${ethers.formatEther(residual)}`);
  if (rawArg === "max" && residual !== 0n) {
    logger.warning(`Expected 0 residual after --raw max, got ${residual}`);
  }
}

runScript(main);
