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
  TOKEN_2022_PROGRAM_ID,
  createInitializeMintInstruction,
  createInitializeScaledUiAmountConfigInstruction,
  createInitializeInterestBearingMintInstruction,
  getMintLen,
  ExtensionType,
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

export interface CreateToken2022Params {
  connection: Connection;
  payer: Keypair;
  decimals: number;
  mintAuthority: PublicKey;
  freezeAuthority: PublicKey | null;
  /** ScaledUiAmountConfig authority (PsmConfig PDA) */
  scaledUiAmountAuthority: PublicKey;
  /** Initial multiplier for ScaledUiAmountConfig (1.0 = $1.00) */
  initialMultiplier: number;
}

/**
 * Create Token-2022 mint with ScaledUiAmountConfig extension.
 *
 * OkuMoney uses ScaledUiAmountConfig as the AUTHORITATIVE source of
 * oku_m_price. The multiplier is a flat f64 scalar updated discretely
 * by the rebaser (rear-facing, realized yield). The PsmConfig PDA is
 * the ScaledUiAmount authority; yield ops write via CPI.
 *
 * f64 precision is proven lossless for multiplier values up to
 * MAX_OKU_M_PRICE = 1e15 (2.25x margin below 2^51).
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
    scaledUiAmountAuthority,
    initialMultiplier,
  } = params;

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;

  // Calculate space needed for mint with ScaledUiAmountConfig extension
  const extensions = [ExtensionType.ScaledUiAmountConfig];
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
    // Initialize ScaledUiAmountConfig extension
    createInitializeScaledUiAmountConfigInstruction(
      mint,
      scaledUiAmountAuthority,
      initialMultiplier,
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
  logger.info(`ScaledUiAmount Authority: ${scaledUiAmountAuthority.toBase58()}`);
  logger.info(`Initial Multiplier: ${initialMultiplier}`);

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

  // Legacy SPL Token mint size; derived via getMintLen([]) (no extensions).
  // Was previously hardcoded to 82.
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

export interface CreateUsdOkuMintParams {
  connection: Connection;
  payer: Keypair;
  decimals: number;
  mintAuthority: PublicKey;
  freezeAuthority: PublicKey | null;
  /** InterestBearingConfig rate authority (OkuDollarConfig PDA) */
  rateAuthority: PublicKey;
  /** Initial interest rate in basis points (0 = no yield until set) */
  initialRate: number;
}

/**
 * Create Token-2022 mint with InterestBearingConfig extension for usdOku.
 *
 * usdOku uses InterestBearingConfig for forward-facing continuous yield
 * display in wallets. The rate is set in whole basis points (i16) for
 * cross-chain parity with EVM's usdRatePerSecond. The on-chain
 * `usd_multiplier` in OkuDollarConfig remains authoritative for
 * share/vault math; the extension is informational.
 *
 * The rate must correspond to a whole-basis-point APY to maintain
 * cross-chain parity with SVM's InterestBearingConfig (i16 basis points).
 */
export async function createUsdOkuMint(
  params: CreateUsdOkuMintParams
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

  // Calculate space needed for mint with InterestBearingConfig extension
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
    // Initialize InterestBearingConfig extension
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

  logger.success(`Created usdOku Token-2022 mint: ${mint.toBase58()}`);
  logger.info(`Decimals: ${decimals}`);
  logger.info(`Mint Authority: ${mintAuthority.toBase58()}`);
  logger.info(`Freeze Authority: ${freezeAuthority?.toBase58() || 'None'}`);
  logger.info(`Rate Authority: ${rateAuthority.toBase58()}`);
  logger.info(`Initial Rate: ${initialRate} bps`);

  return mint;
}

