/**
 * Cross-language differential replay: TypeScript vs the Solidity reference.
 *
 * The sibling of `SVM/oku-programs/crates/oku-shared/tests/differential.rs`.
 * Both replay the same committed corpus; see that file's header for why the
 * three implementations must agree and why nothing on-chain can catch it if
 * they do not.
 *
 * This arm matters more than it might look. The TypeScript mirror is what the
 * epoch orchestrator uses to compute SVM's contribution to `V(t)` and what
 * `checkMultiplierDrift` uses to compare SVM against the EVM chains — Solana
 * has no view functions, so there is nothing to `call()`. A drift here would
 * silently mis-size every derived rate.
 *
 * Run: npm run test:tooling     (from the repo root)
 * Regenerate the corpus: cd EVM && forge test --match-contract GenerateVectors
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { computeMultiplier, type Schedule } from "../src/multiplier";

interface Vector {
  base: string;
  rate: string;
  anchor: string;
  rateEnd: string;
  pendingRate: string;
  pendingRateEnd: string;
  nowTs: string;
  reverted: boolean;
  expected: string;
}

const CORPUS = path.join(__dirname, "../../../EVM/test/differential/vectors.jsonl");

function loadCorpus(): Vector[] {
  if (!fs.existsSync(CORPUS)) {
    throw new Error(
      `cannot read differential corpus at ${CORPUS}.\n` +
        "Generate it with: cd EVM && forge test --match-contract GenerateVectors",
    );
  }
  return fs
    .readFileSync(CORPUS, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Vector);
}

function scheduleOf(v: Vector): Schedule {
  return {
    baseMultiplier: BigInt(v.base),
    ratePerSecond: BigInt(v.rate),
    lastAccrualTime: BigInt(v.anchor),
    rateEnd: BigInt(v.rateEnd),
    pendingRatePerSecond: BigInt(v.pendingRate),
    pendingRateEnd: BigInt(v.pendingRateEnd),
  };
}

test("computeMultiplier matches the Solidity reference exactly", () => {
  const vectors = loadCorpus();
  assert.ok(
    vectors.length > 1_000,
    `corpus looks truncated: only ${vectors.length} vectors. Regenerate it.`,
  );

  const mismatches: string[] = [];
  let revertCases = 0;

  vectors.forEach((v, i) => {
    const schedule = scheduleOf(v);
    const now = BigInt(v.nowTs);

    let threw = false;
    let actual: bigint | null = null;
    try {
      actual = computeMultiplier(schedule, now);
    } catch {
      threw = true;
    }

    if (v.reverted) {
      revertCases += 1;
      // Reverts are checked as strictly as values: "one implementation accepts
      // what another rejects" is just as much a divergence as a wrong number.
      if (!threw) {
        mismatches.push(`line ${i + 1}: Solidity REVERTED, TS returned ${actual}`);
      }
      return;
    }

    if (threw) {
      mismatches.push(`line ${i + 1}: Solidity returned ${v.expected}, TS threw`);
    } else if (actual !== BigInt(v.expected)) {
      mismatches.push(`line ${i + 1}: expected ${v.expected}, got ${actual}`);
    }
  });

  assert.equal(
    mismatches.length,
    0,
    `${mismatches.length} of ${vectors.length} vectors diverged from the ` +
      `Solidity reference:\n\n${mismatches.slice(0, 20).join("\n")}`,
  );

  // eslint-disable-next-line no-console
  console.log(
    `  differential: ${vectors.length} vectors matched (${revertCases} revert cases)`,
  );
});
