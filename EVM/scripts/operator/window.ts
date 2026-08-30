/**
 * Open or close the PSM's permissionless conversion window (PSM_GATEKEEPER).
 *
 * This is the KMS back-end's routine lever, distinct from `pause()`. Closing is the
 * precondition for publishing an OkuM rate, which is what keeps rate publication and
 * trading disjoint without an on-chain calendar.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/window.ts --network base --action=close
 *   NETWORK=base npx hardhat run scripts/operator/window.ts --network base --action=open
 *   NETWORK=base npx hardhat run scripts/operator/window.ts --network base --action=status
 */

import { ethers } from "hardhat";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { operatorCtx, parseArg } from "./_shared";

const DRY_RUN = process.env.DRY_RUN === "true";
const YES_MAINNET = process.argv.includes("--yes-mainnet");

async function main() {
  const ctx = await operatorCtx("window");
  const action = (parseArg("action") ?? "status").toLowerCase();

  const mintEnabled: boolean = await ctx.litePSM.mintEnabled();
  const redeemEnabled: boolean = await ctx.litePSM.redeemEnabled();
  const paused: boolean = await ctx.litePSM.paused();
  const open: boolean = await ctx.litePSM.conversionsOpen();
  const available: bigint = await ctx.litePSM.availableToRedeem();

  logger.info(`  mintEnabled       ${mintEnabled}`);
  logger.info(`  redeemEnabled     ${redeemEnabled}`);
  logger.info(`  paused            ${paused}`);
  logger.info(`  conversionsOpen   ${open}`);
  logger.info(`  availableToRedeem ${ethers.formatUnits(available, 6)} USDC`);

  if (action === "status") return;
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  if (DRY_RUN) {
    logger.warning(`DRY_RUN - would ${action} the window.`);
    return;
  }

  if (action === "close") {
    const receipt = await (await ctx.litePSM.closeWindow()).wait();
    logger.success(`closeWindow tx: ${receipt.hash}`);
  } else if (action === "open") {
    const receipt = await (await ctx.litePSM.openWindow()).wait();
    logger.success(`openWindow tx: ${receipt.hash}`);
  } else {
    throw new Error(`Unknown --action=${action}. Use open | close | status.`);
  }
}

main().catch((e) => {
  logger.error(e.message);
  process.exit(1);
});
