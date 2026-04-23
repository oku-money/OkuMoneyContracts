/**
 * Test fixtures
 *
 * Reusable test state helpers that use Surfpool cheatcodes for fast setup
 * without executing actual on-chain transactions.
 */

import { PublicKey, Keypair } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { SurfpoolClient } from "./surfpool";

// ============================================================================
// Token amount helpers
// ============================================================================

export const DECIMALS = 6;

export interface TokenAmounts {
  usdc?: number;
  okuMoney?: number;
  usdOku?: number;
}

/** Convert human-readable amount to on-chain amount (6 decimals) */
export function toAmount(humanAmount: number): number {
  return Math.floor(humanAmount * 10 ** DECIMALS);
}

/** Convert on-chain amount to human-readable (6 decimals) */
export function fromAmount(onChainAmount: number | bigint): number {
  const val = typeof onChainAmount === "bigint" ? Number(onChainAmount) : onChainAmount;
  return val / 10 ** DECIMALS;
}

// ============================================================================
// User funding
// ============================================================================

/**
 * Fund a user's token accounts via Surfpool state injection.
 * Much faster than actual minting — directly sets token account state.
 *
 * @example
 * ```typescript
 * await fundUser(surfpool, user.publicKey, { usdc: 10_000 }, { usdcMint });
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
      surfpool.setTokenAccount(
        user,
        mints.usdcMint,
        { amount: toAmount(amounts.usdc), state: "initialized" },
        TOKEN_PROGRAM_ID
      )
    );
  }

  if (amounts.okuMoney !== undefined && amounts.okuMoney > 0 && mints.okuMoneyMint) {
    promises.push(
      surfpool.setTokenAccount(
        user,
        mints.okuMoneyMint,
        { amount: toAmount(amounts.okuMoney), state: "initialized" },
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  if (amounts.usdOku !== undefined && amounts.usdOku > 0 && mints.usdOkuMint) {
    promises.push(
      surfpool.setTokenAccount(
        user,
        mints.usdOkuMint,
        { amount: toAmount(amounts.usdOku), state: "initialized" },
        TOKEN_2022_PROGRAM_ID
      )
    );
  }

  await Promise.all(promises);
}

// ============================================================================
// Time-based fixtures
// ============================================================================

/**
 * Time-travel past a deadline so it appears expired.
 *
 * @example
 * ```typescript
 * const deadline = Math.floor(Date.now() / 1000) + 60;
 * // ... create bridge request with deadline ...
 * await expireDeadline(surfpool, deadline);
 * // Now test refund functionality
 * ```
 */
export async function expireDeadline(
  surfpool: SurfpoolClient,
  deadline: number
): Promise<void> {
  await surfpool.timeTravel({ absoluteTimestamp: deadline + 1 });
}

// ============================================================================
// Frozen account fixtures
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
