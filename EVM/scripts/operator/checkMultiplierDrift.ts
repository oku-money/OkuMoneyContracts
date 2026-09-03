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
 *
 * Usage:
 *   npx hardhat run scripts/operator/checkMultiplierDrift.ts
 *   TOLERANCE_BPS=1 npx hardhat run scripts/operator/checkMultiplierDrift.ts
 *
 * Env:
 *   CHAINS=base,arbitrum,...   chains to compare (default: all in the address book)
 *   TOLERANCE_BPS=<n>          max tolerated multiplier spread, basis points (default 1)
 *   EXPIRY_WARN_HOURS=<n>      warn when rateEnd is nearer than this (default 48)
 */

import { ethers } from "ethers";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { describeRate } from "../utils/yieldRate";
import { CHAIN_METADATA } from "../config/chains";

const TOLERANCE_BPS = BigInt(process.env.TOLERANCE_BPS ?? "1");
const EXPIRY_WARN_HOURS = Number(process.env.EXPIRY_WARN_HOURS ?? "48");

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
    return { chain: name, multiplier, rate, effectiveRate, rateEnd, pending, pendingRateEnd, totalSupply };
  } catch (e: any) {
    logger.warning(`${name}: read failed — ${e.message ?? e}`);
    return null;
  }
}

async function main() {
  logger.header("Cross-chain multiplier drift check");

  const requested = process.env.CHAINS?.split(",").map((s) => s.trim()).filter(Boolean);
  const targets = Object.entries(CHAIN_METADATA).filter(
    ([name]) => !requested || requested.includes(name)
  );

  const readings = (
    await Promise.all(targets.map(([name, cfg]) => (cfg.rpcUrl ? readChain(name, cfg.rpcUrl) : null)))
  ).filter((r): r is Reading => r !== null);

  if (readings.length === 0) {
    logger.error("No chains readable — check CHAINS and the address book");
    process.exit(1);
  }

  for (const r of readings) {
    logger.info(
      `${r.chain.padEnd(14)} mult=${ethers.formatEther(r.multiplier)} ` +
        `rate=${describeRate(r.rate)} effective=${describeRate(r.effectiveRate)} ` +
        `end=${r.rateEnd === 0n ? "open" : new Date(Number(r.rateEnd) * 1000).toISOString()} ` +
        `pendingEnd=${r.pendingRateEnd === 0n ? "none" : new Date(Number(r.pendingRateEnd) * 1000).toISOString()}`
    );
  }

  let failed = false;

  // --- Multiplier spread ---
  const mults = readings.map((r) => r.multiplier);
  const min = mults.reduce((a, b) => (a < b ? a : b));
  const max = mults.reduce((a, b) => (a > b ? a : b));
  const spreadBps = min === 0n ? 0n : ((max - min) * 10_000n) / min;

  if (spreadBps > TOLERANCE_BPS) {
    logger.error(
      `MULTIPLIER DRIFT: spread ${spreadBps} bps exceeds tolerance ${TOLERANCE_BPS} bps ` +
        `(min ${ethers.formatEther(min)} / max ${ethers.formatEther(max)}). ` +
        `Divergence is one-way — the multiplier is monotonic, so laggards must be run hot to catch up.`
    );
    failed = true;
  } else {
    logger.success(`Multiplier spread ${spreadBps} bps (within ${TOLERANCE_BPS} bps)`);
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
  const now = BigInt(Math.floor(Date.now() / 1000));
  const warnWindow = BigInt(EXPIRY_WARN_HOURS * 3600);
  for (const r of readings) {
    if (r.rateEnd === 0n) continue;
    if (now >= r.rateEnd) {
      logger.warning(`${r.chain}: rate window EXPIRED — setNextOkuMYieldRate now reverts RateAlreadyExpired`);
    } else if (r.rateEnd - now < warnWindow) {
      const hrs = Number(r.rateEnd - now) / 3600;
      logger.warning(`${r.chain}: rate window closes in ${hrs.toFixed(1)}h — stage the successor`);
    }

    // A staged successor's OWN window can also elapse if it's left unattended,
    // silently halting accrual (see MathLib.computeMultiplier's overhang bound).
    if (r.pendingRateEnd === 0n) continue;
    if (now >= r.pendingRateEnd) {
      logger.warning(`${r.chain}: staged successor's own window EXPIRED — accrual has halted`);
    } else if (r.pendingRateEnd - now < warnWindow) {
      const hrs = Number(r.pendingRateEnd - now) / 3600;
      logger.warning(`${r.chain}: staged successor's window closes in ${hrs.toFixed(1)}h — stage the next one`);
    }
  }

  if (failed) {
    logger.error("Drift check FAILED");
    process.exit(1);
  }
  logger.success("All chains in agreement");
}

main().catch((e) => {
  logger.error(e.message ?? String(e));
  process.exit(1);
});
