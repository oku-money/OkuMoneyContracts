/**
 * Subscribe: mint OkuM from USDC through the SubscriptionModule. Permissionless
 * — any USDC holder can call this; the script exists for smoke-testing a fresh
 * deploy.
 *
 * File name kept as `psmMint.ts` despite the `LitePSM -> SubscriptionModule`
 * rename: the npm alias (`operator:mint`) and the runbook both reference it, and
 * churning the path would break every bookmark for no behavioural gain.
 *
 *   raw = (usdcAmount * usdcDecimalMultiplier) * PRECISION / uiMultiplier()
 *
 * At `M_oku` = 1.05, depositing 100 USDC yields ~95.24 raw, which DISPLAYS as
 * $100.00. If you are looking at a wallet that does not understand ERC-8056 you
 * will see 95.24, not 100 — that is correct, not a bug. USDOku exists precisely
 * so that holders who need a wallet-native $100.00 can have one; wrap the OkuM
 * afterwards if that is what you want.
 *
 * `tin` is applied BEFORE conversion. The full deposit still enters the buffer;
 * the fee portion simply has no OkuM minted against it, which is how the fee
 * accretes to the collateral ratio with no recipient account. `quoteMint` is
 * fee-inclusive, so the number this script prints is the number you get.
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
  const { contract: moduleContract, signer, bookKey } =
    await setup("psmMint", "SubscriptionModule");

  const usdcAddr = loadAddress(bookKey, "MockUSDC") ?? (await (moduleContract as any).usdc());
  const usdc = (await getDeployedContract("MockUSDC", usdcAddr)).connect(signer) as any;
  const tokenAddr = await (moduleContract as any).okuM();
  const okuM = (await getDeployedContract("OkuM", tokenAddr)) as any;

  const decimals: number = Number(await usdc.decimals());
  const amount = ethers.parseUnits(requireArg("usdc"), decimals);

  const who = await signer.getAddress();
  const multiplier: bigint = await okuM.uiMultiplier();
  const quoted: bigint = await (moduleContract as any).quoteMint(amount);
  const tin: bigint = await (moduleContract as any).tin();

  logger.info(`Caller:          ${who}`);
  logger.info(`USDC in:         ${ethers.formatUnits(amount, decimals)}`);
  logger.info(`tin:             ${tin}bps (already reflected in the quote)`);
  logger.info(`M_oku:           ${ethers.formatEther(multiplier)}`);
  logger.info(`Quoted raw out:  ${ethers.formatEther(quoted)}`);
  logger.info(`Displays as:     $${ethers.formatEther(await okuM.toUIAmount(quoted))}`);

  // The sync window is the one revert an otherwise-valid mint hits, and it is
  // transient by construction — worth naming rather than surfacing as an opaque
  // failure.
  if (await okuM.isSyncLocked()) {
    const until: bigint = await okuM.syncLockedUntil();
    throw new Error(
      `A multiplier step is propagating: the module reverts SyncWindowActive until ` +
        `${new Date(Number(until) * 1000).toISOString()}. This is bounded and ` +
        `auto-expiring (MAX_SYNC_WINDOW is 15 minutes) — retry, do not treat it as ` +
        `an outage.`
    );
  }
  if (await (moduleContract as any).paused()) {
    throw new Error("SubscriptionModule is paused — mint and redeem are blocked.");
  }

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

  const moduleAddress = await (moduleContract as any).getAddress();
  await submit("approve", () => usdc.approve(moduleAddress, amount));
  await submit("mint", () => (moduleContract as any).mint(amount));

  const rawAfter: bigint = await okuM.balanceOf(who);
  logger.success(`Raw balance:  ${ethers.formatEther(rawAfter)} OkuM`);
  logger.success(`UI balance:   $${ethers.formatEther(await okuM.balanceOfUI(who))}`);
}

runScript(main);
