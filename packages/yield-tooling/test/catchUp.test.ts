/**
 * `catchUpRate` / `planCatchUp`: the rate that brings a lagging chain (e.g. SVM
 * halted by a depeg pause) back to the leader's multiplier.
 *
 * Run: npm run test:tooling     (from the repo root)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PRECISION,
  MAX_RATE,
  compoundFor,
  computeMultiplier,
  ratePerSecondForApy,
  catchUpRate,
  planCatchUp,
  type Schedule,
} from "../src";

const DAY = 86_400n;
const T0 = 1_800_000_000n;

const halted = (base: bigint, at: bigint): Schedule => ({
  baseMultiplier: base,
  ratePerSecond: PRECISION,
  lastAccrualTime: at,
  rateEnd: 0n,
  pendingRatePerSecond: PRECISION,
  pendingRateEnd: 0n,
});

test("catchUpRate is the minimal rate that reaches the target", () => {
  const cur = PRECISION + 1_000_000_000_000_000n; // 1.001
  for (const apy of [0.01, 0.05, 0.5]) {
    const window = 10n * DAY;
    const target = compoundFor(cur, ratePerSecondForApy(apy), window);
    const r = catchUpRate({ currentMultiplier: cur, targetMultiplier: target, windowSeconds: window });
    assert.ok(compoundFor(cur, r, window) >= target, "reaches target");
    assert.ok(compoundFor(cur, r - 1n, window) < target, "one less falls short");
  }
});

test("a 3-day depeg gap at 5% APY is closed over one day with a modest rate", () => {
  const leader: Schedule = {
    baseMultiplier: PRECISION,
    ratePerSecond: ratePerSecondForApy(0.05),
    lastAccrualTime: T0,
    rateEnd: T0 + 30n * DAY,
    pendingRatePerSecond: PRECISION,
    pendingRateEnd: 0n,
  };
  const now = T0 + 3n * DAY;
  const laggard = halted(PRECISION, T0); // halted since T0
  const end = now + DAY;
  const plan = planCatchUp({ leader, laggard, nowTs: now, end });

  assert.equal(plan.end, end);
  assert.equal(plan.currentMultiplier, PRECISION);
  assert.ok(plan.rate > ratePerSecondForApy(0.05), "runs hotter than the leader");
  assert.ok(plan.rate <= MAX_RATE);

  // Applying the plan lands the laggard at (or just above) the leader at `end`.
  const after: Schedule = { ...laggard, ratePerSecond: plan.rate, lastAccrualTime: now, rateEnd: end };
  const got = computeMultiplier(after, end);
  assert.ok(got >= plan.targetMultiplier);
  assert.ok(got - plan.targetMultiplier < 1_000_000_000n, "overshoot is dust");
});

test("planCatchUp defaults to the leader's rateEnd", () => {
  const leader: Schedule = { ...halted(PRECISION + 5n * 10n ** 15n, T0), ratePerSecond: ratePerSecondForApy(0.05), rateEnd: T0 + 5n * DAY };
  const plan = planCatchUp({ leader, laggard: halted(PRECISION, T0), nowTs: T0 + DAY });
  assert.equal(plan.end, leader.rateEnd);
});

test("throws when the target is not above current", () => {
  assert.throws(
    () => catchUpRate({ currentMultiplier: PRECISION, targetMultiplier: PRECISION, windowSeconds: DAY }),
    /nothing to catch up/,
  );
});

test("throws on a non-positive window", () => {
  assert.throws(
    () => catchUpRate({ currentMultiplier: PRECISION, targetMultiplier: PRECISION + 1n, windowSeconds: 0n }),
    /windowSeconds/,
  );
});

test("throws when MAX_RATE over the window cannot reach the target", () => {
  assert.throws(
    () => catchUpRate({ currentMultiplier: PRECISION, targetMultiplier: 2n * PRECISION, windowSeconds: 1n }),
    /MAX_RATE/,
  );
});

test("planCatchUp throws when the leader's window is not live", () => {
  const leader = halted(PRECISION, T0);
  assert.throws(() => planCatchUp({ leader, laggard: halted(PRECISION, T0), nowTs: T0 + DAY }), /not in the future/);
});

test("tiny gap: smallest representable lead still yields a rate above PRECISION", () => {
  const r = catchUpRate({ currentMultiplier: PRECISION, targetMultiplier: PRECISION + 1n, windowSeconds: 90n * DAY });
  assert.ok(r > PRECISION);
});
