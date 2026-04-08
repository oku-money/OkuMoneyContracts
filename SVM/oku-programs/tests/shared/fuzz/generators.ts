/**
 * Fuzz Test Generators
 *
 * Provides generators for property-based fuzz testing using fast-check.
 * These generators create valid test inputs within domain-specific constraints.
 *
 * Mirrors the Forge fuzz test patterns (bound functions, testFuzz_* naming).
 */

import * as fc from "fast-check";
import { PublicKey, Keypair } from "@solana/web3.js";
import { BN } from "@anchor-lang/core";

// ============================================================================
// Constants
// ============================================================================

export const DECIMALS = 6;
export const PRECISION = new BN(10).pow(new BN(18));
export const MAX_SUPPLY = 1_000_000_000_000; // 1M with 6 decimals
export const MAX_PRICE = 10_000_000_000_000_000_000n; // 10x starting price (1e19)

// ============================================================================
// Amount Generators
// ============================================================================

/**
 * Generate a valid token amount within supply constraints.
 *
 * @param max - Maximum amount (defaults to MAX_SUPPLY / 100)
 * @param min - Minimum amount (defaults to 1)
 *
 * @example
 * ```typescript
 * await fc.assert(
 *   fc.asyncProperty(arbAmount(), async (amount) => {
 *     // amount is a number between 1 and MAX_SUPPLY / 100
 *   })
 * );
 * ```
 */
export function arbAmount(max: number = MAX_SUPPLY / 100, min: number = 1): fc.Arbitrary<number> {
  return fc.integer({ min, max });
}

/**
 * Generate a valid token amount as BN.
 */
export function arbAmountBN(max: number = MAX_SUPPLY / 100, min: number = 1): fc.Arbitrary<BN> {
  return arbAmount(max, min).map((n) => new BN(n));
}

/**
 * Generate a "dust" amount (very small, 1-100 tokens).
 */
export function arbDustAmount(): fc.Arbitrary<number> {
  return fc.integer({ min: 1, max: 100 });
}

/**
 * Generate a "whale" amount (large, 10%-100% of max).
 */
export function arbWhaleAmount(max: number = MAX_SUPPLY): fc.Arbitrary<number> {
  return fc.integer({ min: Math.floor(max * 0.1), max });
}

// ============================================================================
// Price Generators
// ============================================================================

/**
 * Generate a valid OkuM price (must be >= current price for monotonicity).
 *
 * @param currentPrice - Current price to ensure monotonicity
 * @param maxMultiplier - Maximum multiplier from current (default 10x)
 */
export function arbPrice(
  currentPrice: BN | bigint,
  maxMultiplier: number = 10
): fc.Arbitrary<BN> {
  const current = typeof currentPrice === "bigint" ? currentPrice : BigInt(currentPrice.toString());
  const max = current * BigInt(maxMultiplier);

  return fc.bigInt({ min: current, max }).map((n) => new BN(n.toString()));
}

/**
 * Generate a price increase percentage (0.01% to 5% per rebase).
 * Mirrors the EVM handler's rebase logic.
 * Uses noNaN to avoid NaN/Infinity values.
 */
export function arbPriceIncreasePercent(): fc.Arbitrary<number> {
  return fc.double({ min: 0.0001, max: 0.05, noNaN: true }); // 0.01% to 5%
}

/**
 * Generate a new price based on current price and increase percentage.
 */
export function arbNewPrice(currentPrice: BN): fc.Arbitrary<BN> {
  return arbPriceIncreasePercent().map((percent) => {
    const increase = currentPrice.muln(Math.floor(percent * 10000)).divn(10000);
    return currentPrice.add(increase);
  });
}

// ============================================================================
// Address Generators
// ============================================================================

/**
 * Generate a random valid Solana public key.
 */
