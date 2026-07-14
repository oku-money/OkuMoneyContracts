/**
 * Shared PSM test setup — bankrun-only.
 *
 * Module-level keypairs (`coldMultisig`, `warmMultisig`, `psmOrchestrator`)
 * are generated once at module load and reused across the entire mocha
 * process. They are deterministic per-process but freshly generated per-
 * process boot, so each test run starts with pristine authorities.
 *
 * `initializePsm` runs the PSM `initialize` + `setup_redemption_queue` +
 * `setup_usd_oku_escrow` instructions against the supplied program.
 * No memoization, no singleton, no cross-file cache — every bankrun
 * cluster is fresh and the on-chain PsmConfig must always be created
 * by the calling describe's `before()` hook.
 *
 * The `initialize` instruction now creates the usdOku mint itself with
 * Token-2022 ScaledUiAmount + MetadataPointer + TokenMetadata extensions.
 * Callers pass a fresh keypair for the mint; no pre-creation is needed.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  PublicKey,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import type { BankrunHarness } from "./bankrun";
import { fundKeypairs } from "./bankrun";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_SUPPLY = new BN(1_000_000_000_000); // 1M with 6 decimals
export const MINTER_ALLOWANCE = new BN(100_000_000_000); // 100k with 6 decimals
export const DECIMALS = 6;

// ---------------------------------------------------------------------------
// Shared authority keypairs
// ---------------------------------------------------------------------------
//
// Generated once at module load — the same JS object is shared across all
// describe blocks that import this module. Each bankrun cluster is fresh,
// but the pubkeys remain stable within a single mocha process.

/**
 * Cold multisig authority — high-security operations.
 * PSM roles: unpauser, unfreezer, bufferWithdrawer,
 * capManager, allowanceManager.
 */
export const coldMultisig = Keypair.generate();

/** Warm multisig authority — medium-security operations. PSM roles:
 *  pauser, freezer. */
export const warmMultisig = Keypair.generate();

/** PSM orchestrator — automated operations. PSM roles: queueProcessor,
 *  bufferDepositor, rebaser. In v1 noBridge this same key also drives
 *  cross-chain transfers off-chain by calling `mint_usd_oku` /
 *  `redeem_usd_oku` on each side. */
export const psmOrchestrator = Keypair.generate();

// ---------------------------------------------------------------------------
// PSM initialization
// ---------------------------------------------------------------------------

export interface PsmSetupResult {
  configPda: PublicKey;
  redemptionQueuePda: PublicKey;
  usdOkuMint: PublicKey;
  vaultUsdcAta: PublicKey;
  vaultUsdOkuAta: PublicKey;
}

/**
 * Initialize the PSM end-to-end on the supplied bankrun harness.
 *
 * Steps performed (no caching — every call runs all three on-chain
 * instructions):
 *   1. fund the shared authority keypairs via `fundKeypairs(h, ...)`
 *   2. `initialize(...)` — creates PsmConfig + USDC vault + usdOku mint
 *      (the program creates the Token-2022 mint with ScaledUiAmount +
 *      MetadataPointer + TokenMetadata extensions)
 *   3. `setupRedemptionQueue()`
 *   4. `setupUsdOkuEscrow()` — creates the usdOku escrow ATA
 *
 * Authority roles use the same keypair-per-role mapping as the deploy
 * config: cold for high-security, warm for medium, psmOrchestrator for
 * automated.
 */
export async function initializePsm(
  h: BankrunHarness,
  program: Program,
  payer: Keypair,
  usdcMint: PublicKey
): Promise<PsmSetupResult> {
  // Generate a fresh keypair for the usdOku mint — the program's
  // `initialize` instruction creates it with Token-2022 extensions.
  const usdOkuMintKeypair = Keypair.generate();
  const usdOkuMint = usdOkuMintKeypair.publicKey;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("psm_config_v5")],
    program.programId
  );
  const [redemptionQueuePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("redemption_queue_v3")],
    program.programId
  );
  const vaultUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    configPda,
    true,
    TOKEN_PROGRAM_ID
  );
  const vaultUsdOkuAta = getAssociatedTokenAddressSync(
    usdOkuMint,
    configPda,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  // Fund the shared authorities so they can pay rent / fees when they
  // appear as signers in subsequent admin txs.
  await fundKeypairs(
    h,
    [coldMultisig, warmMultisig, psmOrchestrator],
    10 * anchor.web3.LAMPORTS_PER_SOL
  );

  // `initialize` takes an `InitializeParams` struct and a `usdOkuMint`
  // signer keypair. The program creates the mint with extensions via CPI.
  await program.methods
    .initialize({
      maxSupply: MAX_SUPPLY,
      minterAllowance: MINTER_ALLOWANCE,
      pauser: warmMultisig.publicKey,
      unpauser: coldMultisig.publicKey,
      freezer: warmMultisig.publicKey,
      unfreezer: coldMultisig.publicKey,
      queueProcessor: psmOrchestrator.publicKey,
      bufferDepositor: psmOrchestrator.publicKey,
      bufferWithdrawer: coldMultisig.publicKey,
      capManager: coldMultisig.publicKey,
      allowanceManager: coldMultisig.publicKey,
      rebaser: psmOrchestrator.publicKey,
      usdOkuUri: "",
    })
    .accountsPartial({
      roleAdmin: payer.publicKey,
      config: configPda,
      usdcMint,
      usdOkuMint,
      vaultUsdc: vaultUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([usdOkuMintKeypair])
    .rpc();

  await program.methods
    .setupRedemptionQueue()
    .accountsPartial({
      roleAdmin: payer.publicKey,
      config: configPda,
      redemptionQueue: redemptionQueuePda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  await program.methods
    .setupUsdOkuEscrow()
    .accountsPartial({
      roleAdmin: payer.publicKey,
      config: configPda,
      usdOkuMint,
      vaultUsdOku: vaultUsdOkuAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return { configPda, redemptionQueuePda, usdOkuMint, vaultUsdcAta, vaultUsdOkuAta };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Mint usdOku to `user` via `mint_usd_oku`. Caller is responsible for
 * funding the user's USDC ATA and creating their usdOku ATA.
 */
export async function mintUsdOkuViaProgram(
  program: Program,
  user: Keypair,
  amount: BN,
  configPda: PublicKey,
  usdcMint: PublicKey,
  usdOkuMint: PublicKey,
  userUsdcAta: PublicKey,
  userUsdOkuAta: PublicKey,
  vaultUsdcAta: PublicKey
): Promise<void> {
  await program.methods
    .mintUsdOku(amount)
    .accountsPartial({
      user: user.publicKey,
      config: configPda,
      usdcMint,
      usdOkuMint,
      userUsdcAta,
      userUsdOkuAta,
      vaultUsdc: vaultUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([user])
    .rpc();
}

/**
 * Guarantee the PSM is unpaused before a test runs. If currently paused,
 * unpauses using `coldMultisig` (which holds the `unpauser` role per
 * the standard test layout).
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
