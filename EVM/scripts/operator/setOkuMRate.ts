/**
 * Declare an OkuM accrual segment (OKUM_RATE_SETTER).
 *
 * THE highest-consequence operator action: it sets the price every permissionless
 * conversion executes at, on every chain.
 *
 * ## Multichain
 *
 * A segment is anchored to ABSOLUTE wall-clock time, so publishing the identical
 * four parameters on every chain yields an identical multiplier everywhere at every
 * instant - no messaging, no oracle, no sync window. Pass an explicit `--start` in
 * the FUTURE and run this against each network in turn; all chains then switch
 * simultaneously by wall clock, regardless of when each transaction lands.
 *
 * Print the exact parameters once with --dry-run, then reuse them verbatim per
 * chain. Do NOT re-derive `--base` per chain: that is what makes the chains agree.
 *
 * ## Rear-facing discipline
 *
 * The rate must distribute yield ALREADY BANKED, never a forecast. `--realized`
 * records the backing figure on-chain for audit reconciliation. It is logged, not
 * enforced - nothing on-chain can verify off-chain RWA.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setOkuMRate.ts --network base \
 *       --apr-bps=500 --duration=2592000 --realized=412000
 *
 *   # Explicit params for a synchronised multichain switchover:
 *   --base=1004110000000000000 --rate=1000000001585489599 --start=1730000000 --end=1732592000
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
  const ctx = await operatorCtx("setOkuMRate");
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const block = await ethers.provider.getBlock("latest");
  const now = BigInt(block!.timestamp);

  const start = parseArg("start") ? BigInt(parseArg("start")!) : now;
  const durationArg = parseArg("duration");
  const end = parseArg("end")
    ? BigInt(parseArg("end")!)
    : start + (durationArg ? BigInt(durationArg) : MAX_RATE_DURATION);

  // `base` defaults to the index the LIVE segment already reaches at `start`, which
  // makes the curve seamless. Supply it explicitly when synchronising chains.
  const base = parseArg("base")
    ? BigInt(parseArg("base")!)
    : BigInt(await ctx.okuM.indexAt(start));

  const rate = parseArg("rate")
    ? BigInt(parseArg("rate")!)
    : ratePerSecondForAprBps(BigInt(parseArg("apr-bps") ?? "0"));

  const realized = parseArg("realized")
    ? ethers.parseUnits(parseArg("realized")!, 18)
    : 0n;

  // --- Local validation, mirroring the contract's, so failures are legible ---
  if (rate < PRECISION || rate > MAX_RATE_PER_SECOND) {
    throw new Error(
      `rate ${rate} outside [${PRECISION}, ${MAX_RATE_PER_SECOND}] ` +
        `(implied APR ${aprBpsForRatePerSecond(rate)} bps exceeds the cap)`
    );
  }
  if (end < start) throw new Error("end is before start");
  if (end - start > MAX_RATE_DURATION) {
    throw new Error(`window ${end - start}s exceeds MAX_RATE_DURATION ${MAX_RATE_DURATION}s`);
  }

  const liveAtStart = BigInt(await ctx.okuM.indexAt(start));
  if (base < liveAtStart) {
    throw new Error(`base ${base} is BELOW the live index at start ${liveAtStart}`);
  }

  const current = BigInt(await ctx.okuM.uiMultiplier());
  const projectedEnd = projectDisplay(base, rate, end - start);
  const aprBps = aprBpsForRatePerSecond(rate);

  logger.info("");
  logger.info("  Segment");
  logger.info(`    base           ${ethers.formatUnits(base, 18)}`);
  logger.info(`    ratePerSecond  ${rate}`);
  logger.info(`    start          ${start}  (${new Date(Number(start) * 1000).toISOString()})`);
  logger.info(`    end            ${end}  (${new Date(Number(end) * 1000).toISOString()})`);
  logger.info(`    window         ${(Number(end - start) / 86400).toFixed(2)} days`);
  logger.info("");
  logger.info("  Implied");
  logger.info(`    nominal APR    ${(Number(aprBps) / 100).toFixed(4)}%`);
  logger.info(`    index at end   ~${projectedEnd.toFixed(12)} (display only)`);
  logger.info(`    current index  ${ethers.formatUnits(current, 18)}`);
  logger.info(`    realized bkg   ${ethers.formatUnits(realized, 18)} (logged, not enforced)`);
  logger.info("");

  if (realized === 0n) {
    logger.warning("  --realized is 0. The rate MUST distribute already-banked yield;");
    logger.warning("  record the figure so an auditor can reconcile it later.");
  }

  // The window must be shut. Report it rather than letting the revert explain.
  const open: boolean = await ctx.litePSM.conversionsOpen();
  if (open) {
    logger.error("  Conversion window is OPEN - setOkuMRate will revert.");
    logger.error("  Run `closeWindow.ts`, publish, then `openWindow.ts`.");
    if (!DRY_RUN) throw new Error("conversion window is open");
  }

  if (DRY_RUN) {
    logger.warning("DRY_RUN - not submitting.");
    logger.info("");
    logger.info("  Reuse these EXACT parameters on every other chain:");
    logger.info(`    --base=${base} --rate=${rate} --start=${start} --end=${end}`);
    return;
  }

  const tx = await ctx.okuM.setOkuMRate(base, rate, start, end, realized);
  const receipt = await tx.wait();
  logger.success(`setOkuMRate tx: ${receipt.hash}`);
  logger.info("");
  logger.info("  Same parameters for the remaining chains:");
  logger.info(`    --base=${base} --rate=${rate} --start=${start} --end=${end}`);
}

main().catch((e) => {
  logger.error(e.message);
  process.exit(1);
});
