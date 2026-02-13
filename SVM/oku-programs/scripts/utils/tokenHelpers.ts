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

  await sendAndConfirmTransaction(connection, transaction, [payer, mintKeypair]);

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

  await sendAndConfirmTransaction(connection, transaction, [payer, mintKeypair]);

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

    await sendAndConfirmTransaction(connection, transaction, [payer]);

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
