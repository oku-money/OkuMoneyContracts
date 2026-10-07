/**
 * Cross-chain time-weighted average global value (V̄) sampling + storage.
 *
 * Provides `measuredAvgValueUsd` / paying-epoch-actual inputs to
 * `scripts/utils/yieldRate.ts` — see that file's "Two V's" doc block on
 * {@link realisedYieldToRatePerSecond} for why a TIME-WEIGHTED average across
 * all chains is required rather than a spot value on any single chain.
 *
 * V(t) = Σ_chains totalSupply(chain, t) * multiplier(chain, t)
 *
 * "Chains" means EVM chains AND SVM. Omitting any chain is an economic bug, not
 * just an incomplete number: V is the DENOMINATOR of every derived rate, so
 * under-counting it makes the published rate too HIGH and the protocol over-pays
 * yield on every chain, including the ones that were counted.
 *
 * Nothing on-chain aggregates this — it is inherently a cross-chain, off-chain
 * computation, same as the rate schedule itself. This module reads
 * `totalSupply()` + `okuMMultiplier()` per chain, sums them into one
 * global-value sample per poll, and persists samples to a local JSON file so
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
import {
  distributedUsdOverWindow,
  windowSamples,
  RateSegment,
  WindowSampleOpts,
} from "./epochDistribution";
import { readSvmValueUsd } from "./svmValue";
import {
  expectedValueChains,
  participatingChains,
  canonicalChainSet,
  sameChainSet,
  SVM_CHAIN_KEY,
} from "../config/epochChains";
import { isYesMainnet } from "./cli";

const ABI = ["function totalSupply() view returns (uint256)", "function okuMMultiplier() view returns (uint256)"];

/** One time-stamped sample of the SUMMED global value across EVERY expected chain. */
export interface GlobalValueSample {
  /** Unix seconds. */
  timestampSec: number;
  /** Summed dollar value across all chains at this instant, as a plain number.
   *  Precision loss converting from `uint256` wei-scale is intentional and
   *  acceptable — see {@link toUsdNumber}. */
  valueUsd: number;
  /** Per-chain breakdown. Its KEY SET is the chain set the sample covers and
   *  is validated by {@link samplesInWindow} against the current expected set. */
  perChain: Record<string, number>;
  /** The expected chain set (canonical/sorted) this sample was taken against.
   *  Absent on samples persisted before chain-set recording; those are
   *  validated by `perChain`'s key set alone. */
  chains?: string[];
}

/**
 * Converts an on-chain `totalSupply() * okuMMultiplier() / PRECISION` dollar
 * value (18-decimal `bigint`) to a JS `number`. Safe for values well under
 * `Number.MAX_SAFE_INTEGER` dollars (~9e15) after scaling down from 18
 * decimals — i.e. any realistic AUM. Off-chain rate derivation is not an
 * on-chain-precision-critical path.
 */
function toUsdNumber(raw: bigint, decimals = 18): number {
  return Number(raw) / 10 ** decimals;
}

/** Read one chain's current dollar value of OkuM: `totalSupply() * multiplier / 1e18`.
 *  Throws with the reason on any failure (no address, no RPC, read error). */
async function readChainValueUsd(name: string): Promise<number> {
  const rpcUrl = CHAIN_METADATA[name]?.rpcUrl;
  if (!rpcUrl) throw new Error("no rpcUrl configured");
  const addr = loadAddress(name, "OkuMoney");
  if (!addr) throw new Error("no OkuMoney address in the address book");
  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const c = new ethers.Contract(addr, ABI, provider);
  const [totalSupply, multiplier]: [bigint, bigint] = await Promise.all([
    c.totalSupply(),
    c.okuMMultiplier(),
  ]);
  const valueRaw = (totalSupply * multiplier) / 10n ** 18n; // still 18-decimal-scaled
  return toUsdNumber(valueRaw);
}

/**
 * Poll every EXPECTED chain once and return the summed global-value sample.
 *
 * The expected set is `config/epochChains.ts::expectedValueChains()` — the
 * participating set (the SAME set `broadcastSchedule.ts` fans a derived rate
 * out to, including explicit `CHAINS=` lists, which go through the same
 * validation) minus SVM only when SVM is neither configured nor
 * `SVM_EXPECTED=true`.
 *
 * ALL-OR-NOTHING: if any expected chain (EVM or SVM) has no address, no RPC,
 * or fails to read, this THROWS rather than returning a partial sum. A
 * missing chain is not "lower confidence" — it lowers V̄, the denominator of
 * every derived rate, and over-pays yield fleet-wide. There is no opt-out
 * beyond the SVM one above; narrow `CHAINS` deliberately (and consistently
 * with the broadcast) if a chain is genuinely out of the epoch.
 *
 * The returned sample records the expected set in `chains` so
 * {@link samplesInWindow} can refuse samples taken against a different set.
 */
