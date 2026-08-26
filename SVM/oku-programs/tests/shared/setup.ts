/**
 * Shared PSM test setup — bankrun-only.
 *
 * Module-level keypairs (`coldMultisig`, `warmMultisig`, `psmOrchestrator`)
 * are generated once at module load and reused across the entire mocha
 * process. They are deterministic per-process but freshly generated per-
 * process boot, so each test run starts with pristine authorities.
 *
 * `initializePsm` runs the PSM `initialize` instruction against the
 * supplied program, then creates the OkuM escrow ATA client-side (there
 * is no on-chain escrow-setup instruction). No memoization, no singleton,
 * no cross-file cache — every bankrun cluster is fresh and the on-chain
 * PsmConfig must always be created by the calling describe's `before()`
 * hook.
 *
 * The `initialize` instruction now creates the OkuM mint itself with
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
import { fundKeypairs, ensureAtaViaBankrun } from "./bankrun";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MAX_SUPPLY = new BN(1_000_000_000_000); // 1M with 6 decimals
export const MINTER_ALLOWANCE = new BN(100_000_000_000); // 100k with 6 decimals
export const DECIMALS = 6;

/** `oku_shared::MAX_FEE_BPS` — the ceiling on `tin`/`tout`. */
export const MAX_FEE_BPS = 100;
/**
 * `oku_shared::MAX_STEP_BPS` — simultaneously the per-step ceiling and the
 * PER-LEG floor under `tin`/`tout`. The single number defining step coverage.
 */
export const MAX_STEP_BPS = 5;
/** `oku_shared::DEFAULT_SYNC_WINDOW_SECS` — window length written at init. */
export const DEFAULT_SYNC_WINDOW_SECS = 60;

/**
 * Default `tout` applied by `initializePsm`.
 *
 * TESTS NO LONGER NEED TO SET A FEE TO MOVE THE MULTIPLIER. `initialize` seeds
 * both legs at `MAX_STEP_BPS` and `set_fees` refuses anything below it, so every
 * step `set_multiplier` admits is covered from the first slot. The old
 * fail-closed-at-zero state is gone: with the program no longer reading the fee
 * schedule at write time, a zero-fee window would be an uncovered-step window.
 *
 * `MAX_FEE_BPS` is still the default here so fee arithmetic stays visible in
 * every suite rather than sitting at the floor where rounding is smallest.
 *
 * Note the standing consequence of `MAX_STEP_BPS`: a single step is capped at
 * 5 bps, so a test wanting a large multiplier must take many steps — see
 * `stepMultiplierTo` in `tests/shared/multiplier.ts`.
 */
export const DEFAULT_TEST_TOUT_BPS = MAX_FEE_BPS;

/**
 * Default `tin` applied by `initializePsm` — the per-leg floor.
 *
 * Exported so suites can state fee-adjusted expectations against the value the
 * fixture actually configured rather than hardcoding 5.
 */
export const DEFAULT_TEST_TIN_BPS = MAX_STEP_BPS;

export interface InitializePsmOptions {
  /**
   * `tout` to configure immediately after `initialize`. Defaults to
   * `DEFAULT_TEST_TOUT_BPS`.
   *
   * CLAMPED UP to `MAX_STEP_BPS`: the per-leg floor is enforced on-chain, so
   * there is no reachable state below it. Passing `0` no longer observes a
   * fail-closed state — it gets the floor.
   */
  toutBps?: number;
  /** `tin` to configure. Defaults to 0. */
  tinBps?: number;
  /**
   * Sync-window length to configure after `initialize`. Defaults to whatever
   * the program writes (`DEFAULT_SYNC_WINDOW_SECS`).
   *
   * Pass `0` to disable the window for suites that exercise a different,
   * orthogonal guard — notably the same-slot yield fence, which the window
   * would otherwise mask behind a `SyncWindowActive` revert.
   */
  syncWindowSecs?: number;
}

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

/** PSM orchestrator — automated operations. PSM roles:
 *  bufferDepositor, rebaser. This same key also drives cross-chain
 *  transfers off-chain by calling `mint_oku_m` / `redeem_oku_m` on each
 *  side. */
export const psmOrchestrator = Keypair.generate();

// ---------------------------------------------------------------------------
// PSM initialization
// ---------------------------------------------------------------------------

export interface PsmSetupResult {
  configPda: PublicKey;
  okuMMint: PublicKey;
  vaultUsdcAta: PublicKey;
  vaultOkuMAta: PublicKey;
}