export function arbPublicKey(): fc.Arbitrary<PublicKey> {
  return fc.uint8Array({ minLength: 32, maxLength: 32 }).map((bytes) => {
    // Ensure the bytes form a valid point on the curve
    // For testing purposes, we'll use Keypair.generate() which is always valid
    return Keypair.generate().publicKey;
  });
}

/**
 * Generate a random keypair.
 */
export function arbKeypair(): fc.Arbitrary<Keypair> {
  return fc.constant(null).map(() => Keypair.generate());
}

/**
 * Generate a pubkey from a set of known test actors.
 */
export function arbActor(actors: PublicKey[]): fc.Arbitrary<PublicKey> {
  return fc.integer({ min: 0, max: actors.length - 1 }).map((i) => actors[i]);
}

/**
 * Generate a keypair from a set of known test actors.
 */
export function arbActorKeypair(actors: Keypair[]): fc.Arbitrary<Keypair> {
  return fc.integer({ min: 0, max: actors.length - 1 }).map((i) => actors[i]);
}

// ============================================================================
// Chain ID Generators
// ============================================================================

/**
 * Known EVM chain IDs for bridge testing.
 */
export const KNOWN_CHAIN_IDS = {
  ETHEREUM: 1,
  BSC: 56,
  POLYGON: 137,
  ARBITRUM: 42161,
  OPTIMISM: 10,
  AVALANCHE: 43114,
  BASE: 8453,
};

/**
 * Generate a valid chain ID from known chains.
 */
export function arbChainId(): fc.Arbitrary<number> {
  const chainIds = Object.values(KNOWN_CHAIN_IDS);
  return fc.integer({ min: 0, max: chainIds.length - 1 }).map((i) => chainIds[i]);
}

/**
 * Generate any chain ID (including unknown ones for edge case testing).
 */
export function arbAnyChainId(): fc.Arbitrary<number> {
  return fc.integer({ min: 1, max: 100_000 });
}

// ============================================================================
// Time Generators
// ============================================================================

/**
 * Generate a valid future timestamp (for deadlines).
 */
export function arbFutureTimestamp(minSeconds: number = 60, maxSeconds: number = 86400): fc.Arbitrary<number> {
  const now = Math.floor(Date.now() / 1000);
  return fc.integer({ min: minSeconds, max: maxSeconds }).map((offset) => now + offset);
}

/**
 * Generate a past timestamp (for expired deadline testing).
 */
export function arbPastTimestamp(minSecondsAgo: number = 60, maxSecondsAgo: number = 86400): fc.Arbitrary<number> {
  const now = Math.floor(Date.now() / 1000);
  return fc.integer({ min: minSecondsAgo, max: maxSecondsAgo }).map((offset) => now - offset);
}

/**
 * Generate a slot number.
 */
export function arbSlot(currentSlot: number, maxAdvance: number = 1000): fc.Arbitrary<number> {
  return fc.integer({ min: currentSlot, max: currentSlot + maxAdvance });
}

// ============================================================================
// Ratio Generators
// ============================================================================

/**
 * Generate a collateralization ratio (0.5 to 2.0).
 */
export function arbCollateralRatio(min: number = 0.5, max: number = 2.0): fc.Arbitrary<number> {
  return fc.double({ min, max });
}

/**
 * Generate a fee in basis points (0 to 1000, i.e., 0% to 10%).
 */
export function arbFeeBps(max: number = 1000): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max });
}

// ============================================================================
// Composite Generators
// ============================================================================

/**
 * Generate a mint/burn pair where burn <= mint.
 * Useful for testing supply invariants.
 */
export function arbMintBurnPair(maxMint: number = MAX_SUPPLY / 100): fc.Arbitrary<{ mint: number; burn: number }> {
  return arbAmount(maxMint).chain((mint) =>
    fc.integer({ min: 0, max: mint }).map((burn) => ({ mint, burn }))
  );
}

/**
 * Generate a wrap/unwrap pair where unwrap is a percentage of wrap.
 */
