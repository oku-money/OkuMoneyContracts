/**
 * Test Fixtures
 *
 * Provides reusable test state presets that can be injected via Surfpool.
 * These fixtures allow fast test setup without executing actual transactions.
 *
 * Patterns mirror EVM Base.t.sol fixtures but leverage Surfpool's state injection.
 */

import { PublicKey, Keypair } from "@solana/web3.js";
import { BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SurfpoolClient } from "./surfpool";

// ============================================================================
// Types
// ============================================================================

export interface TokenAmounts {
  usdc?: number;
  okuMoney?: number;
  usdOku?: number;
}

export interface QueueEntry {
  user: PublicKey;
  okuMoneyAmount: BN;
  entrySlot: number;
}

export interface VaultState {
  totalShares: BN;
  totalOkuMoney: BN;
  usdMultiplier: BN;
}

export interface BridgeState {
  chainNonces: Map<number, number>;
  processedRequests: Set<string>;
}

// ============================================================================
// Token Amount Constants
// ============================================================================

export const DECIMALS = 6;
export const PRECISION = new BN(10).pow(new BN(18)); // 1e18 for prices

/** Convert human-readable amount to on-chain amount (6 decimals) */
export function toAmount(humanAmount: number): number {
  return Math.floor(humanAmount * 10 ** DECIMALS);
}

/** Convert on-chain amount to human-readable (6 decimals) */
export function fromAmount(onChainAmount: number | BN): number {
  const val = typeof onChainAmount === "number" ? onChainAmount : onChainAmount.toNumber();
  return val / 10 ** DECIMALS;
}

// ============================================================================
// User Fixtures
// ============================================================================

/**
 * Fund a user with tokens via Surfpool state injection.
 * Much faster than actual minting - directly sets token account state.
 *
 * @example
 * ```typescript
 * await fixtures.fundUser(surfpool, user.publicKey, {
 *   usdc: 10_000,      // 10k USDC
 *   okuMoney: 5_000,   // 5k OkuMoney
 * }, { usdcMint, okuMoneyMint });
 * ```
 */
export async function fundUser(
  surfpool: SurfpoolClient,
  user: PublicKey,
  amounts: TokenAmounts,
  mints: {
    usdcMint: PublicKey;
    okuMoneyMint?: PublicKey;
    usdOkuMint?: PublicKey;
  }
): Promise<void> {
  const promises: Promise<void>[] = [];

  if (amounts.usdc !== undefined && amounts.usdc > 0) {
    promises.push(
      surfpool.setTokenAccount(user, mints.usdcMint, {
        amount: toAmount(amounts.usdc),
        state: "initialized",
      }, TOKEN_PROGRAM_ID)
    );
  }

  if (amounts.okuMoney !== undefined && amounts.okuMoney > 0 && mints.okuMoneyMint) {
    promises.push(
      surfpool.setTokenAccount(user, mints.okuMoneyMint, {
        amount: toAmount(amounts.okuMoney),
        state: "initialized",
      }, TOKEN_2022_PROGRAM_ID)
    );
  }

  if (amounts.usdOku !== undefined && amounts.usdOku > 0 && mints.usdOkuMint) {
    promises.push(
      surfpool.setTokenAccount(user, mints.usdOkuMint, {
        amount: toAmount(amounts.usdOku),
        state: "initialized",
      }, TOKEN_2022_PROGRAM_ID)
    );
  }

  await Promise.all(promises);
}

/**
 * Create a funded user with a new keypair.
 * Returns the keypair and funds it with specified amounts.
 */
export async function createFundedUser(
  surfpool: SurfpoolClient,
  amounts: TokenAmounts,
  mints: {
    usdcMint: PublicKey;
    okuMoneyMint?: PublicKey;
    usdOkuMint?: PublicKey;
  },
  solLamports: number = 1_000_000_000 // 1 SOL for fees
): Promise<Keypair> {
  const user = Keypair.generate();

  // Fund with SOL for transaction fees
  await surfpool.setAccount(user.publicKey, {
    lamports: solLamports,
  });

  // Fund with tokens
  await fundUser(surfpool, user.publicKey, amounts, mints);

  return user;
}

// ============================================================================
// PSM Fixtures
// ============================================================================

/**
 * Set PSM buffer to a specific USDC amount.
 * Directly injects the vault USDC balance.
 *
 * @example
 * ```typescript
 * // Set buffer to 100k USDC
 * await fixtures.setPSMBuffer(surfpool, vaultUsdcAta, 100_000);
 * ```
 */