export async function sampleGlobalValueUsd(chains?: string[]): Promise<GlobalValueSample> {
  const scope = { requested: chains, yesMainnet: isYesMainnet() };
  const expected = expectedValueChains(scope);
  if (expected.length === 0) throw new Error("sampleGlobalValueUsd: expected chain set is empty");
  warnIfSvmExcluded(participatingChains(scope), expected);

  const failures: string[] = [];
  const perChain: Record<string, number> = {};
  await Promise.all(
    expected.map(async (name) => {
      try {
        perChain[name] =
          name === SVM_CHAIN_KEY ? await readSvmRequired() : await readChainValueUsd(name);
      } catch (e: any) {
        failures.push(`${name}: ${e.message ?? e}`);
      }
    })
  );

  if (failures.length > 0) {
    throw new Error(
      `Global value sample INCOMPLETE — refusing to emit a partial sum (a missing chain ` +
        `lowers V̄ and inflates every derived rate). Expected [${expected.join(", ")}]; ` +
        `unreadable: ${failures.sort().join("; ")}`
    );
  }

  const ordered: Record<string, number> = {};
  for (const name of expected) ordered[name] = perChain[name];
  const total = expected.reduce((sum, name) => sum + ordered[name], 0);
  return { timestampSec: Math.floor(Date.now() / 1000), valueUsd: total, perChain: ordered, chains: expected };
}

/** Key used for SVM in {@link GlobalValueSample.perChain}. Re-exported from
 *  `config/epochChains.ts` (the single source of truth) for backward
 *  compatibility with existing importers of this module. */
export { SVM_CHAIN_KEY };

/**
 * Read SVM's contribution using environment-provided endpoints. Only called
 * when SVM is in the expected set (configured, or `SVM_EXPECTED=true`), so
 * every failure — including "expected but not configured" — throws.
 *
 * V(t) is the DENOMINATOR of every derived rate (`rate ≈ realisedYield /
 * (V̄ x window)`): SVM holding 20% of supply and silently excluded means V̄
 * 20% low and the rate 25% high, every epoch, with nothing failing.
 * `SVM_EXPECTED` keeps "SVM is absent" (pre-launch, legitimately excluded by
 * `expectedValueChains`) distinguishable from "SVM is misconfigured".
 */
async function readSvmRequired(): Promise<number> {
  const rpcUrl = process.env.SVM_RPC_URL;
  const programId = process.env.SVM_LITE_PSM_PROGRAM_ID;
  const okuMMint = process.env.SVM_OKU_M_MINT;
  if (!rpcUrl || !programId || !okuMMint) {
    throw new Error(
      "SVM_EXPECTED=true but SVM is not configured (need SVM_RPC_URL, " +
        "SVM_LITE_PSM_PROGRAM_ID, SVM_OKU_M_MINT)"
    );
  }
  const reading = await readSvmValueUsd(rpcUrl, programId, okuMMint);
  if (reading === null) throw new Error("SVM is configured but its value could not be read");
  return reading.valueUsd;
}

/** Warn (once per call site) when the participating set includes SVM but the
 *  V̄ expected set excludes it — the broadcast still targets SVM while its
 *  supply is outside the denominator. */
export function warnIfSvmExcluded(participating: string[], expected: string[]): void {
  if (participating.includes(SVM_CHAIN_KEY) && !expected.includes(SVM_CHAIN_KEY)) {
    logger.warning(
      "SVM is participating but neither configured (SVM_RPC_URL, SVM_LITE_PSM_PROGRAM_ID, " +
        "SVM_OKU_M_MINT) nor SVM_EXPECTED=true — its supply is EXCLUDED from V̄. Set " +
        "SVM_EXPECTED=true once SVM carries supply."
    );
  }
}

const DEFAULT_STORE_PATH = path.join(__dirname, "../config/globalValueSamples.json");

