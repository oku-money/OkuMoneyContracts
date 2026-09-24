/**
 * Single entry point deriving a full base+settlement epoch schedule tuple,
 * so every chain computes the IDENTICAL `(rBase, baseEndSec, rSettle,
 * settleEndSec)` from the identical inputs — same "single source of truth"
 * principle as `yieldRate.ts::apyToRatePerSecond` for the simple case.
 *
 * See EVM/README.md § Rear-Facing Epoch Accounting for the full design
 * rationale (the impossibility of exact nominal distribution, why B3 shrinks
 * the uncorrectable window instead of eliminating it, and the accuracy table
 * this module's sibling simulation suite validates).
 */

import { PRECISION as PRECISION_BIGINT, MAX_RATE as MAX_RATE_BIGINT } from "./yieldRate";
import { deriveSettlementRate } from "./epochDistribution";

/** Recommended default: settlement window is 1/15 of the epoch (2 days of 30). */
export const DEFAULT_SETTLEMENT_FRACTION = 1 / 15;

/** Fixed points of an epoch's base+settlement schedule. */
export interface EpochGrid {
  epochStartSec: number;
  epochLengthSec: number;
  /** Fraction of `epochLengthSec` reserved for the settlement window, in `(0, 1)`. */
  settlementFraction: number;
}

export function baseEndSec(grid: EpochGrid): number {
  return grid.epochStartSec + grid.epochLengthSec * (1 - grid.settlementFraction);
}

