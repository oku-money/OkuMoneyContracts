/**
 * Cross-chain time-weighted average global value (V̄) sampling + storage.
 *
 * Provides `measuredAvgValueUsd` / paying-epoch-actual inputs to
 * `scripts/utils/yieldRate.ts` — see that file's "Two V's" doc block on
 * {@link realisedYieldToRatePerSecond} for why a TIME-WEIGHTED average across
 * all chains is required rather than a spot value on any single chain.
 *
 * V(t) = Σ_chains totalSupply(chain, t) * okuMMultiplier(chain, t)
 *
 * Nothing on-chain aggregates this — it is inherently a cross-chain,
 * off-chain computation, same as the rate schedule itself. This module reads
 * `totalSupply()` + `okuMMultiplier()` per chain (reusing the multi-chain read
 * pattern from `checkMultiplierDrift.ts`), sums them into one global-value
 * sample per poll, and persists samples to a local JSON file so
 * `timeWeightedAverage` (from `yieldRate.ts`) can integrate over an arbitrary
 * window after the fact.
 *
 * OPERATIONAL NOTE: the on-disk sample store here is a REFERENCE
 * implementation (a local JSON file), not a production design. Like the carry
 * ledger (see TRACKER.md), this is cross-chain-critical off-chain state that
 * every consumer of `realisedYieldToRatePerSecond` needs to agree on; it
 * should be moved to a durable, shared, and ideally signed store before
 * relying on it for real rate decisions across multiple operators.
 */

import fs from "fs";
import path from "path";
import { ethers } from "ethers";
import { loadAddress } from "./addressBook";
import { logger } from "./logger";
import { CHAIN_METADATA } from "../config/chains";
import { distributedUsdOverWindow, RateSegment } from "./epochDistribution";

const ABI = ["function totalSupply() view returns (uint256)", "function okuMMultiplier() view returns (uint256)"];

/** One time-stamped sample of the SUMMED global value across all readable chains. */
export interface GlobalValueSample {
  /** Unix seconds. */
  timestampSec: number;
  /** Summed dollar value across all chains at this instant, as a plain number.
   *  Precision loss converting from `uint256` wei-scale is intentional and
   *  acceptable — see {@link toUsdNumber}. */
  valueUsd: number;
  /** Per-chain breakdown, for diagnostics (not consumed by the average itself). */
  perChain: Record<string, number>;
}

/**
 * Converts an on-chain `totalSupply() * okuMMultiplier() / PRECISION` dollar
 * value (18-decimal `bigint`) to a JS `number`. Safe for values well under
 * `Number.MAX_SAFE_INTEGER` dollars (~9e15) after scaling down from 18
 * decimals — i.e. any realistic AUM. `timeWeightedAverage` operates on plain
 * numbers because it is arithmetic reasoning about USD amounts for humans and
 * off-chain rate derivation, not an on-chain-precision-critical path.
 */
function toUsdNumber(raw: bigint, decimals = 18): number {
  return Number(raw) / 10 ** decimals;
}

/** Read one chain's current dollar value of OkuM: `totalSupply() * multiplier / 1e18`. */
async function readChainValueUsd(name: string, rpcUrl: string): Promise<number | null> {
  try {
    const addr = loadAddress(name, "OkuMoney");
    if (!addr) return null;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const c = new ethers.Contract(addr, ABI, provider);
    const [totalSupply, multiplier]: [bigint, bigint] = await Promise.all([
      c.totalSupply(),
      c.okuMMultiplier(),
    ]);
    const valueRaw = (totalSupply * multiplier) / 10n ** 18n; // still 18-decimal-scaled
    return toUsdNumber(valueRaw);
  } catch (e: any) {
    logger.warning(`${name}: value read failed — ${e.message ?? e}`);
    return null;
  }
}

/**
 * Poll every configured chain once and return the summed global-value sample.
 * Chains that fail to respond are OMITTED from the sum (not treated as zero) —
 * a transient RPC failure must not manufacture a fake AUM drop. Callers should
 * treat a sample with missing chains as lower-confidence (see `perChain`).
 */
export async function sampleGlobalValueUsd(chains?: string[]): Promise<GlobalValueSample> {
  const targets = Object.entries(CHAIN_METADATA).filter(([name]) => !chains || chains.includes(name));

  const results = await Promise.all(
    targets.map(async ([name, cfg]) => {
      if (!cfg.rpcUrl) return null;
      const valueUsd = await readChainValueUsd(name, cfg.rpcUrl);
      return valueUsd === null ? null : ([name, valueUsd] as const);
    })
  );

  const perChain: Record<string, number> = {};
  let total = 0;
  for (const r of results) {
    if (r === null) continue;
    const [name, valueUsd] = r;
    perChain[name] = valueUsd;
    total += valueUsd;
  }

  return { timestampSec: Math.floor(Date.now() / 1000), valueUsd: total, perChain };
}

