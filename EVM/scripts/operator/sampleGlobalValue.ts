/**
 * Cross-chain global value (V̄) sampler — run on a schedule (cron/CI) to build
 * the sample history `scripts/utils/globalValue.ts::samplesInWindow` /
 * `yieldRate.ts::timeWeightedAverage` need to compute a TIME-WEIGHTED average
 * dollar value for a given epoch, rather than a spot value at one instant.
 *
 * Recommended cadence: hourly. See EVM/README.md § Rear-Facing Epoch
 * Accounting for why the denominator must be time-weighted, and
 * TRACKER.md for the "reference implementation, not production design"
 * caveat on the on-disk sample store this appends to.
 *
 * Usage:
 *   npx hardhat run scripts/operator/sampleGlobalValue.ts
 *   CHAINS=base,arbitrum npx hardhat run scripts/operator/sampleGlobalValue.ts
 *
 * Env:
 *   CHAINS=base,arbitrum,...   chains to sample (default: all in the address book)
 */

import { logger } from "../utils/logger";
import { sampleGlobalValueUsd, appendSample } from "../utils/globalValue";

async function main() {
  logger.header("Cross-chain global value sample");

  const requested = process.env.CHAINS?.split(",").map((s) => s.trim()).filter(Boolean);
  const sample = await sampleGlobalValueUsd(requested);

  const chainsRead = Object.keys(sample.perChain);
  if (chainsRead.length === 0) {
    logger.error("No chains readable — check CHAINS and the address book");
    process.exit(1);
  }

  for (const [chain, valueUsd] of Object.entries(sample.perChain)) {
    logger.info(`${chain.padEnd(14)} $${valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`);
  }
  logger.success(
    `Global value at ${new Date(sample.timestampSec * 1000).toISOString()}: ` +
      `$${sample.valueUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })} ` +
      `(${chainsRead.length} chain(s))`
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
