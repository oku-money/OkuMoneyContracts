/**
 * Re-export shim. This module moved to `packages/yield-tooling/src/epochSchedule.ts`
 * when the epoch-derivation layer became chain-agnostic shared tooling — SVM
 * needs the same math to derive its own leg of a broadcast schedule, and it
 * was already dependency-free (no ethers, no chain calls), so lifting it cost
 * nothing.
 *
 * Kept here so no existing EVM import path had to change. Prefer importing
 * directly from `@okumoney/yield-tooling` in new code.
 */
export * from '@okumoney/yield-tooling/src/epochSchedule';
