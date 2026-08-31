/**
 * Declare an OkuM accrual segment (OKUM_RATE_SETTER).
 *
 * THE highest-consequence operator action: it sets the price every permissionless
 * conversion executes at, on every chain.
 *
 * ## Two disjoint shapes
 *
 * The contract distinguishes ROUTINE declarations (`base == indexAt(start)` exactly)
 * from CATCH-UP re-anchors (`base` up to `MAX_REANCHOR_BPS` above it). Routine
 * declarations may schedule `--start` in the future, for multichain switchover.
 * Catch-up may ONLY take effect immediately - pass `--start=0` (or omit it) to mean
 * "now"; the contract resolves the sentinel on-chain since an operator cannot
 * predict the exact mined timestamp. Backdating `--start` into the past is always
 * rejected.
 *
 * ## Multichain (routine path)
 *
 * A segment is anchored to ABSOLUTE wall-clock time, so publishing the identical
 * four parameters on every chain yields an identical multiplier everywhere at every
 * instant - no messaging, no oracle, no sync window. Pass an explicit `--start` in
 * the FUTURE and run this against each network in turn; all chains then switch
 * simultaneously by wall clock, regardless of when each transaction lands.
 *
 * Print the exact parameters once with --dry-run, then reuse them verbatim per
 * chain. Do NOT re-derive `--base` per chain: that is what makes the chains agree.
 * NEVER reuse a `--start=0` (or a resolved "now") run's parameters across chains -
 * each chain would resolve a DIFFERENT local timestamp, silently breaking sync. The
 * sentinel is for single-chain catch-up only; this script refuses to print
 * multichain-reuse parameters when it was used.
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

  // Explicit --start is required for a routine, multichain-reusable declaration.
  // Omitting it means "now" - submitted on-chain as the `0` sentinel (NOT a
  // locally-computed timestamp), since the contract requires EXACT equality with
  // `block.timestamp` for a catch-up re-anchor and an operator cannot predict the
  // mined timestamp. `now` below is used only for local validation/display.
  const startArg = parseArg("start");
  const startExplicit = startArg !== undefined;
  const start = startExplicit ? BigInt(startArg!) : now;
  const onChainStart = startExplicit ? start : 0n;
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

  // `setOkuMRate` does not gate on the PSM window - a routine declaration moves
  // slope, not level, so an open window exposes nothing. Informational only.
  const open: boolean = await ctx.litePSM.conversionsOpen();
  logger.info(`  Conversion window open: ${open} (no longer a precondition)`);

  // The sentinel resolves to a DIFFERENT local timestamp on every chain, which
  // silently breaks multichain sync if reused verbatim. It is for single-chain
  // catch-up only, so never print it as a reusable parameter set.
  const reusableAcrossChains = startExplicit;

  if (DRY_RUN) {
    logger.warning("DRY_RUN - not submitting.");
    logger.info("");
    if (reusableAcrossChains) {
      logger.info("  Reuse these EXACT parameters on every other chain:");
      logger.info(`    --base=${base} --rate=${rate} --start=${start} --end=${end}`);
    } else {
      logger.warning("  --start was omitted (sentinel 0 = \"now\"). This run is for a");
      logger.warning("  SINGLE-CHAIN catch-up only - do NOT reuse these parameters on");
      logger.warning("  other chains; each would resolve a different local timestamp.");
    }
    return;
  }

  const tx = await ctx.okuM.setOkuMRate(base, rate, onChainStart, end, realized);
  const receipt = await tx.wait();
  logger.success(`setOkuMRate tx: ${receipt.hash}`);
  logger.info("");
  if (reusableAcrossChains) {
    logger.info("  Same parameters for the remaining chains:");
    logger.info(`    --base=${base} --rate=${rate} --start=${start} --end=${end}`);
  } else {
    logger.warning("  Single-chain catch-up (sentinel start) - not reusable on other chains.");
  }
}

main().catch((e) => {
  logger.error(e.message);
  process.exit(1);
});
