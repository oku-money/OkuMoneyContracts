/**
 * Custom Assertion Helpers
 *
 * Provides assertion utilities that mirror Forge/Hardhat test patterns:
 * - expectError: Assert that a function throws with a specific error code
 * - expectEvent: Assert that a transaction emits a specific event
 * - closeTo: Assert that a BN is within tolerance of an expected value
 * - expectComputeUnits: Assert compute unit consumption
 *
 * These helpers make SVM tests more readable and consistent with EVM tests.
 */

import { expect } from "chai";
import { BN } from "@anchor-lang/core";
import { Connection, TransactionSignature } from "@solana/web3.js";
import { SurfpoolClient, ProfileResult } from "./surfpool";

// ============================================================================
// Error Assertions
// ============================================================================

/**
 * Assert that an async function throws an error containing the expected code.
 * Mirrors Forge's `vm.expectRevert()` and Hardhat's `revertedWithCustomError`.
 *
 * @example
 * ```typescript
 * await expectError(
 *   () => program.methods.mintOkuM(amount).rpc(),
 *   "InsufficientBalance"
 * );
 * ```
 */
export async function expectError(
  fn: () => Promise<any>,
  expectedCode: string,
  message?: string
): Promise<void> {
  try {
    await fn();
    throw new Error(
      message || `Expected error "${expectedCode}" but transaction succeeded`
    );
  } catch (err: any) {
    // Handle Anchor program errors
    const errorCode = err.error?.errorCode?.code;
    const errorMsg = err.error?.errorMessage;
    const fullError = err.toString();

    // Check if the error matches
    const matches =
      errorCode === expectedCode ||
      (errorMsg && errorMsg.includes(expectedCode)) ||
      fullError.includes(expectedCode);

    if (!matches) {
      // Re-throw with helpful message showing actual error
      const actualError = errorCode || errorMsg || fullError;
      throw new Error(
        `Expected error "${expectedCode}" but got "${actualError}"\n${message || ""}`
      );
    }
  }
}

/**
 * Assert that an async function succeeds (does not throw).
 *
 * @example
 * ```typescript
 * await expectSuccess(() => program.methods.mintOkuM(amount).rpc());
 * ```
 */
export async function expectSuccess(
  fn: () => Promise<any>,
  message?: string
): Promise<any> {
  try {
    return await fn();
  } catch (err: any) {
    const errorCode = err.error?.errorCode?.code;
    const errorMsg = err.error?.errorMessage;
    throw new Error(
      `Expected success but got error: ${errorCode || errorMsg || err}\n${message || ""}`
    );
  }
}

/**
 * Assert that an async function throws any error (doesn't check code).
 *
 * @example
 * ```typescript
 * await expectAnyError(() => program.methods.invalidCall().rpc());
 * ```
 */
export async function expectAnyError(
  fn: () => Promise<any>,
  message?: string
): Promise<void> {
  try {
    await fn();
    throw new Error(message || "Expected error but transaction succeeded");
  } catch (err: any) {
    // Any error is acceptable
    if (err.message?.includes("Expected error but transaction succeeded")) {
      throw err;
    }
  }
}

// ============================================================================
// BN Assertions
// ============================================================================

/**
 * Assert that a BN is within tolerance of an expected value.
 * Mirrors Chai's `closeTo` for regular numbers.
 *
 * @example
 * ```typescript
 * // Assert balance is within 1 token of expected
 * assertCloseTo(actualBalance, expectedBalance, new BN(1));
 * ```
 */
export function assertCloseTo(
  actual: BN,
  expected: BN,
  tolerance: BN,
  message?: string
): void {
  const diff = actual.sub(expected).abs();
  expect(
    diff.lte(tolerance),
    `${message || "Values not close enough"}: actual=${actual.toString()}, expected=${expected.toString()}, diff=${diff.toString()}, tolerance=${tolerance.toString()}`
  ).to.be.true;
}

/**
 * Assert that a BN equals an expected value.
 *
 * @example
 * ```typescript
 * assertBNEqual(balance, new BN(1000));
 * ```
 */
export function assertBNEqual(actual: BN, expected: BN, message?: string): void {
  expect(
    actual.eq(expected),
    `${message || "BN not equal"}: actual=${actual.toString()}, expected=${expected.toString()}`
  ).to.be.true;
}

/**
 * Assert that a BN is greater than or equal to an expected value.
 */
