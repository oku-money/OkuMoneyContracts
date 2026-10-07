/**
 * Cross-chain global value (V̄) sampler — run on a schedule (cron/CI) to build
 * the sample history `scripts/utils/globalValue.ts::samplesInWindow` /
 * `yieldRate.ts::timeWeightedAverage` need to compute a TIME-WEIGHTED average
 * dollar value for a given epoch, rather than a spot value at one instant.
 *
 * Recommended cadence: hourly. See EVM/docs/epoch-accounting.md for why the denominator must be time-weighted, and
 * TRACKER.md for the "reference implementation, not production design"
 * caveat on the on-disk sample store this appends to.
 *
 * Usage:
 *   npx hardhat run scripts/operator/sampleGlobalValue.ts
 *   CHAINS=sepolia,baseSepolia npx hardhat run scripts/operator/sampleGlobalValue.ts
 *
 * Env:
 *   CHAINS=sepolia,baseSepolia,...  chains to sample. Default AND explicit
 *     values both resolve through `config/epochChains.ts::participatingChains()`
 *     — the same set `broadcastSchedule.ts` targets, so V̄'s denominator can
 *     never cover a different set of chains than the rate is published to.
 *     Unknown chain names are rejected; mainnets require `YES_MAINNET=true`.
 *   SVM_EXPECTED=true / SVM_RPC_URL + SVM_LITE_PSM_PROGRAM_ID + SVM_OKU_M_MINT
 *     SVM is in the expected set when configured or SVM_EXPECTED=true
 *     (`config/epochChains.ts::expectedValueChains()`).
 *
 * All-or-nothing: if ANY expected chain is unreadable or has no address, the
 * run fails (exit 1) and NOTHING is appended — a partial sum would lower V̄
 * and inflate every rate derived from the window. Each persisted sample
 * records the chain set it covers (`chains`); derivation rejects samples
 * whose set differs from the current expected set.
 */

import { logger } from "../utils/logger";
import { sampleGlobalValueUsd, appendSample } from "../utils/globalValue";
import { parseChainsEnv } from "../config/epochChains";

async function main() {
  logger.header("Cross-chain global value sample");

  // `parseChainsEnv`, not an inline split: an empty `CHAINS=` must mean "use
  // the default participating set", not "sample nothing". The inline form
  // yields `[]`, which is a valid-looking empty scope that would produce a
  // zero-chain V̄ sample rather than falling back.
  const requested = parseChainsEnv(process.env.CHAINS);
  // Throws (-> exit 1, nothing appended) unless EVERY expected chain was read.
  const sample = await sampleGlobalValueUsd(requested);
  const chainsRead = Object.keys(sample.perChain);

  for (const [chain, valueUsd] of Object.entries(sample.perChain)) {
    logger.info(`${chain.padEnd(14)} $${valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }
  logger.success(
    `Global value at ${new Date(sample.timestampSec * 1000).toISOString()}: ` +
      `$${sample.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} ` +
      `(all ${chainsRead.length} expected chain(s): ${(sample.chains ?? chainsRead).join(", ")})`
  );

  appendSample(sample);
  logger.info("Sample appended to scripts/config/globalValueSamples.json");
}

if (require.main === module) {
  main().catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
}
