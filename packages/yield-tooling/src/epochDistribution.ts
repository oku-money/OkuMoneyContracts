/**
 * Base + settlement epoch distribution math (design "B3" in EVM/README.md
 * EVM/docs/epoch-accounting.md).
 *
 * A rate committed at epoch start cannot hit a nominal target `Y*` exactly,
 * because dollars distributed depend on the actual (unknowable in advance)
 * supply path — see `yieldRate.ts`'s "Two V's". B3 shrinks the uncorrectable
 * window from the whole epoch to a short tail: run most of the epoch (the
 * "base window") at a rate targeting most of `Y*`, then stage a short
 * "settlement window" whose rate is derived from what was ACTUALLY measured to
 * have distributed so far.
 *
 * Pure math — no network, no chain state. Operates on `RateSegment[]` (a
 * piecewise-constant rate schedule) and value samples
 * `{ timestampSec, valueUsd }` from `globalValue.ts` (V(t) = S(t) * m(t),
 * summed across chains), and answers two questions:
 *   1. `distributedUsdOverWindow` — given a schedule and value samples, how
 *      many dollars did (or would) that schedule actually distribute?
 *   2. `deriveSettlementRate` — given a target and what's been distributed so
 *      far, what settlement-window rate closes the gap?
 */

/** A constant-rate window, e.g. one epoch's base or settlement leg. */
export interface RateSegment {
  /** Unix seconds this segment's rate becomes active. */
  startSec: number;
  /** Unix seconds this segment's rate stops (exclusive). */
  endSec: number;
  /** Per-second compounding rate, UNSCALED float (1 = no yield), matching
   *  `yieldRate.ts::ratePerSecondToApy`'s convention — NOT the on-chain
   *  1e18-scaled bigint. Convert with `apyToRatePerSecond` / divide by 1e18
   *  at the chain boundary. */
  ratePerSecond: number;
  /** Multiplier value AT `startSec`, i.e. the accrual base this segment compounds from. */
  anchorMultiplier: number;
}

/**
 * The multiplier at `tSec` under a piecewise-constant schedule. Segments must
 * be chronologically ordered and contiguous (each `endSec` == next `startSec`)
 * for the compounding to be continuous — this is NOT checked here (callers
 * constructing segments from `setOkuMYieldRate`/`setNextOkuMYieldRate` calls
 * naturally satisfy it; see `epochSchedule.ts`).
 *
 * Clamps to the first/last segment's anchor if `tSec` falls outside the
 * schedule's covered range, rather than throwing — useful for querying a
 * schedule that hasn't started yet or has already ended.
 */
export function multiplierAt(segments: RateSegment[], tSec: number): number {
  if (segments.length === 0) throw new Error("multiplierAt: no segments provided");
  if (tSec <= segments[0].startSec) return segments[0].anchorMultiplier;

  for (const seg of segments) {
    if (tSec >= seg.startSec && tSec < seg.endSec) {
      return seg.anchorMultiplier * Math.pow(seg.ratePerSecond, tSec - seg.startSec);
    }
  }
  // At or past the end of the schedule: hold at the last segment's value at its endSec.
  const last = segments[segments.length - 1];
  return last.anchorMultiplier * Math.pow(last.ratePerSecond, last.endSec - last.startSec);
}

/**
 * Dollars ACTUALLY distributed by `segments` over `[windowStartSec, windowEndSec]`,
 * using `valueSamples` to reconstruct the supply path (`S(t) = V(t) / m(t)`, m(t)
 * from the known schedule) and integrating `∫ S(t) dm(t)` piecewise between
 * consecutive samples.
 *
 * APPROXIMATION: uses a LEFT-Riemann sum — each sub-interval's distributed
 * amount is `S(t_i) * (m(t_{i+1}) - m(t_i))`, i.e. supply is assumed constant
 * at its value at the START of each sub-interval. Exact if supply is
 * piecewise-constant between samples (the common case — a mint/burn is a
 * single on-chain event), and converges to the true integral as sampling
 * frequency increases. See `globalValue.ts` for the recommended (hourly)
 * sampling cadence.
 *
 * FINAL-INTERVAL EXTRAPOLATION: if the LAST sample within
 * `[windowStartSec, windowEndSec]` falls strictly before `windowEndSec` (the
 * common case), the gap `[lastSample, windowEndSec]` is extrapolated using the
 * last sample's implied supply held constant, same left-Riemann convention as
 * every other sub-interval. This term is NOT optional: at default
 * base+settlement settings it is ~1.6% of the epoch target, not rounding.
 *
 * Samples outside `[windowStartSec, windowEndSec]` are ignored. Requires at
 * least 2 samples within the window (same requirement as
 * `yieldRate.ts::timeWeightedAverage`).
 */
