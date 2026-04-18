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
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeInterestBearingMintInstruction,
  getMintLen,
  ExtensionType,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
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

export interface CreateToken2022Params {
  connection: Connection;
  payer: Keypair;
  decimals: number;
  mintAuthority: PublicKey;
  freezeAuthority: PublicKey | null;
  rateAuthority: PublicKey;
  initialRate: number; // In basis points
}

/**
 * Create Token-2022 mint with Interest-Bearing extension
 */
export async function createToken2022Mint(
  params: CreateToken2022Params
): Promise<PublicKey> {
  const {
    connection,
    payer,
    decimals,
    mintAuthority,
    freezeAuthority,
    rateAuthority,
    initialRate,
  } = params;

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  // Calculate space needed for mint with extensions
  const extensions = [ExtensionType.InterestBearingConfig];
  const mintLen = getMintLen(extensions);

  // Calculate minimum lamports for rent exemption
  const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);

  const transaction = new Transaction().add(
    // Create account
    SystemProgram.createAccount({
      fromPubkey: payer.publicKey,
      newAccountPubkey: mint,
      space: mintLen,
      lamports,
      programId: TOKEN_2022_PROGRAM_ID,
    }),
    // Initialize interest-bearing extension
    createInitializeInterestBearingMintInstruction(
      mint,
      rateAuthority,
      initialRate,
      TOKEN_2022_PROGRAM_ID
    ),
    // Initialize mint
    createInitializeMintInstruction(
      mint,
      decimals,
      mintAuthority,
      freezeAuthority,
      TOKEN_2022_PROGRAM_ID
    )
  );

  await sendWithRetry(connection, transaction, [payer, mintKeypair]);

  logger.success(`Created Token-2022 mint: ${mint.toBase58()}`);
  logger.info(`Decimals: ${decimals}`);
  logger.info(`Mint Authority: ${mintAuthority.toBase58()}`);
  logger.info(`Freeze Authority: ${freezeAuthority?.toBase58() || 'None'}`);
  logger.info(`Rate Authority: ${rateAuthority.toBase58()}`);
  logger.info(`Initial Rate: ${initialRate} bps`);

  return mint;
}

/**
 * Create standard SPL Token mint
 */
export async function createSPLTokenMint(
  connection: Connection,
  payer: Keypair,
  decimals: number,
  mintAuthority: PublicKey,
  freezeAuthority: PublicKey | null = null
): Promise<PublicKey> {
  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  const mintLen = 82; // Standard mint account size

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

/**
 * Get or create associated token account
 */
export async function getOrCreateATA(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey,
  programId: PublicKey = TOKEN_PROGRAM_ID
): Promise<PublicKey> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true, programId);

  const accountInfo = await connection.getAccountInfo(ata);

  if (!accountInfo) {
    logger.info(`Creating ATA for ${owner.toBase58()}`);

    const transaction = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        mint,
        programId,
        ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );

    await sendWithRetry(connection, transaction, [payer]);

    logger.success(`Created ATA: ${ata.toBase58()}`);
  }

  return ata;
}

/**
 * Airdrop tokens (for testing on localnet)
 */
export async function airdropTokens(
  connection: Connection,
  payer: Keypair,
  mint: PublicKey,
  recipient: PublicKey,
  amount: bigint,
  programId: PublicKey = TOKEN_PROGRAM_ID
): Promise<void> {
  // This would require mint authority - implementation depends on test setup
  // For now, this is a placeholder
  logger.info(`Airdrop ${amount} tokens to ${recipient.toBase58()}`);
}
