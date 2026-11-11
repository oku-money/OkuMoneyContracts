import { test } from "node:test";
import assert from "node:assert/strict";
import { PRECISION, rearmWindowProblem, type Schedule } from "../src/multiplier";

// Cyfrin audit #13 follow-up: a re-arm only keeps every chain's stored schedule identical when
// the chain processes it inside the segment it re-arms. `rearmWindowProblem` names the cases
// where it does not, at the chain's OWN clock.

const R1 = PRECISION + 1_547_126_016n;
const R2 = PRECISION + 2_440_418_608n;
const S: Schedule = {
  baseMultiplier: PRECISION,
  ratePerSecond: R1,
  lastAccrualTime: 1_000n,
  rateEnd: 2_000n, // active window
  pendingRatePerSecond: R2,
  pendingRateEnd: 3_000n, // successor window
};

test("repeating the live active segment is fine until its end second", () => {
  assert.equal(rearmWindowProblem(S, 1_000n, R1, 2_000n), null);
  assert.equal(rearmWindowProblem(S, 1_999n, R1, 2_000n), null);
  assert.equal(rearmWindowProblem(S, 2_000n, R1, 2_000n), "segment-ended"); // the contract needs end > now
  assert.equal(rearmWindowProblem(S, 2_500n, R1, 2_000n), "segment-ended");
});

test("repeating the armed successor needs the chain's clock past the active window (the silent one)", () => {
  // a LAGGING chain: still inside the active window, so the contracts would take it as a
  // plain rate change and re-anchor at the lagging time
  assert.equal(rearmWindowProblem(S, 1_500n, R2, 3_000n), "segment-not-started");
  assert.equal(rearmWindowProblem(S, 1_999n, R2, 3_000n), "segment-not-started");
  assert.equal(rearmWindowProblem(S, 2_000n, R2, 3_000n), "segment-not-started"); // promote needs now > rateEnd
  assert.equal(rearmWindowProblem(S, 2_001n, R2, 3_000n), null);
  assert.equal(rearmWindowProblem(S, 2_999n, R2, 3_000n), null);
  assert.equal(rearmWindowProblem(S, 3_000n, R2, 3_000n), "segment-ended");
});

test("anything that is not a repeat of a stored segment is not guarded", () => {
  for (const now of [0n, 1_500n, 2_500n, 5_000n]) {
    assert.equal(rearmWindowProblem(S, now, R1 + 1n, 2_000n), null, "a one-wei rate change");
    assert.equal(rearmWindowProblem(S, now, R1, 2_001n), null, "a one-second end change");
    assert.equal(rearmWindowProblem(S, now, R2, 3_001n), null);
    assert.equal(rearmWindowProblem(S, now, PRECISION, 0n), null, "a halt");
  }
});

test("a halted or unarmed schedule has no successor segment to repeat", () => {
  const unarmed: Schedule = { ...S, pendingRatePerSecond: PRECISION, pendingRateEnd: 0n };
  assert.equal(rearmWindowProblem(unarmed, 1_500n, PRECISION, 0n), null);
  assert.equal(rearmWindowProblem(unarmed, 1_500n, R2, 3_000n), null);
  const halted: Schedule = { ...S, ratePerSecond: PRECISION, rateEnd: 0n, pendingRatePerSecond: R2, pendingRateEnd: 3_000n };
  // rateEnd == 0: there is no active window to be inside of
  assert.equal(rearmWindowProblem(halted, 100n, R2, 3_000n), null);
});

test("after the active window lapsed, repeating the stored active segment is stale, the successor is live", () => {
  assert.equal(rearmWindowProblem(S, 2_500n, R1, 2_000n), "segment-ended");
  assert.equal(rearmWindowProblem(S, 2_500n, R2, 3_000n), null);
});
