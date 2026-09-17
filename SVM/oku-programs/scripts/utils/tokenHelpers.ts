/**
 * Token-2022 and SPL Token utilities
 */

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  TransactionSignature,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createInitializeMintInstruction,
  getMintLen,
} from "@solana/spl-token";
import { logger } from './logger';

/**
 * Send transaction with retry logic
 */
async function sendWithRetry(
  connection: Connection,
  transaction: Transaction,
  signers: Keypair[],
  maxRetries: number = 3,
  delayMs: number = 5000
): Promise<TransactionSignature> {
  let lastError: Error | null = null;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Get fresh blockhash for each attempt
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.lastValidBlockHeight = lastValidBlockHeight;
      
      return await sendAndConfirmTransaction(connection, transaction, signers, {
        commitment: 'confirmed',
      });
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries) {
        logger.warning(`Transaction failed (attempt ${attempt}/${maxRetries}), retrying in ${delayMs/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  throw lastError || new Error('Transaction failed after retries');
}

// NOTE: `createToken2022Mint` / `CreateToken2022Params` were removed here.
// They initialised an `InterestBearingConfig` extension and had no callers —
// the OkuM mint is created on-chain inside `initialize`, not by this helper.
// That extension is also mutually exclusive with `ScaledUiAmount`, which OkuM
// does use, so the code could never have applied to this protocol's mint
// (`SVM/DECISIONS.md` D-18).

export async function createSPLTokenMint(
  connection: Connection,
  payer: Keypair,
  decimals: number,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null = null
): Promise<PublicKey> {
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  // SPL Token mint size, derived via getMintLen([]) (no extensions).
  const mintLen = getMintLen([]);

  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const transaction = new Transaction().add(
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint,
      space: mintLen,
      lamports,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeMintInstruction(
      mint,
      decimals,
      mintAuthority,
      freezeAuthority,
      TOKEN_PROGRAM_ID
    )
  );

  await sendWithRetry(connection, transaction, [payer, mintKeypair]);

  logger.success(`Created SPL Token mint: ${mint.toBase58()}`);
  logger.info(`Decimals: ${decimals}`);
  logger.info(`Mint Authority: ${mintAuthority.toBase58()}`);
  logger.info(`Freeze Authority: ${freezeAuthority?.toBase58() || 'None'}`);

  return mint;
}