export function arbWrapUnwrapPair(maxWrap: number = MAX_SUPPLY / 100): fc.Arbitrary<{ wrap: BN; unwrapPercent: number }> {
  return fc.tuple(arbAmountBN(maxWrap), fc.double({ min: 0, max: 1 })).map(([wrap, percent]) => ({
    wrap,
    unwrapPercent: percent,
  }));
}

/**
 * Generate bridge parameters.
 */
export function arbBridgeParams(): fc.Arbitrary<{
  amount: BN;
  destinationChainId: number;
  deadline: number;
}> {
  return fc.record({
    amount: arbAmountBN(MAX_SUPPLY / 100, 1000), // Min 1000 for fees
    destinationChainId: arbChainId(),
    deadline: arbFutureTimestamp(),
  });
}

// ============================================================================
// Operation Generators
// ============================================================================

/**
 * Operations that can be performed on the PSM.
 */
export type PsmOperation =
  | { type: "mint"; amount: BN }
  | { type: "redeem"; amount: BN }
  | { type: "setPrice"; newPrice: BN }
  | { type: "depositBuffer"; amount: BN }
  | { type: "withdrawBuffer"; amount: BN }
  | { type: "processQueue"; count: number };

/**
 * Generate a random PSM operation.
 */
export function arbPsmOperation(currentPrice: BN): fc.Arbitrary<PsmOperation> {
  return fc.oneof(
    arbAmountBN().map((amount) => ({ type: "mint" as const, amount })),
    arbAmountBN().map((amount) => ({ type: "redeem" as const, amount })),
    arbNewPrice(currentPrice).map((newPrice) => ({ type: "setPrice" as const, newPrice })),
    arbAmountBN().map((amount) => ({ type: "depositBuffer" as const, amount })),
    arbAmountBN().map((amount) => ({ type: "withdrawBuffer" as const, amount })),
    fc.integer({ min: 1, max: 10 }).map((count) => ({ type: "processQueue" as const, count }))
  );
}

/**
 * Operations that can be performed on the vault.
 */
export type VaultOperation =
  | { type: "wrap"; amount: BN }
  | { type: "unwrap"; shares: BN }
  | { type: "setMultiplier"; multiplier: BN }
  | { type: "depositReserves"; amount: BN }
  | { type: "withdrawReserves"; amount: BN };

/**
 * Generate a random vault operation.
 */
export function arbVaultOperation(currentMultiplier: BN): fc.Arbitrary<VaultOperation> {
  return fc.oneof(
    arbAmountBN().map((amount) => ({ type: "wrap" as const, amount })),
    arbAmountBN().map((shares) => ({ type: "unwrap" as const, shares })),
    arbPrice(currentMultiplier, 2).map((multiplier) => ({ type: "setMultiplier" as const, multiplier })),
    arbAmountBN().map((amount) => ({ type: "depositReserves" as const, amount })),
    arbAmountBN().map((amount) => ({ type: "withdrawReserves" as const, amount }))
  );
}

// ============================================================================
// Sequence Generators
// ============================================================================

/**
 * Generate a sequence of operations for invariant testing.
 */
export function arbOperationSequence<T>(
  opGenerator: fc.Arbitrary<T>,
  minLength: number = 10,
  maxLength: number = 100
): fc.Arbitrary<T[]> {
  return fc.array(opGenerator, { minLength, maxLength });
}

// ============================================================================
// Bound Helpers (Mirror Forge bound() function)
// ============================================================================

/**
 * Bound a value to a range (mirrors Forge's bound function).
 */
export function bound(value: number, min: number, max: number): number {
  if (min > max) {
    throw new Error(`Invalid bounds: min=${min} > max=${max}`);
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Bound a BN value to a range.
 */
export function boundBN(value: BN, min: BN, max: BN): BN {
  if (min.gt(max)) {
    throw new Error(`Invalid bounds: min=${min.toString()} > max=${max.toString()}`);
  }
  if (value.lt(min)) return min;
  if (value.gt(max)) return max;
  return value;
}