const DEFAULT_STORE_PATH = path.join(__dirname, "../config/globalValueSamples.json");

/** Append a sample to the on-disk store (see module doc for the "reference implementation" caveat). */
export function appendSample(sample: GlobalValueSample, storePath = DEFAULT_STORE_PATH): void {
  const existing = loadSamples(storePath);
  existing.push(sample);
  fs.writeFileSync(storePath, JSON.stringify(existing, null, 2) + "\n");
}

/** Load all persisted samples, oldest first. Returns `[]` if the store doesn't exist yet. */
export function loadSamples(storePath = DEFAULT_STORE_PATH): GlobalValueSample[] {
  if (!fs.existsSync(storePath)) return [];
  const raw = fs.readFileSync(storePath, "utf-8");
  if (raw.trim().length === 0) return [];
  return JSON.parse(raw) as GlobalValueSample[];
}

/**
 * Select persisted samples within `[startSec, endSec]` (inclusive), sorted
 * chronologically, ready to pass to `timeWeightedAverage` from `yieldRate.ts`.
 * Throws if fewer than 2 samples fall in the window — `timeWeightedAverage`
 * cannot integrate over 0 or 1 points, and a window with too few samples is a
 * signal the sampling cadence is too coarse for the window being measured.
 */
export function samplesInWindow(
  startSec: number,
  endSec: number,
  storePath = DEFAULT_STORE_PATH
): { timestampSec: number; valueUsd: number }[] {
  const all = loadSamples(storePath)
    .filter((s) => s.timestampSec >= startSec && s.timestampSec <= endSec)
    .sort((a, b) => a.timestampSec - b.timestampSec)
    .map((s) => ({ timestampSec: s.timestampSec, valueUsd: s.valueUsd }));

  if (all.length < 2) {
    throw new Error(
      `Only ${all.length} sample(s) found in window [${startSec}, ${endSec}] — ` +
        "need at least 2 to compute a time-weighted average. Increase sampling " +
        "frequency or widen the window."
    );
  }
  return all;
}

/**
 * Linearly interpolate the global-value sample series at an arbitrary
 * timestamp. Used as a lightweight FORECAST when no better model is
 * available — e.g. `deriveSettlementRate`'s `settlementForecastAvgValueUsd`
 * can default to `valueAt(samples, now)` (effectively "assume the settlement
 * window's average equals the most recent observed value"), which is
 * adequate precisely because the settlement window is short (see
 * `epochSchedule.ts`'s `DEFAULT_SETTLEMENT_FRACTION` and the accuracy tables
 * in EVM/README.md § Rear-Facing Epoch Accounting).
 *
 * Clamps to the first/last sample's value outside the series' covered range,
 * same convention as `epochDistribution.ts::multiplierAt`.
 */
export function valueAt(
  samples: { timestampSec: number; valueUsd: number }[],
  tSec: number
): number {
  if (samples.length === 0) throw new Error("valueAt: no samples provided");
  const sorted = [...samples].sort((a, b) => a.timestampSec - b.timestampSec);

  if (tSec <= sorted[0].timestampSec) return sorted[0].valueUsd;
  if (tSec >= sorted[sorted.length - 1].timestampSec) return sorted[sorted.length - 1].valueUsd;

  for (let i = 1; i < sorted.length; i++) {
    if (tSec <= sorted[i].timestampSec) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      const frac = (tSec - prev.timestampSec) / (cur.timestampSec - prev.timestampSec);
      return prev.valueUsd + frac * (cur.valueUsd - prev.valueUsd);
    }
  }
  // Unreachable given the bounds checks above; satisfies the type checker.
  return sorted[sorted.length - 1].valueUsd;
}

/**
 * Convenience wrapper: cumulative dollars distributed over `[startSec, endSec]`,
 * reading value samples straight from the persisted store rather than
 * requiring the caller to pre-select them. Thin composition of
 * `samplesInWindow` + `epochDistribution.ts::distributedUsdOverWindow` — see
 * that function's doc for the left-Riemann approximation this relies on.
 */
export function cumulativeDistributedUsd(
  segments: RateSegment[],
  startSec: number,
  endSec: number,
  storePath = DEFAULT_STORE_PATH
): number {
  const samples = samplesInWindow(startSec, endSec, storePath);
  return distributedUsdOverWindow(segments, samples, startSec, endSec);
}
