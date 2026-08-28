/**
 * Read-only solvency report for USDOku / USDOkuWrapper.
 *
 * The headline number is `backingCoversLiability()`. Because
 * `MAX_SOLVENCY_GAP_BPS` is zero, that is a MAINTAINED invariant, not a
 * threshold — if it ever reads false, something is wrong at the contract
 * level and USDOku redemption is at risk. Alarm on it.
 *
 * Also reports the withdrawable surplus, which is the pre-funding that is not
 * currently committed to declared liability.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/solvencyStatus.ts --network base
 */

import { operatorContext, run, logger, ethers } from "./_shared";

run(async () => {
  const ctx = await operatorContext("solvencyStatus");
  const okuM = await ctx.at("OkuM");
  const usdOku = await ctx.at("USDOku");
  const wrapper = await ctx.at("USDOkuWrapper");

  const [
    liability,
    backing,
    gapBps,
    ratioBps,
    covers,
    surplus,
    mOku,
    mUsd,
    rateEnd,
    halted,
    wrapEnabled,
  ] = await Promise.all([
    (wrapper as any).declaredLiability(),
    (wrapper as any).realizedBacking(),
    (wrapper as any).solvencyGapBps(),
    (wrapper as any).backingRatioBps(),
    (wrapper as any).backingCoversLiability(),
    (wrapper as any).withdrawableSurplus(),
    (okuM as any).uiMultiplier(),
    (usdOku as any).usdOkuIndex(),
    (usdOku as any).usdRateEnd(),
    (usdOku as any).accrualHalted(),
    (wrapper as any).wrapEnabled(),
  ]);

  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

  logger.section("Indices");
  logger.info(`  M_oku (realized):  ${ethers.formatUnits(mOku, 18)}`);
  logger.info(`  M_usd (declared):  ${ethers.formatUnits(mUsd, 18)}`);

  logger.section("Solvency");
  logger.info(`  Declared liability: ${ethers.formatUnits(liability, 18)}`);
  logger.info(`  Realized backing:   ${ethers.formatUnits(backing, 18)}`);
  logger.info(`  Backing ratio:      ${ratioBps} bps`);
  logger.info(`  Solvency gap:       ${gapBps} bps (negative = surplus)`);
  logger.info(`  Withdrawable surplus: ${ethers.formatUnits(surplus, 18)} OkuM`);

  if (covers) {
    logger.success("  INVARIANT HOLDS: backing >= liability");
  } else {
    logger.error("  INVARIANT VIOLATED: backing < liability");
    logger.error("  USDOku redemption is at risk. Fund the wrapper immediately and");
    logger.error("  stop accrual (setUsdOkuRate --apr=0, always permitted).");
  }

  logger.section("Rate segment");
  if (halted) {
    logger.warning("  Accrual is HALTED (OKU_GUARDIAN). Cold resume required.");
  } else if (rateEnd <= now) {
    logger.warning(`  Rate segment EXPIRED at ${rateEnd} (now ${now}). M_usd is frozen.`);
  } else {
    const remaining = Number(rateEnd - now);
    logger.info(`  Active until ${rateEnd} (${(remaining / 86400).toFixed(2)} days remaining)`);
  }

  logger.section("Wrapper");
  logger.info(`  wrap enabled: ${wrapEnabled}${wrapEnabled ? "" : "  (sunset step 1 engaged)"}`);

  if (!covers) process.exitCode = 1;
});
