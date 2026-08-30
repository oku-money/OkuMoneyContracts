/**
 * Read-only solvency and accrual report. No transaction, no role required.
 *
 * Use before any rate change and as a monitoring probe. The line that matters is
 * `backingCoversLiability` - with MAX_SOLVENCY_GAP_BPS == 0 it is a MAINTAINED
 * invariant, so a false here means something is wrong rather than merely tight.
 */

import { ethers } from "hardhat";
import { logger } from "../utils/logger";
import { operatorCtx, projectDisplay } from "./_shared";

async function main() {
  const ctx = await operatorCtx("solvencyStatus");
  const block = await ethers.provider.getBlock("latest");
  const now = BigInt(block!.timestamp);

  const m: bigint = await ctx.okuM.uiMultiplier();
  const seg = await ctx.okuM.activeSegment();
  const pending = await ctx.okuM.pendingSegment();
  const halted: boolean = await ctx.okuM.accrualHalted();
  const supply: bigint = await ctx.okuM.totalSupply();

  logger.info("  OkuM");
  logger.info(`    uiMultiplier     ${ethers.formatUnits(m, 18)}`);
  logger.info(`    totalSupply      ${ethers.formatUnits(supply, 18)} OkuM`);
  logger.info(`    dollar value     ${ethers.formatUnits((supply * m) / 10n ** 18n, 18)}`);
  logger.info(`    segment start    ${seg.startTime}`);
  logger.info(`    segment end      ${seg.endTime}`);
  logger.info(`    accrualHalted    ${halted}`);
  if (now > seg.endTime) {
    logger.warning(`    FLATLINED - accrual stopped ${now - BigInt(seg.endTime)}s ago`);
  } else {
    const remaining = BigInt(seg.endTime) - now;
    logger.info(`    time remaining   ${(Number(remaining) / 86400).toFixed(2)} days`);
    logger.info(
      `    index at end     ~${projectDisplay(BigInt(seg.baseIndex), BigInt(seg.ratePerSecond), BigInt(seg.endTime) - BigInt(seg.startTime)).toFixed(12)}`
    );
  }
  if (BigInt(pending.startTime) > now) {
    logger.info(`    PENDING segment  starts ${pending.startTime}, base ${ethers.formatUnits(pending.baseIndex, 18)}`);
  }

  if (ctx.usdOku) {
    const idx: bigint = await ctx.usdOku.usdOkuIndex();
    const projected: bigint = await ctx.usdOku.projectedIndexAtRateEnd();
    const liability: bigint = await ctx.usdOku.projectedLiabilityAtRateEnd();
    const backing: bigint = await ctx.usdOku.realizedBacking();
    const covers: boolean = await ctx.usdOku.backingCoversLiability();
    const surplus: bigint = await ctx.usdOku.withdrawableSurplus();

    logger.info("");
    logger.info("  USDOku");
    logger.info(`    usdOkuIndex      ${ethers.formatUnits(idx, 18)}`);
    logger.info(`    projected @ end  ${ethers.formatUnits(projected, 18)}`);
    logger.info(`    fwd liability    ${ethers.formatUnits(liability, 18)}`);
    logger.info(`    realized backing ${ethers.formatUnits(backing, 18)}`);
    logger.info(`    withdrawable     ${ethers.formatUnits(surplus, 18)} OkuM`);

    // The smoothing wedge, stated explicitly: this is the product dial, not an
    // accounting artefact.
    if (m > idx) {
      logger.info(`    wedge            M_oku ahead of M_usd - surplus ACCUMULATING`);
    } else if (idx > m) {
      logger.info(`    wedge            M_usd ahead of M_oku - surplus DRAWING DOWN`);
    }

    if (covers) {
      logger.success(`    backingCoversLiability: true`);
    } else {
      logger.error(`    backingCoversLiability: FALSE - invariant breached, investigate`);
    }
  }

  logger.info("");
  logger.info("  LitePSM");
  logger.info(`    conversionsOpen  ${await ctx.litePSM.conversionsOpen()}`);
  logger.info(`    availableToRedeem ${ethers.formatUnits(await ctx.litePSM.availableToRedeem(), 6)} USDC`);
}

main().catch((e) => {
  logger.error(e.message);
  process.exit(1);
});
