/**
 * Cross-chain multiplier drift monitor (read-only).
 *
 * Nothing on-chain enforces that every chain carries the same yield schedule —
 * each OkuMoney deployment is fully independent, with no messaging between them.
 * Cross-chain multiplier agreement rests entirely on the operator pushing
 * identical schedule state everywhere. This script is the detection layer.
 *
 * `okuMMultiplier()` is a pure function of (schedule state, block.timestamp), and
 * block.timestamp is wall-clock on every EVM chain. So given identical schedules,
 * every chain MUST return the same integer at the same instant. Any divergence is
 * an operator fault, and it is one-way: the multiplier is monotonic, so a chain
 * that ran hot can only be met by running the laggards hot to catch up.
 *
 * Checks per chain:
 *   - okuMMultiplier()        cross-chain equality is the single catch-all check
 *   - rate / rateEnd / pending / pendingRateEnd   config drift and expiry
 *   - collateralization       should be exactly 1.0 under the single-multiplier design
 *   - epoch-grid alignment    (optional) rateEnd falls on the declared epoch grid
 *   - accrual gap             ERROR (not just a warning) once a window has
 *                             actually expired — under a fixed-epoch operating
 *                             model this is a deadline every single epoch, on
 *                             every chain, and missing it silently halts yield
 *
 * Usage:
 *   npx hardhat run scripts/operator/checkMultiplierDrift.ts
 *   TOLERANCE_BPS=1 npx hardhat run scripts/operator/checkMultiplierDrift.ts
 *
 * Env:
 *   CHAINS=base,arbitrum,...   chains to compare (default: all in the address book)
 *   TOLERANCE_BPS=<n>          max tolerated multiplier spread, basis points (default 1)
 *   EXPIRY_WARN_HOURS=<n>      warn when rateEnd is nearer than this (default 48)
 *   EPOCH_ANCHOR_UNIX=<n>      Override epoch 0's start. Defaults to the committed
 *                              grid in scripts/config/epoch.ts, so the alignment
 *                              check runs by default rather than being skipped.
 *   EPOCH_LENGTH_SECONDS=<n>   Override the epoch length (default: 30 days).
 *   EPOCH_GRID_TOLERANCE_SECONDS=<n>  Slack allowed off the exact grid; defaults
 *                              to one settlement window, since a rate window
 *                              legitimately ends at the BASE boundary rather
 *                              than the epoch boundary.
 */

import { ethers } from "ethers";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { describeRate } from "../utils/yieldRate";
import { summarizeLedger } from "../utils/carryLedger";
import { CHAIN_METADATA } from "../config/chains";
import { readSvmSchedule } from "../utils/svmValue";
import { SVM_CHAIN_KEY } from "../utils/globalValue";
import { parseChainsEnv } from "../config/epochChains";
import { effectiveRate as mirrorEffectiveRate } from "@okumoney/yield-tooling";
import {
  EPOCH_ANCHOR_UNIX as DEFAULT_EPOCH_ANCHOR_UNIX,
  EPOCH_LENGTH_SECONDS as DEFAULT_EPOCH_LENGTH_SECONDS,
  EPOCH_GRID_TOLERANCE_SECONDS as DEFAULT_EPOCH_GRID_TOLERANCE_SECONDS,
} from "../config/epoch";

const TOLERANCE_BPS = BigInt(process.env.TOLERANCE_BPS ?? "1");
const EXPIRY_WARN_HOURS = Number(process.env.EXPIRY_WARN_HOURS ?? "48");
// Defaults come from the committed grid (scripts/config/epoch.ts) so the check
// is ON by default rather than silently skipped. Env vars still override, for
// testing against a non-standard grid.
const EPOCH_ANCHOR_UNIX = process.env.EPOCH_ANCHOR_UNIX
  ? Number(process.env.EPOCH_ANCHOR_UNIX)
  : DEFAULT_EPOCH_ANCHOR_UNIX;
