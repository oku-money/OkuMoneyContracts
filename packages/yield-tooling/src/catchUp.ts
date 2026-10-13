/**
 * Catch-up rate for a chain whose multiplier lags the others (e.g. SVM after a
 * depeg pause outlasted its armed window while EVM kept accruing).
 *
 * The multiplier is monotonic, so a leader can never be brought back; the lagging
 * chain has to run hot until it rejoins. This derives the smallest rate that does so.
 *
 * Uses the exact integer `compoundFor` (the same rounding as both chains), not a
 * float estimate, so the result is the minimal rate whose on-chain multiplier at
 * `windowSeconds` is >= the target. Monotonicity of `compoundFor` in the rate
 * makes a binary search over `[PRECISION, MAX_RATE]` valid.
 *
 * Two operational caveats:
 *   - The write re-anchors at the block time it lands in, not at `nowTs`. A
 *     transaction landing `d` seconds late leaves a `windowSeconds - d` window, so
 *     the chain ends slightly BELOW target (the safe direction: a shortfall can be
 *     topped up, an overshoot cannot be corrected).
 *   - The write is a yielding write, so it is rejected while the contract is paused
 *     (EVM `EnforcedPause` / SVM `Paused`). Unpause first.
 */

import { PRECISION, MAX_RATE, MAX_MULTIPLIER, compoundFor, computeMultiplier, type Schedule } from "./multiplier";

/**
 * Smallest per-second rate such that `base` compounded for `windowSeconds`
 * reaches `targetMultiplier`. Throws if no rate in `(PRECISION, MAX_RATE]` can.
 */
export function catchUpRate(args: {
  currentMultiplier: bigint;
  targetMultiplier: bigint;
  windowSeconds: bigint;
}): bigint {
  const { currentMultiplier: cur, targetMultiplier: target, windowSeconds: window } = args;
  if (window <= 0n) throw new Error(`catchUpRate: windowSeconds must be > 0, got ${window}`);
  if (target <= cur) {
    throw new Error(`catchUpRate: target ${target} <= current ${cur}; nothing to catch up`);
  }
  if (target > MAX_MULTIPLIER) {
    throw new Error(`catchUpRate: target ${target} exceeds MAX_MULTIPLIER ${MAX_MULTIPLIER}`);
  }
  if (compoundFor(cur, MAX_RATE, window) < target) {
    throw new Error(
      `catchUpRate: even MAX_RATE over ${window}s cannot reach ${target} from ${cur}; ` +
        "lengthen the window (<= the 90-day cap) or catch up over several windows",
    );
  }

  // Invariant: lo falls short, hi reaches. `target > cur` means PRECISION (no yield) falls short.
  let lo = PRECISION;
  let hi = MAX_RATE;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if (compoundFor(cur, mid, window) >= target) hi = mid;
    else lo = mid;
  }
  return hi;
}

export interface CatchUpPlan {
  /** Rate to write on the lagging chain. */
  rate: bigint;
  /** Absolute expiry of that rate: the leader's `rateEnd`, so both chains share a handover instant. */
  end: bigint;
  /** The leader's multiplier at `end`, which the laggard is aimed at. */
  targetMultiplier: bigint;
  /** The laggard's multiplier at `nowTs`. */
  currentMultiplier: bigint;
}

/**
 * Plan a catch-up so the laggard equals the leader's projected multiplier at `end`
 * (default: the leader's `rateEnd`). From there the same successor can take over on
 * both chains, so they accrue identically again.
 *
 * `nowTs` is an explicit input so the plan is reproducible; pass the chain
 * timestamp, not wall clock, where they may differ (SVM `Clock` can lag).
 */
export function planCatchUp(args: {
  leader: Schedule;
  laggard: Schedule;
  nowTs: bigint;
  end?: bigint;
}): CatchUpPlan {
  const { leader, laggard, nowTs } = args;
  const end = args.end ?? leader.rateEnd;
  if (end === 0n || end <= nowTs) {
    throw new Error(
      `planCatchUp: end ${end} is not in the future (now ${nowTs}). The leader has no live window; ` +
        "pass an explicit `end` after re-publishing the leader's schedule.",
    );
  }
  const targetMultiplier = computeMultiplier(leader, end);
  const currentMultiplier = computeMultiplier(laggard, nowTs);
  const rate = catchUpRate({ currentMultiplier, targetMultiplier, windowSeconds: end - nowTs });
  return { rate, end, targetMultiplier, currentMultiplier };
}