export function epochEndSec(grid: EpochGrid): number {
  return grid.epochStartSec + grid.epochLengthSec;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO INDEPENDENT KNOBS — do not conflate them.
 * ═══════════════════════════════════════════════════════════════════════════
 * 1. CROSS-EPOCH conservatism (`conservativeFactor` / `carryInUsd`, in
 *    `yieldRate.ts`): discount the OVERALL epoch target BEFORE either window
 *    runs; the withheld remainder carries to the NEXT epoch. Insurance against
 *    the settlement window's OWN forecast being wrong. Does not improve the
 *    base/settlement split's accuracy — it just means a bad month costs less.
 * 2. WITHIN-epoch split (`baseWindowFraction`, this module): of whatever the
 *    caller has decided the epoch's target is (already reflecting (1) if in
 *    use), what fraction the base window alone attempts, with the settlement
 *    window closing the remainder from FRESHLY MEASURED data. This is what
 *    shrinks the AUM-volatility-driven error — see the accuracy tables in
 *    EVM/README.md § Rear-Facing Epoch Accounting.
 *
 * `deriveBaseRate` / `deriveSettlementRateForEpoch` below take `targetUsd` as
 * an INPUT — the caller is responsible for having already applied (1) via
 * `yieldRate.ts` (`realisedYieldUsd * conservativeFactor + carryInUsd`) if
 * cross-epoch conservatism is desired. These functions only implement (2).
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Compute the BASE window's rate — the provisional rate for most of the
 * epoch, targeting `baseWindowFraction` of `targetUsd`. The remainder is
 * closed WITHIN THE SAME EPOCH by the settlement window (see
 * {deriveSettlementRateForEpoch}), using data measured after this rate is
 * already running — this is what makes B3 more accurate than a single
 * feed-forward rate, independent of any cross-epoch buffer.
 *
 * @param targetUsd The (already fully cross-epoch-adjusted, if applicable)
 *        epoch distribution target — see the "Two independent knobs" note above.
 * @param baseWindowFraction Fraction of `targetUsd` the base window alone
 *        attempts, in `(0, 1]`. `1` means no within-epoch split, which
 *        degrades accuracy toward a plain feed-forward rate.
 *        Typical: ~0.9–0.97.
 * @param measuredAvgValueUsd Time-weighted average value from the CLOSED
 *        measurement epoch (basis (1) in `yieldRate.ts`'s "Two V's") — NOT
 *        this epoch's own (unknown) average.
 */
export function deriveBaseRate(params: {
  targetUsd: number;
  baseWindowFraction: number;
  measuredAvgValueUsd: number;
  grid: EpochGrid;
}): { ratePerSecond: number; baseWindowTargetUsd: number } {
  const { targetUsd, baseWindowFraction, measuredAvgValueUsd, grid } = params;
  if (baseWindowFraction <= 0 || baseWindowFraction > 1) {
    throw new Error(`baseWindowFraction must be in (0, 1], got ${baseWindowFraction}`);
  }
  if (measuredAvgValueUsd <= 0) throw new Error("measuredAvgValueUsd must be > 0");

  const baseWindowTargetUsd = targetUsd * baseWindowFraction;
  const baseWindowLenSec = grid.epochLengthSec * (1 - grid.settlementFraction);
  if (baseWindowLenSec <= 0) throw new Error("computed base window length must be > 0");

  const growth = 1 + baseWindowTargetUsd / measuredAvgValueUsd;
  if (growth <= 0) {
    throw new Error(
      `Base window target (${baseWindowTargetUsd}) implies a >=100% loss against ` +
        `measuredAvgValueUsd (${measuredAvgValueUsd})`
    );
  }
  const ratePerSecond = Math.pow(growth, 1 / baseWindowLenSec);
  return { ratePerSecond, baseWindowTargetUsd };
}

/**
 * Wraps `epochDistribution.ts::deriveSettlementRate` with the full-epoch
 * target framing. The settlement window closes the gap against the FULL
 * (already cross-epoch-adjusted) `targetUsd`, NOT the base window's
 * `baseWindowFraction`-discounted target — the withheld
 * `(1 - baseWindowFraction)` slice is exactly what settlement recovers within
 * this epoch. The gap also subtracts what the base window is projected to
 * distribute over its remaining tail (`stagingSec` to `baseEndSec`) before the
 * settlement rate takes effect; see `deriveSettlementRate`'s "BASE-WINDOW
 * TAIL" doc.
 *
 * @param stagingSec Unix timestamp this function is being called at (when the
 *        settlement rate is derived and staged). Required to compute the
 *        base-window tail length.
 * @param baseRatePerSecond The base window's own rate (unscaled float),
 *        already running and continuing to accrue until `baseEndSec`.
 */
export function deriveSettlementRateForEpoch(params: {
  targetUsd: number;
  distributedSoFarUsd: number;
  settlementForecastAvgValueUsd: number;
  grid: EpochGrid;
  stagingSec: number;
  baseRatePerSecond: number;
}): number {
  const settlementLenSec = params.grid.epochLengthSec * params.grid.settlementFraction;
  const baseTailSec = Math.max(0, baseEndSec(params.grid) - params.stagingSec);
  return deriveSettlementRate({
    targetUsd: params.targetUsd,
    distributedSoFarUsd: params.distributedSoFarUsd,
    settlementForecastAvgValueUsd: params.settlementForecastAvgValueUsd,
    settlementLenSec,
    baseTailRatePerSecond: params.baseRatePerSecond,
    baseTailSec,
  });
}

/** On-chain-ready tuple: 1e18-scaled bigint rates + integer-second boundaries. */
export interface OnChainEpochSchedule {
  rBase: bigint;
  baseEndSec: number;
  rSettle: bigint;
  settleEndSec: number;
}

/** Scale a `RateSegment`-style unscaled float rate (1 = no yield) directly to
 *  the 1e18-scaled bigint the contract expects, clamped to the on-chain
 *  enforced `[PRECISION, MAX_RATE]` range. Clamping here (rather than letting
 *  an out-of-range value revert on-chain) surfaces a sizing problem in the
 *  off-chain derivation immediately, with an explicit signal, instead of as
 *  an opaque on-chain revert. */
export function floatRateToBigint(rateFloat: number): bigint {
  if (rateFloat <= 1) return PRECISION_BIGINT;
  const scaled = BigInt(Math.round(rateFloat * 1e18));
  if (scaled > MAX_RATE_BIGINT) return MAX_RATE_BIGINT;
  return scaled;
}

/**
 * Convert a `(ratePerSecond: float, ...)` pair to the bigint rates and integer
 * timestamps `setOkuMYieldRateWithSuccessor` expects. Rounds timestamps down
 * to the nearest second (Unix timestamps are integer seconds on-chain).
 */
export function toOnChainSchedule(params: {
  rBaseFloat: number;
  rSettleFloat: number;
  grid: EpochGrid;
}): OnChainEpochSchedule {
  return {
    rBase: floatRateToBigint(params.rBaseFloat),
    baseEndSec: Math.floor(baseEndSec(params.grid)),
    rSettle: floatRateToBigint(params.rSettleFloat),
    settleEndSec: Math.floor(epochEndSec(params.grid)),
  };
}
