/**
 * Validator-mode airdrop helper.
 *
 * Used only by the surfpool fork tests (`tests/fork/*.ts`). Surfpool
 * exposes a real-validator RPC, so `connection.requestAirdrop` works
 * normally; the bankrun unit suite has no use for this.
 *
 * Lives here (not in `tests/shared/`) so the bankrun-default test
 * surface stays clean. See `tests/shared/setup.ts` header for the
 * Phase 11 rationale.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";

/** Request an airdrop and wait for confirmation. */
export async function safeAirdrop(
  connection: Connection,
  pubkey: PublicKey,
  lamports: number
): Promise<void> {
  const sig = await connection.requestAirdrop(pubkey, lamports);
  const latestBlockhash = await connection.getLatestBlockhash();
  await connection.confirmTransaction({
    signature: sig,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });
}

/** Airdrop SOL to multiple accounts in batches of 5. */
export async function safeAirdropAll(
  connection: Connection,
  accounts: Keypair[],
  lamports: number
): Promise<void> {
  for (let i = 0; i < accounts.length; i += 5) {
    const batch = accounts.slice(i, i + 5);
    const latestBlockhash = await connection.getLatestBlockhash();
    const sigs = await Promise.all(
      batch.map((kp) => connection.requestAirdrop(kp.publicKey, lamports))
    );
    await Promise.all(
      sigs.map((sig) =>
        connection.confirmTransaction({
          signature: sig,
          blockhash: latestBlockhash.blockhash,
          lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
        })
      )
    );
  }
}