const EPOCH_LENGTH_SECONDS = process.env.EPOCH_LENGTH_SECONDS
  ? Number(process.env.EPOCH_LENGTH_SECONDS)
  : DEFAULT_EPOCH_LENGTH_SECONDS;
const EPOCH_GRID_TOLERANCE_SECONDS = process.env.EPOCH_GRID_TOLERANCE_SECONDS
  ? Number(process.env.EPOCH_GRID_TOLERANCE_SECONDS)
  : DEFAULT_EPOCH_GRID_TOLERANCE_SECONDS;

const ABI = [
  "function okuMMultiplier() view returns (uint256)",
  "function okuMRatePerSecond() view returns (uint256)",
  "function okuMEffectiveRatePerSecond() view returns (uint256)",
  "function okuMRateEnd() view returns (uint256)",
  "function okuMPendingRatePerSecond() view returns (uint256)",
  "function okuMPendingRateEnd() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

type Reading = {
  chain: string;
  multiplier: bigint;
  rate: bigint;
  effectiveRate: bigint;
  rateEnd: bigint;
  pending: bigint;
  pendingRateEnd: bigint;
  totalSupply: bigint;
  /**
   * The chain's OWN clock at the instant the multiplier was evaluated.
   *
   * On EVM this equals wall clock for practical purposes. On SVM it does NOT:
   * `Clock::unix_timestamp` is derived from validator vote timestamps and can
   * trail. Since the multiplier is a pure function of that timestamp, a lagging
   * clock produces a lagging multiplier — a SELF-CORRECTING lag, not a drift.
   * Comparing SVM's multiplier against EVM's at the same WALL-CLOCK instant
   * would therefore report a divergence that does not exist.
   */
  evaluatedAtSec: number;
  /** SVM has no view functions, so its multiplier is recomputed client-side. */
  computedOffChain?: boolean;
};

async function readChain(name: string, rpcUrl: string): Promise<Reading | null> {
  try {
    const addr = loadAddress(name, "OkuMoney");
    if (!addr) return null;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const c = new ethers.Contract(addr, ABI, provider);
    const [multiplier, rate, effectiveRate, rateEnd, pending, pendingRateEnd, totalSupply] =
      await Promise.all([
        c.okuMMultiplier(),
        c.okuMRatePerSecond(),
        c.okuMEffectiveRatePerSecond(),
        c.okuMRateEnd(),
        c.okuMPendingRatePerSecond(),
        c.okuMPendingRateEnd(),
        c.totalSupply(),
      ]);
    return {
      chain: name,
      multiplier,
      rate,
      effectiveRate,
      rateEnd,
      pending,
      pendingRateEnd,
      totalSupply,
      evaluatedAtSec: Math.floor(Date.now() / 1000),
    };
  } catch (e: any) {
    logger.warning(`${name}: read failed — ${e.message ?? e}`);
    return null;
  }
}

/**
 * Read SVM's schedule and recompute its multiplier.
 *
 * `SVM_EXPECTED=true` makes a missing/unreadable SVM a HARD ERROR rather than
 * a warning — matching `globalValue.ts`'s `readSvmConfigured`. Without it, an
 * unset `SVM_RPC_URL` in a cron job would print "All chains in agreement"
 * while SVM is entirely unchecked, which is worse than no monitor at all: it
 * actively reports false confidence. Set the flag once SVM carries supply.
 */
async function readSvm(): Promise<Reading | null> {
  const rpcUrl = process.env.SVM_RPC_URL;
  const programId = process.env.SVM_LITE_PSM_PROGRAM_ID;
  const okuMMint = process.env.SVM_OKU_M_MINT;
  const expected = process.env.SVM_EXPECTED === "true";

  if (!rpcUrl || !programId || !okuMMint) {
    const detail =
      "SVM not configured (need SVM_RPC_URL, SVM_LITE_PSM_PROGRAM_ID, SVM_OKU_M_MINT).";
    if (expected) {
      throw new Error(`${detail} SVM_EXPECTED=true, so this is a hard error, not a warning.`);
    }
    logger.warning(`${detail} It is NOT being checked for drift. Set SVM_EXPECTED=true once SVM carries supply.`);
    return null;
  }

  try {
    const reading = await readSvmSchedule(rpcUrl, programId, okuMMint);
    if (!reading) {
      if (expected) throw new Error("SVM configured and expected, but the schedule read returned nothing.");
      return null;
    }
    return {
      chain: SVM_CHAIN_KEY,
      multiplier: reading.multiplier,
      rate: reading.schedule.ratePerSecond,
      effectiveRate: mirrorEffectiveRate(reading.schedule, BigInt(reading.chainTimeSec)),
      rateEnd: reading.schedule.rateEnd,
      pending: reading.schedule.pendingRatePerSecond,
      pendingRateEnd: reading.schedule.pendingRateEnd,
      totalSupply: reading.rawSupply,
      evaluatedAtSec: reading.chainTimeSec,
      computedOffChain: true,
    };
  } catch (e: any) {
    if (expected) throw e; // do not swallow when the caller demanded SVM be checked
    logger.warning(`${SVM_CHAIN_KEY}: read failed — ${e.message ?? e}`);
    return null;
  }
}

async function main() {
  logger.header("Cross-chain multiplier drift check");

  // DELIBERATELY scans every chain in CHAIN_METADATA by default, NOT
  // `config/epochChains.ts::participatingChains()` like the V̄ sampler and
  // the schedule broadcaster do.
  //
  // Those two must agree on one narrow set, because a mismatch between the
  // denominator and the rate's recipients corrupts the published rate. This
  // is a read-only diagnostic with the opposite requirement: its whole job is
  // to notice a chain running a multiplier it shouldn't be — including a
  // chain that is NOT in the participating set (e.g. a stale pre-streaming
  // mainnet deployment still carrying supply). Narrowing it to the
  // participating set would blind it to precisely the drift worth finding.
  // `parseChainsEnv` treats an empty `CHAINS=` as "unset" rather than as an
  // empty scope — the inline split it replaced yielded `[]`, which filtered
  // every chain out and reported "no chains readable" instead of scanning.
  const requested = parseChainsEnv(process.env.CHAINS);
  const targets = Object.entries(CHAIN_METADATA).filter(
    ([name]) => !requested || requested.includes(name)
  );

  const evmReadings = (
    await Promise.all(targets.map(([name, cfg]) => (cfg.rpcUrl ? readChain(name, cfg.rpcUrl) : null)))
  ).filter((r): r is Reading => r !== null);

  const includeSvm = !requested || requested.includes(SVM_CHAIN_KEY);
  const svmReading = includeSvm ? await readSvm() : null;
  const readings = svmReading ? [...evmReadings, svmReading] : evmReadings;

  if (readings.length === 0) {
    logger.error("No chains readable — check CHAINS and the address book");
    process.exit(1);
  }

  for (const r of readings) {
    logger.info(
      `${r.chain.padEnd(14)}${r.computedOffChain ? "*" : " "}mult=${ethers.formatEther(r.multiplier)} ` +
        `rate=${describeRate(r.rate)} effective=${describeRate(r.effectiveRate)} ` +
        `end=${r.rateEnd === 0n ? "open" : new Date(Number(r.rateEnd) * 1000).toISOString()} ` +
        `pendingEnd=${r.pendingRateEnd === 0n ? "none" : new Date(Number(r.pendingRateEnd) * 1000).toISOString()}`
    );
  }

  let failed = false;

  // --- Multiplier spread ---
  //
  // Compared at each chain's own evaluation timestamp. That is exact for EVM
  // chains (block.timestamp tracks wall clock) but NOT for SVM, whose clock can
  // trail. The schedule-equality check below is the timestamp-independent one
  // and is the real catch-all; this spread check is reported with the skew made
  // explicit so a clock lag is not mistaken for a divergence.
  const evaluatedAt = readings.map((r) => r.evaluatedAtSec);
  const skewSec = Math.max(...evaluatedAt) - Math.min(...evaluatedAt);

  const mults = readings.map((r) => r.multiplier);
  const min = mults.reduce((a, b) => (a < b ? a : b));
  const max = mults.reduce((a, b) => (a > b ? a : b));
  const spreadBps = min === 0n ? 0n : ((max - min) * 10_000n) / min;

  if (spreadBps > TOLERANCE_BPS) {
    const skewNote =
      skewSec > 0
        ? ` Readings span ${skewSec}s of clock skew; on SVM a lagging ` +
          "Clock::unix_timestamp produces a LAGGING (self-correcting) multiplier, " +
          "not a permanent drift — check the schedule equality below before acting."
        : "";
    logger.error(
      `MULTIPLIER DRIFT: spread ${spreadBps} bps exceeds tolerance ${TOLERANCE_BPS} bps ` +
        `(min ${ethers.formatEther(min)} / max ${ethers.formatEther(max)}).` +
        ` Divergence is one-way — the multiplier is monotonic, so laggards must be run hot to catch up.${skewNote}`
    );
    failed = true;
  } else {
    logger.success(
      `Multiplier spread ${spreadBps} bps (within ${TOLERANCE_BPS} bps, ${skewSec}s read skew)`
    );
  }

  // --- Rate config equality ---
  const ref = readings[0];
  for (const r of readings.slice(1)) {
    if (r.rate !== ref.rate) {
      logger.error(`RATE MISMATCH: ${r.chain} rate=${r.rate} vs ${ref.chain} rate=${ref.rate}`);
      failed = true;
    }
    if (r.rateEnd !== ref.rateEnd) {
      logger.error(`RATE-END MISMATCH: ${r.chain} end=${r.rateEnd} vs ${ref.chain} end=${ref.rateEnd}`);
      failed = true;
    }
    if (r.pending !== ref.pending) {
      logger.error(`PENDING MISMATCH: ${r.chain} pending=${r.pending} vs ${ref.chain} pending=${ref.pending}`);
      failed = true;
    }
    if (r.pendingRateEnd !== ref.pendingRateEnd) {
      logger.error(
        `PENDING-END MISMATCH: ${r.chain} pendingEnd=${r.pendingRateEnd} vs ${ref.chain} pendingEnd=${ref.pendingRateEnd}`
      );
      failed = true;
    }
  }

  // --- Epoch expiry ---
  // Under a fixed-epoch operating model this fires every single epoch, on
  // every chain, by design — it is a scheduled deadline, not an edge case.
  // An EXPIRED window means yield has ALREADY silently halted (computeMultiplier
  // falls back to PRECISION once both the active AND pending windows have
  // elapsed), which is an ERROR, not a nudge — escalated from a warning so this
  // script's exit code actually reflects "yield is currently not accruing
  // somewhere" rather than requiring a human to read the log.
  const now = BigInt(Math.floor(Date.now() / 1000));
  const warnWindow = BigInt(EXPIRY_WARN_HOURS * 3600);
  for (const r of readings) {
    if (r.rateEnd === 0n) continue;
    if (now >= r.rateEnd) {
      logger.error(
        `${r.chain}: rate window EXPIRED — accrual has HALTED on this chain. ` +
          `setNextOkuMYieldRate now reverts RateAlreadyExpired; a fresh setOkuMYieldRate is required.`
      );
      failed = true;
    } else if (r.rateEnd - now < warnWindow) {
      const hrs = Number(r.rateEnd - now) / 3600;
      logger.warning(`${r.chain}: rate window closes in ${hrs.toFixed(1)}h — stage the successor`);
    }

    // A staged successor's OWN window can also elapse if it's left unattended,
    // silently halting accrual (see MathLib.computeMultiplier's overhang bound).
    if (r.pendingRateEnd === 0n) continue;
    if (now >= r.pendingRateEnd) {
      logger.error(`${r.chain}: staged successor's own window EXPIRED — accrual has HALTED`);
      failed = true;
    } else if (r.pendingRateEnd - now < warnWindow) {
      const hrs = Number(r.pendingRateEnd - now) / 3600;
      logger.warning(`${r.chain}: staged successor's window closes in ${hrs.toFixed(1)}h — stage the next one`);
    }
  }

  // --- Epoch-grid alignment (optional — skipped unless EPOCH_ANCHOR_UNIX is set) ---
  // The epoch length/anchor convention is not yet decided (see TRACKER.md); this
  // check exists so that once one IS adopted, a fat-fingered rateEnd on a single
  // chain (the schedule is pushed manually per chain — nothing enforces this) is
  // caught here rather than silently desynchronising that chain's grid from
  // every other chain's.
  if (EPOCH_ANCHOR_UNIX !== undefined && EPOCH_LENGTH_SECONDS !== undefined) {
    for (const r of readings) {
      if (r.rateEnd === 0n) continue; // halted — no window to check
      const offset = Number(r.rateEnd) - EPOCH_ANCHOR_UNIX;
      const remainder = ((offset % EPOCH_LENGTH_SECONDS) + EPOCH_LENGTH_SECONDS) % EPOCH_LENGTH_SECONDS;
      const distanceToGrid = Math.min(remainder, EPOCH_LENGTH_SECONDS - remainder);
      if (distanceToGrid > EPOCH_GRID_TOLERANCE_SECONDS) {
        logger.error(
          `${r.chain}: EPOCH-GRID MISALIGNMENT — rateEnd=${r.rateEnd} is ${distanceToGrid}s off the ` +
            `declared grid (anchor=${EPOCH_ANCHOR_UNIX}, length=${EPOCH_LENGTH_SECONDS}s, ` +
            `tolerance=${EPOCH_GRID_TOLERANCE_SECONDS}s). This chain's epoch boundary has drifted ` +
            `from the rest of the fleet.`
        );
        failed = true;
      }
    }
  } else {
    logger.info("Epoch-grid alignment check skipped (set EPOCH_ANCHOR_UNIX + EPOCH_LENGTH_SECONDS to enable)");
  }

  // --- Cumulative distributed-vs-realized reporting (diagnostic only, does not fail the check) ---
  // Reads the LOCAL reference-implementation carry ledger (see carryLedger.ts —
  // this is not yet a durable/shared store; see TRACKER.md). Reports the
  // cumulative-conservation identity: cumulativeAchieved = cumulativeRealised -
  // outstandingCarry. This is internal bookkeeping against each entry's
  // measurement basis, not a guarantee about literal on-chain dollars paid —
  // see "Two V's" in yieldRate.ts.
  const ledgerSummary = summarizeLedger();
  if (ledgerSummary.epochCount > 0) {
    logger.info(
      `Carry ledger: ${ledgerSummary.epochCount} epoch(s) recorded, ` +
        `cumulative realised $${ledgerSummary.cumulativeRealisedYieldUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}, ` +
        `cumulative achieved (bookkeeping) $${ledgerSummary.cumulativeAchievedUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}, ` +
        `outstanding carry $${ledgerSummary.outstandingCarryUsd.toLocaleString(undefined, { maximumFractionDigits: 2 })}`
    );
  } else {
    logger.info("Carry ledger: no entries recorded yet");
  }

  if (failed) {
    logger.error("Drift check FAILED");
    process.exit(1);
  }
  logger.success("All chains in agreement");
}

if (require.main === module) {
  main().catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
}

// NOTE: not exercised by the operator drill (test/hardhat/drill/operatorDrill.test.ts).
// This script is inherently multi-chain (reads via `new ethers.JsonRpcProvider(rpcUrl)`
// per configured chain name) — a single local in-process hardhat network has no
// meaningful "cross-chain drift" to detect, and no second chain to compare against.
// Exercising this would require either a second live RPC target or a deeper
// restructuring to accept an in-process provider, which is out of scope here.
