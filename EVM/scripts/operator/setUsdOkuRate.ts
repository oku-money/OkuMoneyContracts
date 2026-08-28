/**
 * Declare USDOku's forward accrual rate (`OKU_RATE_SETTER`).
 *
 * THE RATE MUST BE PRE-FUNDED. `MAX_SOLVENCY_GAP_BPS` is zero, so
 * `setUsdOkuRate` reverts unless `USDOkuWrapper` already holds OkuM covering
 * the liability this rate projects at `endTimestamp`. The operational
 * sequence is:
 *
 *   1. scripts/operator/solvencyStatus.ts      - see the shortfall
 *   2. scripts/operator/fundWrapper.ts         - transfer OkuM into the wrapper
 *   3. this script                             - declare the rate
 *
 * This script computes the projected shortfall up front and refuses to submit
 * if funding is missing, so the failure is legible instead of a bare revert.
 *
 * A full stop (`--apr=0`) is ALWAYS permitted regardless of funding — that is
 * the escape hatch for when funding lapses.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setUsdOkuRate.ts --network base \
 *       --apr=500 --days=30           # 5.00% nominal for 30 days
 *   NETWORK=base npx hardhat run scripts/operator/setUsdOkuRate.ts --network base \
 *       --apr=0 --days=1              # full stop
 *
 * Flags:
 *   --apr=<bps>       nominal annualised rate in bps, 0 = stop (required)
 *   --days=<n>        segment length, max 30 (default 30)
 *   DRY_RUN=true      simulate without submitting
 */

import { operatorContext, submit, requireArg, arg, run, logger, ethers } from "./_shared";

const PRECISION = 10n ** 18n;
const SECONDS_PER_YEAR = 365n * 24n * 3600n;
const BPS = 10_000n;
const MAX_IMPLIED_APR_BPS = 1000n;
const MAX_RATE_DAYS = 30n;

/** Mirrors Constants.MAX_USD_RATE_PER_SECOND derivation. */
function ratePerSecondForAprBps(aprBps: bigint): bigint {
  if (aprBps === 0n) return PRECISION;
  return PRECISION + ((PRECISION * aprBps) / BPS) / SECONDS_PER_YEAR;
}

run(async () => {
  const ctx = await operatorContext("setUsdOkuRate");
  const usdOku = await ctx.at("USDOku");
  const wrapper = await ctx.at("USDOkuWrapper");

  const aprBps = BigInt(requireArg("apr", "nominal bps, 0 to stop"));
  const days = arg("days") ? BigInt(arg("days")!) : MAX_RATE_DAYS;

  if (aprBps > MAX_IMPLIED_APR_BPS) {
    throw new Error(`--apr=${aprBps} exceeds MAX_IMPLIED_APR_BPS (${MAX_IMPLIED_APR_BPS})`);
  }
  if (days === 0n || days > MAX_RATE_DAYS) {
    throw new Error(`--days must be in 1..${MAX_RATE_DAYS} (MAX_RATE_DURATION)`);
  }

  if (await (usdOku as any).accrualHalted()) {
    throw new Error("Accrual is halted. Call resumeUsdOkuAccrual (OKU_ACCRUAL_RESUMER, cold) first.");
  }

  const rate = ratePerSecondForAprBps(aprBps);
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const endTimestamp = now + days * 24n * 3600n;
  const isStop = aprBps === 0n;

  const liability: bigint = await (wrapper as any).declaredLiability();
  const backing: bigint = await (wrapper as any).realizedBacking();

  logger.info(`Rate:            ${aprBps} bps nominal (${rate} per second)`);
  logger.info(`Segment:         ${days} days, ends ${endTimestamp}`);
  logger.info(`Declared liability: ${ethers.formatUnits(liability, 18)}`);
  logger.info(`Realized backing:   ${ethers.formatUnits(backing, 18)}`);

  if (isStop) {
    logger.warning("Full stop (apr=0): permitted regardless of funding.");
  } else {
    // Projected liability at rateEnd == liability * (rate ^ seconds) / PRECISION.
    // Approximated here with simple interest, which slightly UNDER-estimates the
    // compounded figure - so treat a near-miss as a miss and fund generously.
    const seconds = days * 24n * 3600n;
    const growthBps = ((rate - PRECISION) * seconds * BPS) / PRECISION;
    const projected = liability + (liability * growthBps) / BPS;

    logger.info(`Projected liability at rateEnd (approx): ${ethers.formatUnits(projected, 18)}`);

    if (projected > backing) {
      const shortfall = projected - backing;
      logger.error(`UNFUNDED by approximately ${ethers.formatUnits(shortfall, 18)} dollars of OkuM.`);
      logger.error("Run scripts/operator/fundWrapper.ts to transfer OkuM into the wrapper first.");
      throw new Error("Refusing to submit an unfunded rate (would revert SolvencyGapExceeded)");
    }
    logger.success(`Funded. Headroom: ${ethers.formatUnits(backing - projected, 18)} dollars.`);
  }

  await submit("setUsdOkuRate", () => (usdOku as any).setUsdOkuRate(rate, endTimestamp));

  if (!process.env.DRY_RUN) {
    logger.success(`Confirmed M_usd index: ${ethers.formatUnits(await (usdOku as any).usdOkuIndex(), 18)}`);
    logger.success(`Confirmed rateEnd:     ${await (usdOku as any).usdRateEnd()}`);
  }
});
