/**
 * Pure predicates behind `operator/checkMultiplierDrift.ts`.
 *
 * Extracted so they can be unit-tested. The drift check is the only layer that
 * can detect cross-chain multiplier divergence — nothing on either stack
 * enforces it on-chain — but it is inherently multi-chain and so was never
 * exercised by a test. These functions carry all of its decision logic and
 * none of its I/O.
 */

/** Distance in seconds from `rateEnd` to the nearest epoch-grid boundary. */
export function distanceToGrid(
  rateEnd: number,
  anchorUnix: number,
  epochLengthSec: number
): number {
  const offset = rateEnd - anchorUnix;
  const remainder = ((offset % epochLengthSec) + epochLengthSec) % epochLengthSec;
  return Math.min(remainder, epochLengthSec - remainder);
}

export function isGridAligned(
  rateEnd: number,
  anchorUnix: number,
  epochLengthSec: number,
  toleranceSec: number
): boolean {
  return distanceToGrid(rateEnd, anchorUnix, epochLengthSec) <= toleranceSec;
}

/** Spread between the highest and lowest multiplier, in basis points. */
export function spreadBps(multipliers: bigint[]): bigint {
  if (multipliers.length === 0) return 0n;
  const min = multipliers.reduce((a, b) => (b < a ? b : a));
  const max = multipliers.reduce((a, b) => (b > a ? b : a));
  if (min === 0n) return 0n;
  return ((max - min) * 10_000n) / min;
}

export interface AccrualState {
  /** No yield is accruing right now. */
  halted: boolean;
  /** The active window has elapsed and the staged successor is carrying accrual. */
  handedOver: boolean;
  /** When accrual actually stops, or 0 if unbounded/halted. */
  runsOutAt: bigint;
}

/**
 * Classify a chain's accrual from its schedule.
 *
 * "Halted" is decided by the EFFECTIVE rate, not by whether `rateEnd` has
 * passed: an elapsed active window merely hands accrual to the staged
 * successor, which is the normal transition at every epoch boundary. Keying off
 * `rateEnd` reported a halt — and failed the run — for the entire duration of
 * every successor window.
 */
export function classifyAccrual(args: {
  effectiveRate: bigint;
  rateEnd: bigint;
  pendingRateEnd: bigint;
  now: bigint;
  precision: bigint;
}): AccrualState {
  const { effectiveRate, rateEnd, pendingRateEnd, now, precision } = args;

  if (effectiveRate <= precision) {
    return { halted: true, handedOver: false, runsOutAt: 0n };
  }
  const handedOver = rateEnd !== 0n && now >= rateEnd;
  return {
    halted: false,
    handedOver,
    runsOutAt: handedOver ? pendingRateEnd : rateEnd,
  };
}

/** True when accrual stops within `warnWindowSec`. */
export function isExpiringSoon(runsOutAt: bigint, now: bigint, warnWindowSec: bigint): boolean {
  return runsOutAt !== 0n && runsOutAt > now && runsOutAt - now < warnWindowSec;
}