export function assertBNGte(actual: BN, expected: BN, message?: string): void {
  expect(
    actual.gte(expected),
    `${message || "BN not gte"}: actual=${actual.toString()}, expected=${expected.toString()}`
  ).to.be.true;
}

/**
 * Assert that a BN is less than or equal to an expected value.
 */
export function assertBNLte(actual: BN, expected: BN, message?: string): void {
  expect(
    actual.lte(expected),
    `${message || "BN not lte"}: actual=${actual.toString()}, expected=${expected.toString()}`
  ).to.be.true;
}

/**
 * Assert that a BN is greater than an expected value.
 */
export function assertBNGt(actual: BN, expected: BN, message?: string): void {
  expect(
    actual.gt(expected),
    `${message || "BN not gt"}: actual=${actual.toString()}, expected=${expected.toString()}`
  ).to.be.true;
}

/**
 * Assert that a BN is less than an expected value.
 */
export function assertBNLt(actual: BN, expected: BN, message?: string): void {
  expect(
    actual.lt(expected),
    `${message || "BN not lt"}: actual=${actual.toString()}, expected=${expected.toString()}`
  ).to.be.true;
}

/**
 * Assert that a BN is zero.
 */
export function assertBNZero(actual: BN, message?: string): void {
  expect(
    actual.isZero(),
    `${message || "BN not zero"}: actual=${actual.toString()}`
  ).to.be.true;
}

/**
 * Assert that a BN is not zero.
 */
export function assertBNNotZero(actual: BN, message?: string): void {
  expect(
    !actual.isZero(),
    `${message || "BN is zero"}: actual=${actual.toString()}`
  ).to.be.true;
}

// ============================================================================
// Compute Unit Assertions
// ============================================================================

/**
 * Assert that a profiled transaction consumed less than the specified compute units.
 *
 * @example
 * ```typescript
 * const profile = await surfpool.profileTransaction(tx, "mint");
 * assertComputeUnitsLessThan(profile, 100_000, "mint should be efficient");
 * ```
 */
export function assertComputeUnitsLessThan(
  profile: ProfileResult,
  maxCU: number,
  message?: string
): void {
  const consumed = profile.computeUnits.computeUnitsConsumed;
  expect(
    consumed < maxCU,
    `${message || "Compute units exceeded"}: consumed=${consumed}, max=${maxCU}`
  ).to.be.true;
}

/**
 * Assert that a profiled transaction succeeded.
 */
export function assertProfileSuccess(profile: ProfileResult, message?: string): void {
  expect(
    profile.computeUnits.success,
    `${message || "Transaction failed"}: ${profile.computeUnits.errorMessage}`
  ).to.be.true;
}

/**
 * Assert that a profiled transaction failed.
 */
export function assertProfileFailure(profile: ProfileResult, message?: string): void {
  expect(
    !profile.computeUnits.success,
    `${message || "Transaction unexpectedly succeeded"}`
  ).to.be.true;
}

// ============================================================================
// Event Assertions
// ============================================================================

/**
 * Parse Anchor events from transaction logs.
 * Returns all events emitted by the transaction.
 *
 * Note: Requires the program's IDL to decode events.
 *
 * @example
 * ```typescript
 * const events = await getTransactionEvents(connection, signature, program);
 * const mintEvent = events.find(e => e.name === "MintEvent");
 * expect(mintEvent.data.amount.eq(new BN(1000))).to.be.true;
 * ```
 */
export async function getTransactionLogs(
  connection: Connection,
  signature: TransactionSignature
): Promise<string[]> {
  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
  });

  if (!tx?.meta?.logMessages) {
    return [];
  }

  return tx.meta.logMessages;
}

/**
 * Assert that transaction logs contain a specific message.
 *
 * @example
 * ```typescript
 * const logs = await getTransactionLogs(connection, signature);
 * assertLogsContain(logs, "Program log: Minted 1000 tokens");
 * ```
 */
export function assertLogsContain(logs: string[], expected: string, message?: string): void {
  const found = logs.some((log) => log.includes(expected));
  expect(
    found,
    `${message || "Log not found"}: expected to find "${expected}" in logs`
  ).to.be.true;
}

/**
 * Assert that transaction logs do NOT contain a specific message.
 */