/** Append a sample to the on-disk store (see module doc for the "reference implementation" caveat). */
export function appendSample(sample: GlobalValueSample, storePath = DEFAULT_STORE_PATH): void {
  const existing = loadSamples(storePath);
  existing.push(sample);
  // tmp + rename: a crash mid-write must not truncate the whole history.
  const tmp = `${storePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(existing, null, 2) + "\n");
  fs.renameSync(tmp, storePath);
}

/** The chain set a persisted sample covers: `perChain`'s keys, cross-checked
 *  against the recorded `chains` when present. */
function sampleChainSet(s: GlobalValueSample): string[] {
  const keys = canonicalChainSet(Object.keys(s.perChain ?? {}));
  if (s.chains && !sameChainSet(s.chains, keys)) {
    throw new Error(
      `Sample at ${s.timestampSec} is internally inconsistent: recorded chains ` +
        `[${canonicalChainSet(s.chains).join(", ")}] but perChain covers [${keys.join(", ")}]`
    );
  }
  return keys;
}

/** Load all persisted samples, oldest first. Returns `[]` if the store doesn't exist yet. */
export function loadSamples(storePath = DEFAULT_STORE_PATH): GlobalValueSample[] {
  if (!fs.existsSync(storePath)) return [];
  const raw = fs.readFileSync(storePath, "utf-8");
  if (raw.trim().length === 0) return [];
  return JSON.parse(raw) as GlobalValueSample[];
}

/**
 * Select persisted samples covering `[startSec, endSec]`, sorted
 * chronologically, ready to pass to `timeWeightedAverage` (`yieldRate.ts`) or
 * `distributedUsdOverWindow`.
 *
 * Same coverage rules as `epochDistribution.ts::windowSamples` (which this
 * delegates to): the window START must be covered by a sample at/before it
 * (the returned series begins exactly at `startSec`, interpolated if needed),
 * no gap may exceed `opts.maxGapSec` (default 6h), and at least 2 points must
 * remain.
 *
 * CHAIN SET: every sample used (including the pre-window one covering the
 * start) must cover exactly `expectedChains` — normally
 * `config/epochChains.ts::expectedValueChains()`. A sample taken against a
 * different set (a chain missing, or a since-removed chain present) measured
 * a different denominator and is rejected rather than averaged in.
 */
export function samplesInWindow(
  startSec: number,
  endSec: number,
  expectedChains: string[],
  storePath = DEFAULT_STORE_PATH,
  opts: WindowSampleOpts = {}
): { timestampSec: number; valueUsd: number }[] {
  const expected = canonicalChainSet(expectedChains);
  if (expected.length === 0) throw new Error("samplesInWindow: expectedChains is empty");

  const all = loadSamples(storePath).sort((a, b) => a.timestampSec - b.timestampSec);
  let firstUsed = -1;
  for (let i = 0; i < all.length && all[i].timestampSec <= startSec; i++) firstUsed = i;
  const used = all.filter((s, i) => i >= Math.max(firstUsed, 0) && s.timestampSec <= endSec);

  const mismatched = used.filter((s) => !sameChainSet(sampleChainSet(s), expected));
  if (mismatched.length > 0) {
    const first = mismatched[0];
    throw new Error(
      `${mismatched.length} sample(s) covering window [${startSec}, ${endSec}] were taken ` +
        `against a different chain set than the current expected set [${expected.join(", ")}] — ` +
        `e.g. the sample at ${first.timestampSec} covers [${sampleChainSet(first).join(", ")}]. ` +
        "Refusing to mix denominators; resample (sampleGlobalValue.ts) with the current set."
    );
  }

  const plain = used.map((s) => ({ timestampSec: s.timestampSec, valueUsd: s.valueUsd }));
  try {
    return windowSamples(plain, startSec, endSec, opts);
  } catch (e: any) {
    throw new Error(
      `samplesInWindow: ${e.message}. Increase sampling frequency or check the sampler is running.`
    );
  }
}

/**
 * Linearly interpolate the global-value sample series at an arbitrary
 * timestamp. Used as a lightweight FORECAST when no better model is
 * available — e.g. `deriveSettlementRate`'s `settlementForecastAvgValueUsd`
 * can default to `valueAt(samples, now)`, adequate because the settlement
 * window is short (see `epochSchedule.ts`'s `DEFAULT_SETTLEMENT_FRACTION`).
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
 * Cumulative dollars distributed over `[startSec, endSec]`, reading value
 * samples straight from the persisted store. Composition of `samplesInWindow`
 * + `epochDistribution.ts::distributedUsdOverWindow` — see that function's doc
 * for the left-Riemann approximation this relies on.
 */
export function cumulativeDistributedUsd(
  segments: RateSegment[],
  startSec: number,
  endSec: number,
  expectedChains: string[],
  storePath = DEFAULT_STORE_PATH,
  opts: WindowSampleOpts = {}
): number {
  const samples = samplesInWindow(startSec, endSec, expectedChains, storePath, opts);
  return distributedUsdOverWindow(segments, samples, startSec, endSec, opts);
}
