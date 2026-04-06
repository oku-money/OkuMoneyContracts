/**
 * Shared Test Setup Module
 *
 * This module provides shared test infrastructure for PSM and Bridge tests:
 * - Shared authority keypairs (used across all test files)
 * - PSM initialization logic (executes once per test run)
 * - Helper functions for common test setup tasks
 *
 * WHY THIS EXISTS:
 * The PSM config PDA can only be initialized once. Multiple test files need
 * to interact with the same PSM instance using the same authority keypairs.
 * This module ensures:
 * 1. PSM is initialized exactly once
 * 2. All test files use the same authority keypairs
 * 3. No duplicate initialization attempts
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

// ============================================================================
// Shared Constants
// ============================================================================

export const MAX_SUPPLY = new BN(1_000_000_000_000); // 1M with 6 decimals
export const MINTER_ALLOWANCE = new BN(100_000_000_000); // 100k with 6 decimals
export const DECIMALS = 6;

// ============================================================================
// Airdrop Helpers
// ============================================================================

/**
 * Request an airdrop and wait for confirmation.
 * Uses confirmTransaction instead of setTimeout for reliability.
 */
export async function safeAirdrop(
  connection: anchor.web3.Connection,
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

/**
 * Airdrop SOL to multiple accounts and wait for all confirmations.
 */
export async function safeAirdropAll(
  connection: anchor.web3.Connection,
  accounts: Keypair[],
  lamports: number
): Promise<void> {
  // Send airdrops in batches of 5 to avoid overwhelming the validator
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

// ============================================================================
// Token Helpers
// ============================================================================

/**
 * Safe wrapper around mintTo that handles blockhash properly for Surfpool.
 * Uses sendAndConfirm with explicit blockhash fetching.
 */
export async function safeMintTo(
  connection: anchor.web3.Connection,
  payer: Keypair,
  mint: PublicKey,
  destination: PublicKey,
  authority: Keypair,
  amount: number | bigint,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): Promise<void> {
  const { createMintToInstruction } = await import("@solana/spl-token");
  
  const tx = new anchor.web3.Transaction().add(
    createMintToInstruction(
      mint,
      destination,
      authority.publicKey,
      amount,
      [],
      tokenProgramId
    )
  );
  
  const latestBlockhash = await connection.getLatestBlockhash();
  tx.recentBlockhash = latestBlockhash.blockhash;
  tx.feePayer = payer.publicKey;
  tx.sign(payer, authority);
  
  const sig = await connection.sendRawTransaction(tx.serialize());
  await connection.confirmTransaction({
    signature: sig,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  });
}

// ============================================================================
// ATA Helpers
// ============================================================================

/**
 * Ensure an Associated Token Account exists, creating it if needed.
 * Handles "already exists" errors gracefully.
 */
export async function ensureAta(
  connection: anchor.web3.Connection,
  payer: Keypair,
  ata: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): Promise<void> {
  try {
    await getAccount(connection, ata, undefined, tokenProgramId);
  } catch {
    const tx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        ata,
        owner,
        mint,
        tokenProgramId
      )
    );
    await new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {}).sendAndConfirm(tx, [payer]);
  }
}

// ============================================================================
// Shared Authority Keypairs
// ============================================================================
// IMPORTANT: These keypairs are generated once at module load and reused
// across all test files. This ensures all tests interact with the same
// PSM configuration and authorities.

/**
 * Cold multisig authority - High security operations
 * PSM roles: unpauser, unfreezer, bufferWithdrawer, oracleManager, capManager, allowanceManager
 */
export const coldMultisig = Keypair.generate();

/**
 * Warm multisig authority - Medium security operations
 * PSM roles: pauser, freezer
 */
export const warmMultisig = Keypair.generate();

/**
 * PSM orchestrator - Automated operations
 * PSM roles: queueProcessor, bufferDepositor, rebaser
 */
export const psmOrchestrator = Keypair.generate();

/**
 * Bridge orchestrator - Bridge signature authority
 * Bridge role: signature authority for burn/mint operations
 * NOTE: This is separate from psmOrchestrator to maintain clear role separation
 */
export const bridgeOrchestrator = Keypair.generate();

// ============================================================================
// Initialization State
// ============================================================================

let psmConfigPda: PublicKey | null = null;
let redemptionQueuePda: PublicKey | null = null;
let vaultUsdcAta: PublicKey | null = null;
let vaultOkuMoneyAta: PublicKey | null = null;
let psmInitialized = false;

export interface PSMSetupResult {
  configPda: PublicKey;
  redemptionQueuePda: PublicKey;
  vaultUsdcAta: PublicKey;
  vaultOkuMoneyAta: PublicKey;
}

// ============================================================================
// PSM Initialization
// ============================================================================

/**
 * Initialize PSM if not already initialized, or return existing setup.
 *
 * This function ensures PSM is initialized exactly once across all test files.
 * On first call:
 * - Derives PSM PDAs
 * - Checks if PSM is already initialized on-chain
 * - If not, initializes PSM with shared authorities
 * - Airdrops SOL to shared authorities
 * - Sets up OkuUSD escrow vault
 *
 * On subsequent calls:
 * - Returns cached PDAs immediately (no on-chain calls)
 *
 * @param program - Anchor program instance
 * @param provider - Anchor provider instance
 * @param payer - Keypair that pays for initialization
 * @param usdcMint - USDC mint address
 * @param okusdMint - OkuUSD mint address
 * @returns PSM setup result with all PDAs
 */