/**
 * Initialize the PSM end-to-end on the supplied bankrun harness.
 *
 * Steps performed (no caching — every call re-runs both steps):
 *   1. fund the shared authority keypairs via `fundKeypairs(h, ...)`
 *   2. `initialize(...)` — creates PsmConfig + USDC vault + OkuM mint
 *      (the program creates the Token-2022 mint with ScaledUiAmount +
 *      MetadataPointer + TokenMetadata extensions)
 *   3. create the OkuM escrow ATA client-side (idempotent ATA create;
 *      no on-chain PSM instruction needed for this step)
 *
 * Authority roles use the same keypair-per-role mapping as the deploy
 * config: cold for high-security, warm for medium, psmOrchestrator for
 * automated.
 */
export async function initializePsm(
  h: BankrunHarness,
  program: Program,
  payer: Keypair,
  usdcMint: PublicKey,
  options: InitializePsmOptions = {}
): Promise<PsmSetupResult> {
  // Generate a fresh keypair for the OkuM mint — the program's
  // `initialize` instruction creates it with Token-2022 extensions.
  const okuMMintKeypair = Keypair.generate();
  const okuMMint = okuMMintKeypair.publicKey;

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("psm_config")],
    program.programId
  );
  const vaultUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    configPda,
    true,
    TOKEN_PROGRAM_ID
  );
  const vaultOkuMAta = getAssociatedTokenAddressSync(
    okuMMint,
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

  // `initialize` takes an `InitializeParams` struct and a `okuMMint`
  // signer keypair. The program creates the mint with extensions via CPI.
  await program.methods
    .initialize({
      maxSupply: MAX_SUPPLY,
      minterAllowance: MINTER_ALLOWANCE,
      pauser: warmMultisig.publicKey,
      unpauser: coldMultisig.publicKey,
      freezer: warmMultisig.publicKey,
      unfreezer: coldMultisig.publicKey,
      bufferDepositor: psmOrchestrator.publicKey,
      bufferWithdrawer: coldMultisig.publicKey,
      capManager: coldMultisig.publicKey,
      allowanceManager: coldMultisig.publicKey,
      rebaser: psmOrchestrator.publicKey,
      okuMUri: "",
    })
    .accountsPartial({
      roleAdmin: payer.publicKey,
      config: configPda,
      usdcMint,
      okuMMint,
      vaultUsdc: vaultUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([okuMMintKeypair])
    .rpc();

  // Create the OkuM escrow ATA client-side (idempotent). There is no
  // on-chain escrow-setup instruction; this ATA is retained for tests that
  // reference `vaultOkuMAta`.
  await ensureAtaViaBankrun(h, configPda, okuMMint, TOKEN_2022_PROGRAM_ID);

  // Configure fees. `initialize` already seeded both legs at the step-coverage
  // floor, so this is a raise rather than an enable. Values below
  // `MAX_STEP_BPS` are rejected on-chain (`FeeBelowStepFloor`), so both
  // defaults are clamped up to the floor — a suite asking for 0 gets the floor,
  // which is the minimum reachable state rather than an error.
  const toutBps = Math.max(options.toutBps ?? DEFAULT_TEST_TOUT_BPS, MAX_STEP_BPS);
  const tinBps = Math.max(options.tinBps ?? 0, MAX_STEP_BPS);
  {
    await program.methods
      .setFees(new BN(tinBps), new BN(toutBps))
      .accountsPartial({ capManager: coldMultisig.publicKey, config: configPda })
      .signers([coldMultisig])
      .rpc();
  }

  if (options.syncWindowSecs !== undefined) {
    await program.methods
      .setSyncWindowSecs(new BN(options.syncWindowSecs))
      .accountsPartial({ capManager: coldMultisig.publicKey, config: configPda })
      .signers([coldMultisig])
      .rpc();
  }

  return { configPda, okuMMint, vaultUsdcAta, vaultOkuMAta };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Mint okuM to `user` via `mint_oku_m`. Caller is responsible for
 * funding the user's USDC ATA and creating their okuM ATA.
 */
export async function mintOkuMViaProgram(
  program: Program,
  user: Keypair,
  amount: BN,
  configPda: PublicKey,
  usdcMint: PublicKey,
  okuMMint: PublicKey,
  userUsdcAta: PublicKey,
  userOkuMAta: PublicKey,
  vaultUsdcAta: PublicKey
): Promise<void> {
  await program.methods
    .mintOkuM(amount)
    .accountsPartial({
      user: user.publicKey,
      config: configPda,
      usdcMint,
      okuMMint,
      userUsdcAta,
      userOkuMAta,
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
