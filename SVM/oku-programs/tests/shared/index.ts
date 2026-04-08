/**
 * Shared Test Infrastructure
 *
 * Central export point for all shared test utilities.
 * Import from here for clean, organized imports.
 *
 * @example
 * ```typescript
 * import {
 *   // Setup utilities
 *   initializePSMIfNeeded,
 *   safeAirdrop,
 *   coldMultisig,
 *
 *   // Surfpool client
 *   SurfpoolClient,
 *   createSurfpoolClient,
 *
 *   // Assertions
 *   expectError,
 *   assertBNEqual,
 *
 *   // Fixtures
 *   fundUser,
 *   createFundedUser,
 *
 *   // Fuzz generators
 *   arbAmount,
 *   arbPrice,
 * } from "./shared";
 * ```
 */

// Core setup utilities
export * from "./setup";

// Surfpool client and helpers
export * from "./surfpool";

// Custom assertions
export * from "./assertions";

// Test fixtures
export * from "./fixtures";

// Fuzz test generators
export * from "./fuzz/generators";

// Invariant test handlers
export { PsmHandler } from "./handlers/psm-handler";
export { VaultHandler } from "./handlers/vault-handler";