export function distributedUsdOverWindow(
  segments: RateSegment[],
  valueSamples: { timestampSec: number; valueUsd: number }[],
  windowStartSec: number,
  windowEndSec: number
): number {
  const inWindow = valueSamples
    .filter((s) => s.timestampSec >= windowStartSec && s.timestampSec <= windowEndSec)
    .sort((a, b) => a.timestampSec - b.timestampSec);

  if (inWindow.length < 2) {
    throw new Error(
      `distributedUsdOverWindow: only ${inWindow.length} sample(s) in window ` +
        `[${windowStartSec}, ${windowEndSec}] — need at least 2`
    );
  }

  let distributed = 0;
  for (let i = 1; i < inWindow.length; i++) {
    const prev = inWindow[i - 1];
    const cur = inWindow[i];
    const mPrev = multiplierAt(segments, prev.timestampSec);
    const mCur = multiplierAt(segments, cur.timestampSec);
    const supplyAtPrev = prev.valueUsd / mPrev;
    distributed += supplyAtPrev * (mCur - mPrev);
  }

  const lastSample = inWindow[inWindow.length - 1];
  if (lastSample.timestampSec < windowEndSec) {
    const mLast = multiplierAt(segments, lastSample.timestampSec);
    const mEnd = multiplierAt(segments, windowEndSec);
    const supplyAtLast = lastSample.valueUsd / mLast;
    distributed += supplyAtLast * (mEnd - mLast);
  }

  return distributed;
}

/**
 * Derive the settlement-window rate that closes the gap between a target `Y*`
 * and what's been distributed so far, given a forecast of the settlement
 * window's own average value.
 *
 * `targetUsd` must already reflect any deliberate buffer and carry-in — i.e.
 * `Y* * conservativeFactor + carryInUsd`, NOT the raw epoch target. See
 * `yieldRate.ts::realisedYieldToRatePerSecond` for that adjustment.
 *
 * BASE-WINDOW TAIL: `distributedSoFarUsd` only covers what has ALREADY been
 * measured, up to the staging instant. The base rate keeps running,
 * unattended, from staging until `baseEndSec`, so this function MUST also
 * subtract the PROJECTED distribution over that tail or it systematically
 * over-derives the settlement rate. At typical settings (staging ~2% before
 * `baseEndSec`) the tail is ~1.9% of the epoch target — comparable to the
 * deliberate cross-epoch buffer and in the OPPOSITE direction, so dropping it
 * makes the two silently cancel. Pass `baseTailRatePerSecond: 1` (or omit
 * `baseTailSec`) only when there genuinely is no tail (staging exactly at
 * `baseEndSec`).
 *
 * @param targetUsd Total dollars this epoch is trying to distribute (post-buffer, post-carry).
 * @param distributedSoFarUsd Measured `distributedUsdOverWindow` from epoch start
 *        through the settlement staging instant.
 * @param settlementForecastAvgValueUsd Forecast of the settlement window's own
 *        time-weighted average value. Absent a better forecast, the most
 *        recent measured value (last sample) is a reasonable default — the
 *        settlement window is short, so naive persistence forecasting is
 *        adequate. Also used as the base-tail's forecast value; both windows
 *        are short and adjacent.
 * @param settlementLenSec Length of the settlement window in seconds.
 * @param baseTailRatePerSecond The (already-known, already-running) base rate
 *        that will continue to accrue from the staging instant until
 *        `baseEndSec`. Defaults to `1` (no further base accrual) — callers
 *        MUST pass the real base rate if staging happens before `baseEndSec`,
 *        which is the normal case.
 * @param baseTailSec Seconds remaining in the base window at staging time
 *        (`baseEndSec - stagingSec`). Defaults to `0` (no tail).
 * @returns Per-second rate (unscaled float, matching `RateSegment`), clamped
 *          to `>= 1` (the multiplier is monotonic on-chain — a negative
 *          residual here means the base window (including its projected
 *          tail) already over-shoots `targetUsd`, which should be corrected
 *          via carry into the NEXT epoch, not by this function inventing a
 *          sub-1 rate it can't express).
 */
export function deriveSettlementRate(params: {
  targetUsd: number;
  distributedSoFarUsd: number;
  settlementForecastAvgValueUsd: number;
  settlementLenSec: number;
  baseTailRatePerSecond?: number;
  baseTailSec?: number;
}): number {
  const {
    targetUsd,
    distributedSoFarUsd,
    settlementForecastAvgValueUsd,
    settlementLenSec,
    baseTailRatePerSecond = 1,
    baseTailSec = 0,
  } = params;
  if (settlementForecastAvgValueUsd <= 0) {
    throw new Error("deriveSettlementRate: settlementForecastAvgValueUsd must be > 0");
  }
  if (settlementLenSec <= 0) {
    throw new Error("deriveSettlementRate: settlementLenSec must be > 0");
  }
  if (baseTailSec < 0) {
    throw new Error("deriveSettlementRate: baseTailSec must be >= 0");
  }

  const projectedBaseTailUsd =
    baseTailSec > 0
      ? settlementForecastAvgValueUsd * (Math.pow(baseTailRatePerSecond, baseTailSec) - 1)
      : 0;

  const remainingUsd = targetUsd - distributedSoFarUsd - projectedBaseTailUsd;
  if (remainingUsd <= 0) {
    // Base window already met or exceeded the target — settle at PRECISION
    // (no yield); the overshoot should be carried as a NEGATIVE carry into
    // the next epoch (see yieldRate.ts), not corrected here.
    return 1;
  }

  const growth = 1 + remainingUsd / settlementForecastAvgValueUsd;
  return Math.pow(growth, 1 / settlementLenSec);
}
