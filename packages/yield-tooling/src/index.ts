/**
 * @okumoney/yield-tooling
 *
 * Chain-agnostic pieces of the yield system, shared by both stacks.
 *
 * The protocol's cross-chain determinism rests on every deployment returning
 * the same multiplier at the same wall-clock second, and there is no on-chain
 * layer on either stack that can detect a divergence. Anything that reimplements
 * that math in a third place is a liability; this package exists so there is
 * exactly one TypeScript implementation rather than one per consumer.
 *
 * Consumers today:
 *   - `EVM/scripts/utils/globalValue.ts`          (V(t) must include SVM supply)
 *   - `EVM/scripts/operator/checkMultiplierDrift` (SVM has no view functions)
 *   - `SVM/oku-programs/scripts/admin/*`          (read-schedule, set-yield-rate)
 *   - `SVM/oku-programs/tests/**`                 (canonical multiplier in tests)
 */

export * from "./multiplier";