export async function initializePSMIfNeeded(
  program: Program,
  provider: anchor.AnchorProvider,
  payer: Keypair,
  usdcMint: PublicKey,
  okuMoneyMint: PublicKey
): Promise<PSMSetupResult> {
  // Return cached if already initialized
  if (psmInitialized && psmConfigPda && redemptionQueuePda && vaultUsdcAta && vaultOkuMoneyAta) {
    return {
      configPda: psmConfigPda,
      redemptionQueuePda,
      vaultUsdcAta,
      vaultOkuMoneyAta,
    };
  }

  // Derive PDAs
  [psmConfigPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("psm_config")],
    program.programId
  );

  [redemptionQueuePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("redemption_queue")],
    program.programId
  );

  // Derive vault ATAs
  vaultUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    psmConfigPda,
    true,
    TOKEN_PROGRAM_ID
  );

  vaultOkuMoneyAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    psmConfigPda,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  // Check if already initialized on-chain
  try {
    await program.account.psmConfig.fetch(psmConfigPda);
    psmInitialized = true;
    return {
      configPda: psmConfigPda,
      redemptionQueuePda,
      vaultUsdcAta,
      vaultOkuMoneyAta,
    };
  } catch {
    // Not initialized yet, proceed with initialization
  }

  // Airdrop SOL to shared authorities with proper confirmation
  await safeAirdropAll(
    provider.connection,
    [coldMultisig, warmMultisig, psmOrchestrator],
    10 * anchor.web3.LAMPORTS_PER_SOL
  );

  // Initialize PSM with granular authorities (authority pubkeys passed as instruction args)
  await program.methods
    .initialize(
      MAX_SUPPLY,
      MINTER_ALLOWANCE,
      warmMultisig.publicKey,       // pauser
      coldMultisig.publicKey,       // unpauser
      warmMultisig.publicKey,       // freezer
      coldMultisig.publicKey,       // unfreezer
      psmOrchestrator.publicKey,    // queueProcessor
      psmOrchestrator.publicKey,    // bufferDepositor
      coldMultisig.publicKey,       // bufferWithdrawer
      coldMultisig.publicKey,       // oracleManager
      coldMultisig.publicKey,       // capManager
      coldMultisig.publicKey,       // allowanceManager
      psmOrchestrator.publicKey,    // rebaser
    )
    .accountsPartial({
      roleAdmin: payer.publicKey,
      config: psmConfigPda,
      usdcMint: usdcMint,
      okuMoneyMint: okuMoneyMint,
      vaultUsdc: vaultUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .rpc();

  // Setup redemption queue (separate instruction after initialize)
  await program.methods
    .setupRedemptionQueue()
    .accountsPartial({
      payer: payer.publicKey,
      config: psmConfigPda,
      redemptionQueue: redemptionQueuePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  // Setup OkuMoney escrow vault
  await program.methods
    .setupOkuMoneyEscrow()
    .accountsPartial({
      roleAdmin: payer.publicKey,
      config: psmConfigPda,
      okuMoneyMint: okuMoneyMint,
      vaultOkuMoney: vaultOkuMoneyAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  psmInitialized = true;

  return {
    configPda: psmConfigPda,
    redemptionQueuePda,
    vaultUsdcAta,
    vaultOkuMoneyAta,
  };
}

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Mint OkuMoney to a user via the PSM program's mintOkuM instruction.
 *
 * Prerequisite: user must have a funded USDC ATA and an OkuMoney ATA must exist.
 * This handles the standard mint call with priceUpdate: null (oracle disabled).
 */
export async function mintOkuMoneyViaProgram(
  program: Program,
  user: Keypair,
  amount: BN,
  configPda: PublicKey,
  usdcMint: PublicKey,
  okuMoneyMint: PublicKey,
  userUsdcAta: PublicKey,
  userOkuMoneyAta: PublicKey,
  vaultUsdcAta: PublicKey,
): Promise<void> {
  await program.methods
    .mintOkuM(amount)
    .accountsPartial({
      user: user.publicKey,
      config: configPda,
      usdcMint,
      okuMoneyMint,
      userUsdcAta,
      userOkuMoneyAta,
      vaultUsdc: vaultUsdcAta,
      priceUpdate: null,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([user])
    .rpc();
}

// Backwards compatibility alias
export const mintOkusdViaProgram = mintOkuMoneyViaProgram;

/**
 * Ensure PSM is unpaused before tests.
 *
 * Call this in beforeEach hooks to guarantee PSM is in unpaused state.
 * If PSM is paused, unpauses it using coldMultisig authority.
 *
 * @param program - Anchor program instance
 * @param configPda - PSM config PDA
 */
export async function ensurePSMUnpaused(
  program: Program,
  configPda: PublicKey
): Promise<void> {
  const config = await program.account.psmConfig.fetch(configPda);
  if (config.isPaused) {
    await program.methods
      .unpause()
      .accountsPartial({
        unpauser: coldMultisig.publicKey,
        config: configPda,
      })
      .signers([coldMultisig])
      .rpc();
  }
}
