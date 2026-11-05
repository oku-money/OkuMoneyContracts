/**
 * Pure predicates behind `operator/checkMultiplierDrift.ts`.
 *
 * Extracted so they can be unit-tested. The drift check is the only layer that
 * can detect cross-chain multiplier divergence — nothing on either stack
 * enforces it on-chain — but it is inherently multi-chain, so its logic lives
 * here where it can be unit-tested. These functions carry all of its decision
 * logic and none of its I/O.
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

export interface LagRisk {
  chain: string;
  /** `lagging`: already halted while the fleet accrues. `imminent`: stops within the alarm window, before the fleet. */
  kind: "lagging" | "imminent";
  /** When this chain stops accruing (`now` if already halted). */
  stopsAt: bigint;
  /** Latest point any chain in the fleet keeps accruing to (0 = unbounded). */
  fleetStopsAt: bigint;
}

/**
 * Chains about to fall (or already fallen) behind the fleet's multiplier.
 *
 * A chain whose accrual stops before the rest of the fleet's prices its PSM
 * mints below the fleet from that moment (Cyfrin audit finding #2). The point
 * of this check is to fire BEFORE that moment, so the warm pauser can close the
 * chain's PSM in advance and the allowance manager can zero its minter
 * allowance before it reopens: a missed broadcast shows up as a successor that
 * is still not armed `alarmWindowSec` before the chain's accrual runs out.
 *
 * A fleet that stops together is not a lag (every chain halts at the same
 * multiplier); the existing expiry warning and HALTED error cover it.
 */
export function findLagRisks(
  chains: { chain: string; state: AccrualState }[],
  now: bigint,
  alarmWindowSec: bigint
): LagRisk[] {
  // 0n stands for "unbounded" in the horizon comparison.
  const horizon = (s: AccrualState): bigint => (s.halted ? now : s.runsOutAt);
  const later = (a: bigint, b: bigint): boolean => (a === 0n ? b !== 0n : b !== 0n && a > b);
  let fleet = now;
  for (const c of chains) {
    const h = horizon(c.state);
    if (later(h, fleet)) fleet = h;
  }
  const risks: LagRisk[] = [];
  for (const c of chains) {
    const h = horizon(c.state);
    if (!later(fleet, h)) continue; // keeps up with the fleet
    if (c.state.halted) {
      risks.push({ chain: c.chain, kind: "lagging", stopsAt: h, fleetStopsAt: fleet });
    } else if (h - now <= alarmWindowSec) {
      risks.push({ chain: c.chain, kind: "imminent", stopsAt: h, fleetStopsAt: fleet });
    }
  }
  return risks;
}

export interface CoverageResult {
  /** Every expected chain produced a reading. */
  complete: boolean;
  /** Expected chains with no reading, each with its reason, sorted. */
  missing: string[];
}

/**
 * Coverage of the expected fleet. "All chains in agreement" is only a valid
 * conclusion when EVERY expected chain was read: agreement among the readable
 * subset says nothing about the unreadable rest (with one readable chain it
 * is vacuous). `problems` maps chain -> why it produced no reading.
 */
export function assessCoverage(
  expected: string[],
  readable: string[],
  problems: Record<string, string> = {}
): CoverageResult {
  const got = new Set(readable);
  const missing = expected
    .filter((c) => !got.has(c))
    .map((c) => `${c} (${problems[c] ?? "no reading"})`)
    .sort();
  return { complete: missing.length === 0, missing };
}
