/**
 * Shared PSM test setup — bankrun-only.
 *
 * Module-level keypairs (`coldMultisig`, `warmMultisig`, `psmOrchestrator`,
 * `bridgeOrchestrator`) are generated once at module load and reused
 * across the entire mocha process. They are deterministic per-process
 * but freshly generated per-process boot, so each test run starts with
 * pristine authorities.
 *
 * `initializePsm` runs the PSM `initialize` + `setup_redemption_queue` +
 * `setup_oku_money_escrow` instructions against the supplied program.
 * No memoization, no singleton, no cross-file cache — every bankrun
 * cluster is fresh and the on-chain PsmConfig must always be created
 * by the calling describe's `before()` hook.
 *
 * Phase 11 removed:
 *  - `validatorFunder` and the legacy `safeAirdrop` / `safeAirdropAll` /
 *    `safeMintTo` / `ensureAta` helpers (no unit test runs on the
 *    validator anymore; `tests/fork/_shared/legacy-funder.ts` keeps a
 *    local copy for the surfpool fork tests).
 *  - The `psmInitialized` cross-file singleton + the `resetPsmSingleton()`
 *    ceremony that every describe's `before()` had to call.
 *  - The `Funder` callback abstraction (only ever had one impl that
 *    callers needed).
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
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
 * PSM roles: unpauser, unfreezer, bufferWithdrawer, oracleManager,
 * capManager, allowanceManager.
 */
export const coldMultisig = Keypair.generate();

/** Warm multisig authority — medium-security operations. PSM roles:
 *  pauser, freezer. */
export const warmMultisig = Keypair.generate();

/** PSM orchestrator — automated operations. PSM roles: queueProcessor,
 *  bufferDepositor, rebaser. */
export const psmOrchestrator = Keypair.generate();

/** Bridge orchestrator — Ed25519 signer for bridge_mint. Separate from
 *  psmOrchestrator to keep role separation explicit. */
export const bridgeOrchestrator = Keypair.generate();

// ---------------------------------------------------------------------------
// PSM initialization
// ---------------------------------------------------------------------------

export interface PsmSetupResult {
  configPda: PublicKey;
  redemptionQueuePda: PublicKey;
  vaultUsdcAta: PublicKey;
  vaultOkuMoneyAta: PublicKey;
}

/**
 * Initialize the PSM end-to-end on the supplied bankrun harness.
 *
 * Steps performed (no caching — every call runs all three on-chain
 * instructions):
 *   1. fund the shared authority keypairs via `fundKeypairs(h, ...)`
 *   2. `initialize(...)` — creates PsmConfig + USDC vault
 *   3. `setupRedemptionQueue()`
 *   4. `setupOkuMoneyEscrow()` — creates the OkuMoney escrow ATA
 *
 * Authority roles use the same keypair-per-role mapping as the deploy
 * config: cold for high-security, warm for medium, psmOrchestrator for
 * automated.
 *
 * `pythProgramOwner` is fixed at the legacy mainnet Pyth ID as a
 * placeholder; tests that exercise the oracle path call
 * `set_pyth_program_owner` to rotate to their fixture's owner.
 */
export async function initializePsm(
  h: BankrunHarness,
  program: Program,
  payer: Keypair,
  usdcMint: PublicKey,
  okuMoneyMint: PublicKey
): Promise<PsmSetupResult> {
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("psm_config")],
    program.programId
  );
  const [redemptionQueuePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("redemption_queue")],
    program.programId
  );
  const vaultUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    configPda,
    true,
    TOKEN_PROGRAM_ID
  );
  const vaultOkuMoneyAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
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

  // Legacy mainnet Pyth ID — placeholder. Tests that need a different
  // oracle program rotate via `set_pyth_program_owner` after init.
  const PYTH_LEGACY_MAINNET = new PublicKey(
    "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH"
  );

  await program.methods
    .initialize(
      MAX_SUPPLY,
      MINTER_ALLOWANCE,
      warmMultisig.publicKey,    // pauser
      coldMultisig.publicKey,    // unpauser
      warmMultisig.publicKey,    // freezer
      coldMultisig.publicKey,    // unfreezer
      psmOrchestrator.publicKey, // queueProcessor
      psmOrchestrator.publicKey, // bufferDepositor
      coldMultisig.publicKey,    // bufferWithdrawer
      coldMultisig.publicKey,    // oracleManager
      coldMultisig.publicKey,    // capManager
      coldMultisig.publicKey,    // allowanceManager
      psmOrchestrator.publicKey, // rebaser
      PYTH_LEGACY_MAINNET,
    )
    .accountsPartial({
      roleAdmin: payer.publicKey,
      config: configPda,
      usdcMint,
      okuMoneyMint,
      vaultUsdc: vaultUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
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
    .setupOkuMoneyEscrow()
    .accountsPartial({
      roleAdmin: payer.publicKey,
      config: configPda,
      okuMoneyMint,
      vaultOkuMoney: vaultOkuMoneyAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  return { configPda, redemptionQueuePda, vaultUsdcAta, vaultOkuMoneyAta };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Mint OkuMoney to `user` via `mint_oku_m` with the oracle disabled
 * (`priceUpdate: null`). Caller is responsible for funding the user's
 * USDC ATA and creating their OkuMoney ATA.
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
  vaultUsdcAta: PublicKey
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