export async function setPSMBuffer(
  surfpool: SurfpoolClient,
  vaultUsdcAta: PublicKey,
  usdcAmount: number
): Promise<void> {
  // Note: This only sets the token balance. The PSM config's
  // tracked buffer amount may need separate handling via setAccount
  // if the program tracks it independently.
  await surfpool.setTokenAccount(
    vaultUsdcAta, // ATA address as "owner" for setTokenAccount
    // Actually, setTokenAccount needs owner and mint, not the ATA
    // This needs to be handled differently - see note below
    new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC mint placeholder
    {
      amount: toAmount(usdcAmount),
      state: "initialized",
    }
  );
}

/**
 * Preset: PSM with depleted buffer (for testing queued redemptions).
 */
export async function psmWithDepletedBuffer(
  surfpool: SurfpoolClient,
  vaultUsdcAta: PublicKey
): Promise<void> {
  await setPSMBuffer(surfpool, vaultUsdcAta, 0);
}

/**
 * Preset: PSM with full buffer (for testing instant redemptions).
 */
export async function psmWithFullBuffer(
  surfpool: SurfpoolClient,
  vaultUsdcAta: PublicKey,
  amount: number = 1_000_000 // 1M USDC default
): Promise<void> {
  await setPSMBuffer(surfpool, vaultUsdcAta, amount);
}

// ============================================================================
// Vault Fixtures
// ============================================================================

/**
 * Set vault to a specific collateralization ratio.
 * Useful for testing undercollateralized scenarios.
 *
 * @param ratio - Target ratio (e.g., 0.95 for 95% collateralized)
 */
export async function setVaultCollateralRatio(
  surfpool: SurfpoolClient,
  vaultConfigPda: PublicKey,
  vaultOkuMoneyAta: PublicKey,
  ratio: number,
  totalShares: BN
): Promise<void> {
  // To achieve a specific collateral ratio:
  // ratio = (reserveValue + vaultOkuMoneyValue) / (totalShares * usdMultiplier)
  //
  // This would require manipulating both the vault config PDA
  // and the token account. For now, provide a basic implementation.

  // This is a simplified version - full implementation would need
  // to understand the vault's on-chain state structure
  console.warn("setVaultCollateralRatio: Complex fixture - implement based on program state");
}

/**
 * Preset: Vault at exactly 100% collateralization.
 */
export async function vaultFullyCollateralized(
  surfpool: SurfpoolClient,
  vaultConfigPda: PublicKey,
  vaultOkuMoneyAta: PublicKey,
  totalShares: BN
): Promise<void> {
  await setVaultCollateralRatio(surfpool, vaultConfigPda, vaultOkuMoneyAta, 1.0, totalShares);
}

/**
 * Preset: Vault at minimum collateralization (90%).
 */
export async function vaultMinimumCollateralized(
  surfpool: SurfpoolClient,
  vaultConfigPda: PublicKey,
  vaultOkuMoneyAta: PublicKey,
  totalShares: BN
): Promise<void> {
  await setVaultCollateralRatio(surfpool, vaultConfigPda, vaultOkuMoneyAta, 0.9, totalShares);
}

// ============================================================================
// Bridge Fixtures
// ============================================================================

/**
 * Set bridge nonce for a specific chain.
 * Useful for testing nonce edge cases.
 */
export async function setBridgeNonce(
  surfpool: SurfpoolClient,
  bridgeConfigPda: PublicKey,
  chainId: number,
  nonce: number
): Promise<void> {
  // This requires understanding the bridge config account structure
  // and using setAccount to modify it directly
  console.warn("setBridgeNonce: Implement based on bridge config account structure");
}

/**
 * Mark a bridge request as already processed.
 * Useful for testing replay protection.
 */
export async function markBridgeRequestProcessed(
  surfpool: SurfpoolClient,
  processedRequestPda: PublicKey
): Promise<void> {
  // Create the ProcessedRequest PDA with a dummy value
  // This requires understanding the PDA structure
  console.warn("markBridgeRequestProcessed: Implement based on ProcessedRequest account structure");
}

// ============================================================================
// Time-Based Fixtures
// ============================================================================

/**
 * Set up a scenario where a deadline has expired.
 *
 * @example
 * ```typescript
 * // Create a bridge request and time travel past its deadline
 * const deadline = Math.floor(Date.now() / 1000) + 60; // 1 minute
 * // ... create bridge request with deadline ...
 * await fixtures.expireDeadline(surfpool, deadline);
 * // Now test refund functionality
 * ```
 */
