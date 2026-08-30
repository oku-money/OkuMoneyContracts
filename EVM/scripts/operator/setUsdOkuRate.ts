/**
 * Declare USDOku's forward-looking rate segment (VAULT_RATE_SETTER).
 *
 * Unlike OkuM's rear-facing rate, this one IS a forward declaration - a steady
 * headline rate that smooths over OkuM's bumpier realized performance. The wedge
 * between the two indices is the smoothing buffer, held as surplus OkuM in the
 * vault.
 *
 * PRE-FUNDING IS ENFORCED. `MAX_SOLVENCY_GAP_BPS == 0`, so the liability projected
 * to `end` must ALREADY be covered by OkuM the vault holds, valued at today's
 * M_oku. If this reverts WouldBreachBacking, deposit reserves first - do not lower
 * the ambition until you have checked whether funding is the right answer.
 *
 * A full stop (`--apr-bps=0`) skips the coverage check by design: an action that
 * only ever reduces liability must never be blocked by a coverage failure, or the
 * contract can lock itself out of the one lever that recovers it.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setUsdOkuRate.ts --network base \
 *       --apr-bps=450 --duration=2592000
 *
 * Environment:
 *   DRY_RUN=true   Simulate and print, do not submit
 */

import { ethers } from "hardhat";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import {
  operatorCtx,
  parseArg,
  ratePerSecondForAprBps,
  aprBpsForRatePerSecond,
  projectDisplay,
  PRECISION,
  MAX_RATE_PER_SECOND,
  MAX_RATE_DURATION,
} from "./_shared";

const DRY_RUN = process.env.DRY_RUN === "true";
const YES_MAINNET = process.argv.includes("--yes-mainnet");

async function main() {
  const ctx = await operatorCtx("setUsdOkuRate");
  if (!ctx.usdOku) throw new Error("USDOku not found in the address book");
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const block = await ethers.provider.getBlock("latest");
  const now = BigInt(block!.timestamp);

  const start = parseArg("start") ? BigInt(parseArg("start")!) : now;
  const durationArg = parseArg("duration");
  const end = parseArg("end")
    ? BigInt(parseArg("end")!)
    : start + (durationArg ? BigInt(durationArg) : MAX_RATE_DURATION);

  const base = parseArg("base")
    ? BigInt(parseArg("base")!)
    : BigInt(await ctx.usdOku.indexAt(start));

  const rate = parseArg("rate")
    ? BigInt(parseArg("rate")!)
    : ratePerSecondForAprBps(BigInt(parseArg("apr-bps") ?? "0"));

  if (rate < PRECISION || rate > MAX_RATE_PER_SECOND) {
    throw new Error(`rate ${rate} outside [${PRECISION}, ${MAX_RATE_PER_SECOND}]`);
  }
  if (end < start) throw new Error("end is before start");
  if (end - start > MAX_RATE_DURATION) {
    throw new Error(`window ${end - start}s exceeds MAX_RATE_DURATION ${MAX_RATE_DURATION}s`);
  }

  const okuMIndex: bigint = await ctx.okuM.uiMultiplier();
  const backing: bigint = await ctx.usdOku.realizedBacking();
  const liabilityNow: bigint = await ctx.usdOku.projectedLiabilityAtRateEnd();
  const totalShares: bigint = await ctx.usdOku.totalShares();

  // Project the liability this rate WOULD create, so the operator sees the funding
  // gap before the revert rather than after it.
  const projectedIndex = projectDisplay(base, rate, end - start);
  const projectedLiability = (Number(totalShares) / 1e18) * projectedIndex;
  const backingFloat = Number(backing) / 1e18;

  logger.info("");
  logger.info(`  M_oku (rear-facing)  ${ethers.formatUnits(okuMIndex, 18)}`);
  logger.info(`  M_usd base           ${ethers.formatUnits(base, 18)}`);
  logger.info(`  nominal APR          ${(Number(aprBpsForRatePerSecond(rate)) / 100).toFixed(4)}%`);
  logger.info(`  window               ${(Number(end - start) / 86400).toFixed(2)} days`);
  logger.info("");
  logger.info(`  shares outstanding   ${ethers.formatUnits(totalShares, 18)}`);
  logger.info(`  liability now        ${ethers.formatUnits(liabilityNow, 18)}`);
  logger.info(`  liability projected  ~${projectedLiability.toFixed(6)}`);
  logger.info(`  realized backing     ${backingFloat.toFixed(6)}`);

  if (rate > PRECISION && projectedLiability > backingFloat) {
    const shortfall = projectedLiability - backingFloat;
    logger.error(`  SHORTFALL ~${shortfall.toFixed(6)} - this will revert WouldBreachBacking.`);
    logger.error(`  Deposit ~${(shortfall / (Number(okuMIndex) / 1e18)).toFixed(6)} OkuM into the vault first.`);
    if (!DRY_RUN) throw new Error("projected liability exceeds backing");
  } else if (rate === PRECISION) {
    logger.warning("  Full stop (rate == PRECISION): coverage check is skipped by design.");
  } else {
    logger.success(`  Covered, headroom ~${(backingFloat - projectedLiability).toFixed(6)}`);
  }

  if (DRY_RUN) {
    logger.warning("DRY_RUN - not submitting.");
    return;
  }

  const tx = await ctx.usdOku.setUsdOkuRate(base, rate, start, end);
  const receipt = await tx.wait();
  logger.success(`setUsdOkuRate tx: ${receipt.hash}`);
}

main().catch((e) => {
  logger.error(e.message);
  process.exit(1);
});
