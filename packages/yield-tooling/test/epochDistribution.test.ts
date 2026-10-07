/**
 * Window-coverage rules for `distributedUsdOverWindow` / `windowSamples`:
 * the window start must be covered (interpolated when no sample sits exactly
 * on it), and no gap between samples may exceed `maxGapSec`.
 *
 * Run: npm run test:tooling     (from the repo root)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  distributedUsdOverWindow,
  multiplierAt,
  windowSamples,
  DEFAULT_MAX_SAMPLE_GAP_SEC,
  type RateSegment,
} from "../src/epochDistribution";

const RATE = 1.0000001;
const SEGMENTS: RateSegment[] = [{ startSec: 0, endSec: 20_000, ratePerSecond: RATE, anchorMultiplier: 1.0 }];
const S = 10_000_000;
const flat = (t: number) => ({ timestampSec: t, valueUsd: S * multiplierAt(SEGMENTS, t) });

test("start boundary: value at windowStart is interpolated between the last sample before and first after", () => {
  const samples = [
    { timestampSec: 0, valueUsd: 100 },
    { timestampSec: 1000, valueUsd: 200 },
    { timestampSec: 2000, valueUsd: 300 },
  ];
  const series = windowSamples(samples, 250, 2000);
  assert.deepEqual(series[0], { timestampSec: 250, valueUsd: 125 });
  assert.deepEqual(
    series.map((s) => s.timestampSec),
    [250, 1000, 2000]
  );
});

test("start boundary: a sample exactly at windowStart is used verbatim", () => {
  const series = windowSamples([flat(0), flat(500), flat(1000)], 500, 1000);
  assert.deepEqual(series, [flat(500), flat(1000)]);
});

test("start boundary: distribution integrates from windowStart, not from the first in-window sample", () => {
  // Flat supply; samples straddle the start. Exact answer is S * (m(end) - m(start)).
  const samples = [0, 1000, 2000, 3000].map(flat);
  const got = distributedUsdOverWindow(SEGMENTS, samples, 400, 3000);
  const expected = S * (multiplierAt(SEGMENTS, 3000) - multiplierAt(SEGMENTS, 400));
  assert.ok(Math.abs(got - expected) < 1e-2, `got ${got}, expected ${expected}`);
});

test("rejects a window whose start is not covered (two late samples are not enough)", () => {
  const late = [flat(800), flat(900)];
  assert.throws(() => distributedUsdOverWindow(SEGMENTS, late, 0, 1000), /start is not covered/);
  assert.throws(() => windowSamples(late, 0, 1000), /start is not covered/);
});

test("rejects a gap between consecutive samples larger than maxGapSec", () => {
  const samples = [flat(0), flat(100), flat(5000), flat(5100)];
  assert.throws(() => distributedUsdOverWindow(SEGMENTS, samples, 0, 5100, { maxGapSec: 1000 }), /gap/);
  // Same series is fine under the default (6h) cap.
  assert.doesNotThrow(() => distributedUsdOverWindow(SEGMENTS, samples, 0, 5100));
});

test("the gap check includes the pre-window sample used to cover the start", () => {
  const samples = [flat(0), flat(5000), flat(5500)];
  assert.throws(() => windowSamples(samples, 4000, 5500, { maxGapSec: 1000 }), /gap/);
});

test("rejects an end-of-window extrapolation tail longer than maxGapSec", () => {
  const samples = [flat(0), flat(100)];
  assert.throws(() => windowSamples(samples, 0, 5000, { maxGapSec: 1000 }), /before the end/);
});

test("default maxGapSec is 6h", () => {
  assert.equal(DEFAULT_MAX_SAMPLE_GAP_SEC, 6 * 3600);
  const t0 = 0;
  const ok = [{ timestampSec: t0, valueUsd: 1 }, { timestampSec: t0 + 6 * 3600, valueUsd: 1 }];
  assert.doesNotThrow(() => windowSamples(ok, t0, t0 + 6 * 3600));
  const bad = [{ timestampSec: t0, valueUsd: 1 }, { timestampSec: t0 + 6 * 3600 + 1, valueUsd: 1 }];
  assert.throws(() => windowSamples(bad, t0, t0 + 6 * 3600 + 1), /gap/);
});

test("still requires at least 2 points after clipping", () => {
  assert.throws(() => windowSamples([flat(0)], 0, 1000), /need at least 2/);
  assert.throws(() => windowSamples([], 0, 1000), /need at least 2/);
});