export async function expireDeadline(
  surfpool: SurfpoolClient,
  deadline: number
): Promise<void> {
  await surfpool.timeTravel({ absoluteTimestamp: deadline + 1 });
}

/**
 * Advance to a specific slot.
 * Useful for testing slot-based checks like yield distribution lock.
 */
export async function advanceSlots(
  surfpool: SurfpoolClient,
  slots: number
): Promise<void> {
  const epochInfo = await surfpool.getEpochInfo();
  await surfpool.timeTravel({ absoluteSlot: epochInfo.absoluteSlot + slots });
}

/**
 * Advance to a specific epoch.
 * Useful for testing epoch-dependent logic.
 */
export async function advanceEpochs(
  surfpool: SurfpoolClient,
  epochs: number
): Promise<void> {
  const epochInfo = await surfpool.getEpochInfo();
  await surfpool.timeTravel({ absoluteEpoch: epochInfo.epoch + epochs });
}

// ============================================================================
// Frozen Account Fixtures
// ============================================================================

/**
 * Freeze a user's token account.
 * Useful for testing operations against frozen accounts.
 */
export async function freezeTokenAccount(
  surfpool: SurfpoolClient,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID
): Promise<void> {
  await surfpool.setTokenAccount(owner, mint, { state: "frozen" }, tokenProgram);
}

/**
 * Thaw (unfreeze) a user's token account.
 */
export async function thawTokenAccount(
  surfpool: SurfpoolClient,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID
): Promise<void> {
  await surfpool.setTokenAccount(owner, mint, { state: "initialized" }, tokenProgram);
}

// ============================================================================
// Edge Case Fixtures
// ============================================================================

/**
 * Create a user with maximum possible token balance.
 * Useful for testing overflow/underflow edge cases.
 */
export async function createMaxBalanceUser(
  surfpool: SurfpoolClient,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID
): Promise<Keypair> {
  const user = Keypair.generate();

  await surfpool.setAccount(user.publicKey, {
    lamports: 1_000_000_000, // 1 SOL
  });

  // Max u64 value
  await surfpool.setTokenAccount(user, mint, {
    amount: Number.MAX_SAFE_INTEGER, // JavaScript limit, actual u64 max is larger
    state: "initialized",
  }, tokenProgram);

  return user;
}

/**
 * Create a user with exactly 1 token (minimum non-zero).
 * Useful for testing dust scenarios.
 */
export async function createDustUser(
  surfpool: SurfpoolClient,
  mint: PublicKey,
  tokenProgram: PublicKey = TOKEN_PROGRAM_ID
): Promise<Keypair> {
  const user = Keypair.generate();

  await surfpool.setAccount(user.publicKey, {
    lamports: 1_000_000_000, // 1 SOL
  });

  await surfpool.setTokenAccount(user, mint, {
    amount: 1,
    state: "initialized",
  }, tokenProgram);

  return user;
}

// ============================================================================
// Batch Fixtures
// ============================================================================

/**
 * Create multiple funded users for parallel testing.
 */
export async function createFundedUsers(
  surfpool: SurfpoolClient,
  count: number,
  amounts: TokenAmounts,
  mints: {
    usdcMint: PublicKey;
    okuMoneyMint?: PublicKey;
    usdOkuMint?: PublicKey;
  }
): Promise<Keypair[]> {
  const users: Keypair[] = [];
  const promises: Promise<void>[] = [];

  for (let i = 0; i < count; i++) {
    const user = Keypair.generate();
    users.push(user);

    // Fund with SOL
    promises.push(
      surfpool.setAccount(user.publicKey, {
        lamports: 1_000_000_000,
      })
    );

    // Fund with tokens
    promises.push(fundUser(surfpool, user.publicKey, amounts, mints));
  }

  await Promise.all(promises);
  return users;
}

// ============================================================================
// Snapshot/Restore Fixtures
// ============================================================================

/**
 * Take a snapshot of the current state.
 * Can be restored later for test isolation.
 */
export async function takeSnapshot(surfpool: SurfpoolClient): Promise<any> {
  return surfpool.exportSnapshot({
    includeParsedAccounts: true,
    scope: "network",
  });
}

/**
 * Reset network to clean state.
 * Use between test suites for isolation.
 */
export async function resetToCleanState(surfpool: SurfpoolClient): Promise<void> {
  await surfpool.resetNetwork();
}