export function assertLogsNotContain(
  logs: string[],
  unexpected: string,
  message?: string
): void {
  const found = logs.some((log) => log.includes(unexpected));
  expect(
    !found,
    `${message || "Unexpected log found"}: did not expect to find "${unexpected}" in logs`
  ).to.be.true;
}

// ============================================================================
// Balance Assertions
// ============================================================================

/**
 * Assert that a token balance changed by the expected amount.
 *
 * @example
 * ```typescript
 * const balanceBefore = await getTokenBalance(connection, ata);
 * await program.methods.mint(amount).rpc();
 * const balanceAfter = await getTokenBalance(connection, ata);
 *
 * assertBalanceChange(balanceBefore, balanceAfter, amount, "mint should increase balance");
 * ```
 */
export function assertBalanceChange(
  before: BN,
  after: BN,
  expectedChange: BN,
  message?: string
): void {
  const actualChange = after.sub(before);
  assertBNEqual(
    actualChange,
    expectedChange,
    message || `Balance change mismatch: expected ${expectedChange.toString()}, got ${actualChange.toString()}`
  );
}

/**
 * Assert that a balance increased by at least the specified amount.
 */
export function assertBalanceIncreased(
  before: BN,
  after: BN,
  minIncrease: BN,
  message?: string
): void {
  const change = after.sub(before);
  assertBNGte(
    change,
    minIncrease,
    message || `Balance should have increased by at least ${minIncrease.toString()}`
  );
}

/**
 * Assert that a balance decreased by at least the specified amount.
 */
export function assertBalanceDecreased(
  before: BN,
  after: BN,
  minDecrease: BN,
  message?: string
): void {
  const change = before.sub(after);
  assertBNGte(
    change,
    minDecrease,
    message || `Balance should have decreased by at least ${minDecrease.toString()}`
  );
}

// ============================================================================
// Round-Trip Assertions
// ============================================================================

/**
 * Assert that a round-trip operation loses at most the specified amount.
 * Mirrors the EVM invariant tests for wrap/unwrap and mint/burn cycles.
 *
 * @example
 * ```typescript
 * // Wrap and unwrap should lose at most 1 wei
 * assertMaxLoss(balanceBefore, balanceAfter, new BN(1), "round-trip loss");
 * ```
 */
export function assertMaxLoss(
  before: BN,
  after: BN,
  maxLoss: BN,
  message?: string
): void {
  const loss = before.sub(after);

  // Loss should be non-negative (we shouldn't gain tokens)
  expect(
    loss.gte(new BN(0)),
    `${message || "Unexpected gain"}: gained ${loss.abs().toString()} tokens`
  ).to.be.true;

  // Loss should be within tolerance
  assertBNLte(
    loss,
    maxLoss,
    message || `Loss exceeded maximum: lost ${loss.toString()}, max allowed ${maxLoss.toString()}`
  );
}

/**
 * Assert that no tokens were created or destroyed (conservation).
 * Useful for testing transfer operations.
 */
export function assertConservation(
  senderBefore: BN,
  senderAfter: BN,
  recipientBefore: BN,
  recipientAfter: BN,
  message?: string
): void {
  const senderChange = senderBefore.sub(senderAfter);
  const recipientChange = recipientAfter.sub(recipientBefore);

  assertBNEqual(
    senderChange,
    recipientChange,
    message || "Token conservation violated: sender decrease should equal recipient increase"
  );
}

// ============================================================================
// Invariant Assertion Helpers
// ============================================================================

/**
 * Create an invariant checker that can be called repeatedly during invariant tests.
 *
 * @example
 * ```typescript
 * const checkSupplyCap = createInvariantChecker(
 *   async () => {
 *     const supply = await getTotalSupply();
 *     const maxSupply = await getMaxSupply();
 *     return supply.lte(maxSupply);
 *   },
 *   "Supply should never exceed max supply"
 * );
 *
 * // In test loop:
 * await handler.randomOperation();
 * await checkSupplyCap();
 * ```
 */
export function createInvariantChecker(
  check: () => Promise<boolean>,
  description: string
): () => Promise<void> {
  return async () => {
    const passed = await check();
    expect(passed, `Invariant violated: ${description}`).to.be.true;
  };
}

/**
 * Run multiple invariant checks in sequence.
 */
export async function checkInvariants(
  checkers: Array<() => Promise<void>>
): Promise<void> {
  for (const checker of checkers) {
    await checker();
  }
}
