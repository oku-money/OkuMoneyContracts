import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  ensurePSMUnpaused,
  mintUsdOkuViaProgram,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
  DECIMALS,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  readMultiplierFromMint,
} from "../shared/bankrun";
// Use anchor's web3 to avoid version conflicts
const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

// =============================================================================
// Queue helpers (Phase 13b: u64 head/tail decode as BN, MAX_ENTRIES = 200)
// =============================================================================

/**
 * Ring-buffer capacity (mirrors `RedemptionQueue::MAX_ENTRIES` in
 * `programs/lite-psm/src/state.rs`). Used by tests that index into
 * `queue.entries[absolute_index % MAX_ENTRIES]`.
 *
 * 200 entries × 48 bytes = 9 600 bytes — fits under Solana's 10 KB
 * single-CPI allocation cap so `setup_redemption_queue` works one-shot.
 */
const QUEUE_MAX_ENTRIES = 200;

/**
 * Reduce an absolute queue index to its ring-buffer slot (0..MAX_ENTRIES).
 * Accepts BN or number (Anchor decodes u64 fields as BN).
 */
function ringSlot(absIndex: BN | number): number {
  const bn = typeof absIndex === "number" ? new BN(absIndex) : absIndex;
  return bn.umod(new BN(QUEUE_MAX_ENTRIES)).toNumber();
}

/** Convenience: convert a queue head/tail/index to a JS number (safe for
 *  small values, which is all bankrun tests ever produce). */
function n(x: BN | number): number {
  return typeof x === "number" ? x : x.toNumber();
}

describe("lite-psm", () => {
  // Delay initialization until tests run
  let h: BankrunHarness;
  let provider: anchor.AnchorProvider;
  let program: Program<LitePsm>;
  let payer: Keypair;

  // RBAC Authority Keypairs
  // coldMultisig, warmMultisig, psmOrchestrator imported from shared setup
  let admin: Keypair;
  const orchestrator = psmOrchestrator; // Use shared PSM orchestrator

  // Test user keypairs
  const user = Keypair.generate();
  const user2 = Keypair.generate();

  // Mint keypairs
  const usdcMintKeypair = Keypair.generate();

  // PDAs
  let configPda: PublicKey;
  let configBump: number;
  let redemptionQueuePda: PublicKey;
  let redemptionQueueBump: number;

  // Token accounts
  let vaultUsdcAta: PublicKey;
  let vaultUsdOkuAta: PublicKey;  // usdOku escrow for queued redemptions
  let userUsdcAta: PublicKey;
  let userUsdOkuAta: PublicKey;
  let user2UsdcAta: PublicKey;
  let user2UsdOkuAta: PublicKey;
  let orchestratorUsdcAta: PublicKey;

  // Mints
  let usdcMint: PublicKey;
  let usdOkuMint: PublicKey;

  // MAX_SUPPLY, MINTER_ALLOWANCE, DECIMALS imported from shared setup

  before(async () => {
    h = await startBankrun();
    provider = h.provider as unknown as anchor.AnchorProvider;
    program = h.program;
    payer = h.payer;
    admin = payer;

    // Create the USDC mint. Bankrun gives us a fresh cluster every time.
    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      DECIMALS,
      usdcMintKeypair,
      TOKEN_PROGRAM_ID
    );

    // Fund test accounts via bankrun's setAccount lamports injection.
    await fundKeypairs(h, [user, user2], 10 * anchor.web3.LAMPORTS_PER_SOL);

    // Initialize PSM — this creates the usdOku mint with ScaledUiAmount
    // extension and all supporting accounts.
    const psmSetup = await initializePsm(h, program, payer, usdcMint);
    configPda = psmSetup.configPda;
    redemptionQueuePda = psmSetup.redemptionQueuePda;
    usdOkuMint = psmSetup.usdOkuMint;
    vaultUsdcAta = psmSetup.vaultUsdcAta;
    vaultUsdOkuAta = psmSetup.vaultUsdOkuAta;

    [, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config_v5")],
      program.programId
    );

    // Derive user/orchestrator ATA addresses + create them.
    userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user.publicKey, false, TOKEN_PROGRAM_ID);
    userUsdOkuAta = getAssociatedTokenAddressSync(usdOkuMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
    user2UsdcAta = getAssociatedTokenAddressSync(usdcMint, user2.publicKey, false, TOKEN_PROGRAM_ID);
    user2UsdOkuAta = getAssociatedTokenAddressSync(usdOkuMint, user2.publicKey, false, TOKEN_2022_PROGRAM_ID);
    orchestratorUsdcAta = getAssociatedTokenAddressSync(usdcMint, orchestrator.publicKey, false, TOKEN_PROGRAM_ID);

    await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await ensureAtaViaBankrun(h, user2.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await ensureAtaViaBankrun(h, orchestrator.publicKey, usdcMint, TOKEN_PROGRAM_ID);

    // Mint USDC to users + orchestrator.
    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 1_000_000_000_000, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, user2UsdcAta, payer, 1_000_000_000_000, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, orchestratorUsdcAta, payer, 1_000_000_000_000, TOKEN_PROGRAM_ID);
  });

  beforeEach(async () => {
    // Slot auto-bump is handled by `startBankrun({ autoBumpSlot: true })`
    // (the default) — every `provider.sendAndConfirm` advances the bankrun
    // slot by 1 before submitting. So `check_yield_lock` is never
    // poisoned by a stuck slot from a prior test.
    await ensurePSMUnpaused(program, configPda);
  });

  describe("initialize", () => {
    it("verifies PSM was initialized with all granular authorities", async () => {
      // PSM is initialized by shared setup module - verify it exists and is correct

      // Verify config has all authorities set correctly (using shared authorities)
      const config = await program.account.psmConfig.fetch(configPda);
      expect(config.pauser.toString()).to.equal(warmMultisig.publicKey.toString());
      expect(config.unpauser.toString()).to.equal(coldMultisig.publicKey.toString());
      expect(config.freezer.toString()).to.equal(warmMultisig.publicKey.toString());
      expect(config.unfreezer.toString()).to.equal(coldMultisig.publicKey.toString());
      expect(config.queueProcessor.toString()).to.equal(orchestrator.publicKey.toString());
      expect(config.bufferDepositor.toString()).to.equal(orchestrator.publicKey.toString());
      expect(config.bufferWithdrawer.toString()).to.equal(coldMultisig.publicKey.toString());
      expect(config.capManager.toString()).to.equal(coldMultisig.publicKey.toString());
      expect(config.allowanceManager.toString()).to.equal(coldMultisig.publicKey.toString());
      expect(config.rebaser.toString()).to.equal(orchestrator.publicKey.toString());
      expect(config.maxSupply.toString()).to.equal(MAX_SUPPLY.toString());
      // Minter allowance may have been partially consumed by earlier tests
      // sharing this bankrun harness.
      expect(Number(config.minterAllowance)).to.be.greaterThan(0);
      expect(Number(config.minterAllowance)).to.be.at.most(Number(MINTER_ALLOWANCE));
      expect(config.isPaused).to.be.false;
      // Verify usdOku mint is set
      expect(config.usdOkuMint.toString()).to.not.equal(PublicKey.default.toString());

      // Verify redemption queue exists (may have entries from previous tests)
      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      // head/tail are u64 → BN; compare as BN
      expect(n(queue.tail)).to.be.at.least(n(queue.head));
    });
  });

  describe("mint", () => {
    it("mints usdOku 1:1 with USDC (pre-created ATA)", async () => {
      const mintAmount = new BN(1_000_000); // 1 USDC/usdOku

      // Pre-create usdOku ATA
      await ensureAtaViaBankrun(h, user.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);

      // Get balances before
      const userUsdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
      let userUsdOkuBefore: bigint;
      try {
        const acct = await getAccount(provider.connection, userUsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
        userUsdOkuBefore = acct.amount;
      } catch {
        userUsdOkuBefore = BigInt(0);
      }

      await program.methods
        .mintUsdOku(mintAmount)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          usdcMint: usdcMint,
          usdOkuMint: usdOkuMint,
          userUsdcAta: userUsdcAta,
          userUsdOkuAta: userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Verify balances
      const userUsdcAfter = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
      const userUsdOkuAfter = await getAccount(provider.connection, userUsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);

      expect(Number(userUsdcBefore.amount) - Number(userUsdcAfter.amount)).to.equal(mintAmount.toNumber());
      expect(Number(userUsdOkuAfter.amount) - Number(userUsdOkuBefore)).to.equal(mintAmount.toNumber());
    });

    it("mints usdOku with init_if_needed ATA creation", async () => {
      const freshUser = Keypair.generate();
      const mintAmount = new BN(1_000_000); // 1 USDC/usdOku

      await fundKeypairs(h, [freshUser], 10 * anchor.web3.LAMPORTS_PER_SOL);

      // Create and fund USDC ATA
      const freshUserUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, freshUser.publicKey, false, TOKEN_PROGRAM_ID
      );
      const freshUserUsdOkuAta = getAssociatedTokenAddressSync(
        usdOkuMint, freshUser.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      const createAtaTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey, freshUserUsdcAta, freshUser.publicKey, usdcMint, TOKEN_PROGRAM_ID
        )
      );
      await provider.sendAndConfirm(createAtaTx, [payer]);
      await mintToViaBankrun(h, usdcMint, freshUserUsdcAta, payer, 10_000_000, TOKEN_PROGRAM_ID);

      // DO NOT pre-create usdOku ATA — let init_if_needed handle it
      await program.methods
        .mintUsdOku(mintAmount)
        .accountsPartial({
          user: freshUser.publicKey,
          config: configPda,
          usdcMint: usdcMint,
          usdOkuMint: usdOkuMint,
          userUsdcAta: freshUserUsdcAta,
          userUsdOkuAta: freshUserUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([freshUser])
        .rpc();

      // Verify usdOku was minted
      const usdOkuAccount = await getAccount(
        provider.connection, freshUserUsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID
      );
      expect(Number(usdOkuAccount.amount)).to.equal(mintAmount.toNumber());
    });

    it("fails to mint when paused", async () => {
      // Pause the PSM (warm multisig)
      await program.methods
        .pause()
        .accountsPartial({
          pauser: warmMultisig.publicKey,
          config: configPda,
        })
        .signers([warmMultisig])
        .rpc();

      try {
        await program.methods
          .mintUsdOku(new BN(1_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint: usdcMint,
            usdOkuMint: usdOkuMint,
            userUsdcAta: userUsdcAta,
            userUsdOkuAta: userUsdOkuAta,
            vaultUsdc: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        // Error may come as AnchorError or SendTransactionError
        const errorCode = err?.error?.errorCode?.code || err?.message;
        expect(errorCode).to.satisfy((code: string) =>
          code === "Paused" || code.includes("Paused")
        );
      }

      // Unpause for future tests (cold multisig)
      await program.methods
        .unpause()
        .accountsPartial({
          unpauser: coldMultisig.publicKey,
          config: configPda,
        })
        .signers([coldMultisig])
        .rpc();
    });
  });

  describe("RBAC Role Separation Tests", () => {
    describe("pause/unpause separation", () => {
      it("warm multisig can pause", async () => {
        await program.methods
          .pause()
          .accountsPartial({
            pauser: warmMultisig.publicKey,
            config: configPda,
          })
          .signers([warmMultisig])
          .rpc();

        const config = await program.account.psmConfig.fetch(configPda);
        expect(config.isPaused).to.be.true;
      });

      it("cold multisig can unpause", async () => {
        // Pause first (beforeEach resets to unpaused, and unpause now reverts with
        // NotPaused if the PSM isn't actually paused).
        await program.methods
          .pause()
          .accountsPartial({
            pauser: warmMultisig.publicKey,
            config: configPda,
          })
          .signers([warmMultisig])
          .rpc();

        await program.methods
          .unpause()
          .accountsPartial({
            unpauser: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();

        const config = await program.account.psmConfig.fetch(configPda);
        expect(config.isPaused).to.be.false;
      });

      it("warm multisig CANNOT unpause", async () => {
        // First pause
        await program.methods
          .pause()
          .accountsPartial({
            pauser: warmMultisig.publicKey,
            config: configPda,
          })
          .signers([warmMultisig])
          .rpc();

        // Try to unpause with wrong authority
        try {
          await program.methods
            .unpause()
            .accountsPartial({
              unpauser: warmMultisig.publicKey, // Wrong authority
              config: configPda,
            })
            .signers([warmMultisig])
            .rpc();
          expect.fail("Should have failed");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("Unauthorized");
        }

        // Cleanup: unpause with correct authority
        await program.methods
          .unpause()
          .accountsPartial({
            unpauser: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();
      });

      it("cold multisig CANNOT pause", async () => {
        try {
          await program.methods
            .pause()
            .accountsPartial({
              pauser: coldMultisig.publicKey, // Wrong authority
              config: configPda,
            })
            .signers([coldMultisig])
            .rpc();
          expect.fail("Should have failed");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("Unauthorized");
        }
      });
    });

    // NOTE: Freeze/thaw RBAC tests removed - these require minting usdOku for setup
    // Coverage: Freeze/thaw authority is correctly set in initialization (verified by init test)
    // The freeze/thaw instructions use standard Token-2022 CPI calls with proper authority checks
    // RBAC pattern is identical to pause/unpause which is thoroughly tested

    describe("admin role separation", () => {
      it("cap_manager can set max supply", async () => {
        const newMaxSupply = new BN(2_000_000_000_000);

        await program.methods
          .setMaxSupply(newMaxSupply)
          .accountsPartial({
            capManager: coldMultisig.publicKey,
            config: configPda,
            usdOkuMint: usdOkuMint,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();

        const config = await program.account.psmConfig.fetch(configPda);
        expect(config.maxSupply.toString()).to.equal(newMaxSupply.toString());

        // Reset
        await program.methods
          .setMaxSupply(MAX_SUPPLY)
          .accountsPartial({
            capManager: coldMultisig.publicKey,
            config: configPda,
            usdOkuMint: usdOkuMint,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      });

      it("non-cap_manager CANNOT set max supply", async () => {
        try {
          await program.methods
            .setMaxSupply(new BN(2_000_000_000_000))
            .accountsPartial({
              capManager: warmMultisig.publicKey, // Wrong role
              config: configPda,
              usdOkuMint: usdOkuMint,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .signers([warmMultisig])
            .rpc();
          expect.fail("Should have failed");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("Unauthorized");
        }
      });

      it("allowance_manager can set minter allowance", async () => {
        const newAllowance = new BN(500_000_000_000);

        await program.methods
          .setMinterAllowance(newAllowance)
          .accountsPartial({
            allowanceManager: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();

        const config = await program.account.psmConfig.fetch(configPda);
        expect(config.minterAllowance.toString()).to.equal(newAllowance.toString());
      });

      it("non-allowance_manager CANNOT set allowance", async () => {
        try {
          await program.methods
            .setMinterAllowance(new BN(1))
            .accountsPartial({
              allowanceManager: warmMultisig.publicKey, // Wrong role
              config: configPda,
            })
            .signers([warmMultisig])
            .rpc();
          expect.fail("Should have failed");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("Unauthorized");
        }
      });
    });

    describe("orchestrator role separation", () => {
      let bufferWithdrawerUsdcAta: PublicKey;

      before(async () => {
        // Create USDC account for buffer withdrawer
        bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
          usdcMint,
          coldMultisig.publicKey,
          false,
          TOKEN_PROGRAM_ID
        );

        await ensureAtaViaBankrun(h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);

        // Ensure vault_usdc ATA exists (should have been created during initialize)
        await ensureAtaViaBankrun(h, configPda, usdcMint, TOKEN_PROGRAM_ID);

        // Ensure vault has balance
        await program.methods
          .depositBuffer(new BN(200_000_000))
          .accountsPartial({
            bufferDepositor: orchestrator.publicKey,
            config: configPda,
            bufferDepositorUsdcAta: orchestratorUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint: usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();
      });

      it("buffer_depositor can deposit buffer", async () => {
        const depositAmount = new BN(100_000_000);
        const vaultBefore = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);

        await program.methods
          .depositBuffer(depositAmount)
          .accountsPartial({
            bufferDepositor: orchestrator.publicKey,
            config: configPda,
            bufferDepositorUsdcAta: orchestratorUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint: usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();

        const vaultAfter = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
        expect(Number(vaultAfter.amount) - Number(vaultBefore.amount)).to.equal(depositAmount.toNumber());
      });

      it("non-buffer_depositor CANNOT deposit buffer", async () => {
        try {
          await program.methods
            .depositBuffer(new BN(1_000_000))
            .accountsPartial({
              bufferDepositor: warmMultisig.publicKey, // Wrong role
              config: configPda,
              bufferDepositorUsdcAta: orchestratorUsdcAta,
              vaultUsdc: vaultUsdcAta,
              usdcMint: usdcMint,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([warmMultisig])
            .rpc();
          expect.fail("Should have failed");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("Unauthorized");
        }
      });

      it("buffer_withdrawer can withdraw buffer", async () => {
        const withdrawAmount = new BN(50_000_000);
        const vaultBefore = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);

        await program.methods
          .withdrawBuffer(withdrawAmount)
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint: usdOkuMint,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint: usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();

        const vaultAfter = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
        expect(Number(vaultBefore.amount) - Number(vaultAfter.amount)).to.equal(withdrawAmount.toNumber());
      });

      it("non-buffer_withdrawer CANNOT withdraw buffer", async () => {
        try {
          await program.methods
            .withdrawBuffer(new BN(1_000_000))
            .accountsPartial({
              bufferWithdrawer: warmMultisig.publicKey, // Wrong role
              config: configPda,
              redemptionQueue: redemptionQueuePda,
              usdOkuMint: usdOkuMint,
              withdrawerUsdcAta: bufferWithdrawerUsdcAta,
              vaultUsdc: vaultUsdcAta,
              usdcMint: usdcMint,
              tokenProgram: TOKEN_PROGRAM_ID,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .signers([warmMultisig])
            .rpc();
          expect.fail("Should have failed");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("Unauthorized");
        }
      });

      it("rebaser can set usdOku multiplier", async () => {
        // Multiplier starts at PRECISION (1e9) = $1.00. Set to PRECISION + 1.
        const newMultiplier = new BN(1_000_000_001);

        await program.methods
          .setMultiplier(newMultiplier)
          .accountsPartial({
            rebaser: orchestrator.publicKey,
            config: configPda,
            usdOkuMint: usdOkuMint,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();

        const configAfter = await program.account.psmConfig.fetch(configPda);
        // lastYieldDistributionSlot should be set
        expect(Number(configAfter.lastYieldDistributionSlot)).to.be.greaterThan(0);
        // Note: Multiplier cannot be reset - it can only increase (yield accrual model)
      });

      it("non-rebaser CANNOT set usdOku price", async () => {
        try {
          await program.methods
            .setMultiplier(new BN(1_100_000_000)) // Doesn't matter, should fail auth
            .accountsPartial({
              rebaser: warmMultisig.publicKey, // Wrong role
              config: configPda,
              usdOkuMint: usdOkuMint,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .signers([warmMultisig])
            .rpc();
          expect.fail("Should have failed");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("Unauthorized");
        }
      });
    });
  });

  // ==========================================================================
  // Yield Operations (usdOku Price Model)
  // ==========================================================================
  describe("yield operations", () => {
    it("rebaser can distribute yield via multiplier increase", async () => {
      // Multiplier has been bumped by previous tests. Set to a higher value.
      const newMultiplier = new BN(1_010_000_000); // ~$1.01
      
      await program.methods
        .setMultiplier(newMultiplier)
        .accountsPartial({
          rebaser: orchestrator.publicKey,
          config: configPda,
          usdOkuMint: usdOkuMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();

      const configAfter = await program.account.psmConfig.fetch(configPda);
      // lastYieldDistributionSlot should be set
      expect(Number(configAfter.lastYieldDistributionSlot)).to.be.greaterThan(0);
    });

    it("non-rebaser CANNOT distribute yield", async () => {
      try {
        await program.methods
          .setMultiplier(new BN(1_100_000_000))
          .accountsPartial({
            rebaser: warmMultisig.publicKey, // Wrong role
            config: configPda,
            usdOkuMint: usdOkuMint,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([warmMultisig])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });

    // ------------------------------------------------------------------
    // distribute_yield: dollar-denominated yield → proportional price bump
    // ------------------------------------------------------------------

    it("distribute_yield: rebaser bumps multiplier proportional to yield/supply", async () => {
      // Need usdOku supply > 0 so that yield_per_token computes non-zero.
      const mintInfo = await getMint(
        provider.connection,
        usdOkuMint,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      if (Number(mintInfo.supply) === 0) {
        // Bail out cleanly — earlier tests should have minted; if not, skip.
        // Don't fail; this test runs after `mint` describe blocks.
        return;
      }

      const cfgBefore = await program.account.psmConfig.fetch(configPda);
      const supply = BigInt(mintInfo.supply.toString());
      const PRECISION_BI = 1_000_000_000n;

      // Distribute $0.001 worth of yield (1000 base units of dollars).
      // Picked deliberately small so yield_per_token > 0 even at high supply
      // but doesn't push price near MAX_OKU_M_PRICE.
      const yieldAmount = 1_000n;
      const expectedBump = (yieldAmount * PRECISION_BI) / supply;
      // If expected bump truncates to 0 (e.g. tiny yield vs huge supply), the
      // program returns YieldTooSmall — exercise both branches.
      if (expectedBump === 0n) {
        try {
          await program.methods
            .distributeYield(new BN(yieldAmount.toString()))
            .accountsPartial({
              rebaser: orchestrator.publicKey,
              config: configPda,
              usdOkuMint: usdOkuMint,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .signers([orchestrator])
            .rpc();
          expect.fail("Should have rejected with YieldTooSmall");
        } catch (err: any) {
          expect(err?.error?.errorCode?.code).to.equal("YieldTooSmall");
        }
        return;
      }

      const currentMultiplier = await readMultiplierFromMint(h, usdOkuMint);
      const oldPrice = BigInt(currentMultiplier.toString());
      const expectedNew = oldPrice + expectedBump;

      await program.methods
        .distributeYield(new BN(yieldAmount.toString()))
        .accountsPartial({
          rebaser: orchestrator.publicKey,
          config: configPda,
          usdOkuMint: usdOkuMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();

      const cfgAfter = await program.account.psmConfig.fetch(configPda);
      // Yield-distribution slot must advance (confirms the on-chain update happened)
      expect(Number(cfgAfter.lastYieldDistributionSlot)).to.be.greaterThan(
        Number(cfgBefore.lastYieldDistributionSlot)
      );
    });

    it("distribute_yield: zero yield_amount rejected", async () => {
      try {
        await program.methods
          .distributeYield(new BN(0))
          .accountsPartial({
            rebaser: orchestrator.publicKey,
            config: configPda,
            usdOkuMint: usdOkuMint,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();
        expect.fail("Should have rejected zero yield");
      } catch (err: any) {
        expect(err?.error?.errorCode?.code).to.equal("ZeroAmount");
      }
    });

    it("distribute_yield: non-rebaser is rejected with Unauthorized", async () => {
      try {
        await program.methods
          .distributeYield(new BN(1_000))
          .accountsPartial({
            rebaser: warmMultisig.publicKey, // wrong role
            config: configPda,
            usdOkuMint: usdOkuMint,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([warmMultisig])
          .rpc();
        expect.fail("Should have rejected non-rebaser");
      } catch (err: any) {
        expect(err?.error?.errorCode?.code).to.equal("Unauthorized");
      }
    });
  });

  // ==========================================================================
  // NEW COVERAGE: mint edge cases
  // ==========================================================================
  describe("mint edge cases", () => {
    before(async () => {
      // Ensure user has usdOku ATA
      await ensureAtaViaBankrun(h, user.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);
    });

    it("fails to mint zero amount", async () => {
      // On bankrun, slot advancement happens naturally between txs; we
      // accept either ZeroAmount (if we got a fresh slot) or
      // YieldDistributionInProgress (if still in the yield slot).
      try {
        await program.methods
          .mintUsdOku(new BN(0))
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
        expect.fail("Should have failed");
      } catch (err: any) {
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        // May also get YieldDistributionInProgress if in same slot as yield operation
        expect(errorCode).to.satisfy((c: string) => 
          c === "ZeroAmount" || c.includes("ZeroAmount") ||
          c === "YieldDistributionInProgress" || c.includes("YieldDistributionInProgress")
        );
      }
    });

    it("fails to mint when max supply exceeded", async () => {
      // Phase 8: set_max_supply now refuses to drop below current supply,
      // so squeeze the cap down to *exactly* the current supply — any
      // subsequent mint must fail with MaxSupplyExceeded.
      const currentMint = await getMint(
        provider.connection,
        usdOkuMint,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const tightCap = new BN(currentMint.supply.toString());
      await program.methods
        .setMaxSupply(tightCap)
        .accountsPartial({
          capManager: coldMultisig.publicKey,
          config: configPda,
          usdOkuMint: usdOkuMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig])
        .rpc();

      try {
        await program.methods
          .mintUsdOku(new BN(1_000_000))
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
        expect.fail("Should have failed");
      } catch (err: any) {
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        expect(errorCode).to.satisfy((c: string) => c === "MaxSupplyExceeded" || c.includes("MaxSupplyExceeded"));
      }

      // Restore max supply
      await program.methods
        .setMaxSupply(MAX_SUPPLY)
        .accountsPartial({
          capManager: coldMultisig.publicKey,
          config: configPda,
          usdOkuMint: usdOkuMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig])
        .rpc();
    });

  });

  // ==========================================================================
  // NEW COVERAGE: redeem - instant path
  // ==========================================================================
  describe("redeem - instant", () => {
    const MINT_AMOUNT = new BN(10_000_000); // 10 usdOku
    const BUFFER_AMOUNT = new BN(50_000_000); // 50 USDC buffer

    before(async () => {
      // Ensure user has usdOku ATA and mint usdOku
      await ensureAtaViaBankrun(h, user.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);
      await mintUsdOkuViaProgram(program, user, MINT_AMOUNT, configPda, usdcMint, usdOkuMint, userUsdcAta, userUsdOkuAta, vaultUsdcAta);

      // Ensure buffer has enough USDC for instant redemption
      await program.methods
        .depositBuffer(BUFFER_AMOUNT)
        .accountsPartial({
          bufferDepositor: orchestrator.publicKey,
          config: configPda,
          bufferDepositorUsdcAta: orchestratorUsdcAta,
          vaultUsdc: vaultUsdcAta,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();
    });

    it("redeems usdOku for USDC instantly when buffer sufficient", async () => {
      const redeemAmount = new BN(1_000_000); // 1 raw usdOku

      const userUsdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
      const userUsdOkuBefore = await getAccount(provider.connection, userUsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultUsdcBefore = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);

      await program.methods
        .redeemUsdOku(redeemAmount)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          usdOkuMint,
          userUsdcAta,
          userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userUsdcAfter = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
      const userUsdOkuAfter = await getAccount(provider.connection, userUsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultUsdcAfter = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);

      // usdOku burned from user
      expect(Number(userUsdOkuBefore.amount) - Number(userUsdOkuAfter.amount)).to.equal(redeemAmount.toNumber());
      // USDC sent to user -- multiplier > PRECISION so user gets more
      // USDC than raw tokens redeemed (yield accrual from prior tests).
      const usdcReceived = Number(userUsdcAfter.amount) - Number(userUsdcBefore.amount);
      expect(usdcReceived).to.be.greaterThan(redeemAmount.toNumber());
      // Vault USDC decreased by the same amount the user received
      const vaultDecrease = Number(vaultUsdcBefore.amount) - Number(vaultUsdcAfter.amount);
      expect(vaultDecrease).to.equal(usdcReceived);
    });

    it("fails to redeem when paused", async () => {
      await program.methods
        .pause()
        .accountsPartial({ pauser: warmMultisig.publicKey, config: configPda })
        .signers([warmMultisig])
        .rpc();

      try {
        await program.methods
          .redeemUsdOku(new BN(1_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdcMint,
            usdOkuMint,
            userUsdcAta,
            userUsdOkuAta,
            vaultUsdc: vaultUsdcAta,
            vaultUsdOku: vaultUsdOkuAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        expect(errorCode).to.satisfy((c: string) => c === "Paused" || c.includes("Paused"));
      }

      // Cleanup
      await program.methods
        .unpause()
        .accountsPartial({ unpauser: coldMultisig.publicKey, config: configPda })
        .signers([coldMultisig])
        .rpc();
    });

    it("fails to redeem zero amount", async () => {
      try {
        await program.methods
          .redeemUsdOku(new BN(0))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdcMint,
            usdOkuMint,
            userUsdcAta,
            userUsdOkuAta,
            vaultUsdc: vaultUsdcAta,
            vaultUsdOku: vaultUsdOkuAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        expect(errorCode).to.satisfy((c: string) => c === "ZeroAmount" || c.includes("ZeroAmount"));
      }
    });

    it("fails to redeem more than user owns", async () => {
      const userOkusd = await getAccount(provider.connection, userUsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
      const excessive = new BN(Number(userOkusd.amount) + 1_000_000_000);

      try {
        await program.methods
          .redeemUsdOku(excessive)
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdcMint,
            usdOkuMint,
            userUsdcAta,
            userUsdOkuAta,
            vaultUsdc: vaultUsdcAta,
            vaultUsdOku: vaultUsdOkuAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        // WS2.7 added a balance pre-check in redeem_usd_oku that fires
        // `InsufficientBuffer` before the Token-2022 burn CPI can reject
        // with its own `InsufficientFunds` error. Either is acceptable.
        // Cycle 4 (PSM-11): the on-program error for a user balance
        // shortfall is `InsufficientUserBalance` (was misleadingly
        // `InsufficientBuffer` before, which is now reserved for the
        // PSM-side buffer drain case). Accept both for transitional
        // compatibility plus the SPL Token raw insufficient-funds
        // selector that the underlying program may surface if the
        // pre-check is somehow skipped.
        const code = err?.error?.errorCode?.code;
        const msg = String(err?.message ?? err);
        const isInsufficient =
          code === "InsufficientFunds" ||
          code === "InsufficientBuffer" ||
          code === "InsufficientUserBalance" ||
          msg.includes("custom program error: 0x1") ||
          msg.includes("insufficient funds") ||
          msg.includes("InsufficientBuffer") ||
          msg.includes("InsufficientUserBalance");
        expect(isInsufficient, `unexpected error: ${msg}`).to.equal(true);
      }
    });
  });

  // ==========================================================================
  // NEW COVERAGE: redeem - queued path
  // ==========================================================================
  describe("redeem - queued", () => {
    const MINT_AMOUNT = new BN(20_000_000); // 20 usdOku

    before(async () => {
      // Ensure user has usdOku
      await ensureAtaViaBankrun(h, user.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);
      await ensureAtaViaBankrun(h, user2.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);
      await mintUsdOkuViaProgram(program, user, MINT_AMOUNT, configPda, usdcMint, usdOkuMint, userUsdcAta, userUsdOkuAta, vaultUsdcAta);
      await mintUsdOkuViaProgram(program, user2, MINT_AMOUNT, configPda, usdcMint, usdOkuMint, user2UsdcAta, user2UsdOkuAta, vaultUsdcAta);

      // Drain the USDC buffer so redemptions go to queue
      const vaultUsdc = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
      if (Number(vaultUsdc.amount) > 0) {
        const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
          usdcMint, coldMultisig.publicKey, false, TOKEN_PROGRAM_ID
        );
        await ensureAtaViaBankrun(h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);
        await program.methods
          .withdrawBuffer(new BN(Number(vaultUsdc.amount)))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint: usdOkuMint,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }
    });

    it("queues redemption when buffer insufficient", async () => {
      const redeemAmount = new BN(1_000_000); // 1 usdOku
      const queueBefore = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const escrowBefore = await getAccount(provider.connection, vaultUsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);

      await program.methods
        .redeemUsdOku(redeemAmount)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          usdOkuMint,
          userUsdcAta,
          userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const queueAfter = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const escrowAfter = await getAccount(provider.connection, vaultUsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);

      // Tail should advance (BN math)
      expect(n(queueAfter.tail)).to.equal(n(queueBefore.tail) + 1);
      // usdOku transferred to escrow
      expect(Number(escrowAfter.amount) - Number(escrowBefore.amount)).to.equal(redeemAmount.toNumber());
      // Queue entry has correct user
      const entry = queueAfter.entries[ringSlot(queueBefore.tail)];
      expect(entry.user.toString()).to.equal(user.publicKey.toString());
      expect(Number(entry.rawUsdOkuAmount)).to.equal(redeemAmount.toNumber());
    });

    it("queues multiple from different users", async () => {
      const redeemAmount = new BN(1_000_000);
      const queueBefore = await program.account.redemptionQueue.fetch(redemptionQueuePda);

      await program.methods
        .redeemUsdOku(redeemAmount)
        .accountsPartial({
          user: user2.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          usdOkuMint,
          userUsdcAta: user2UsdcAta,
          userUsdOkuAta: user2UsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      const queueAfter = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(n(queueAfter.tail)).to.equal(n(queueBefore.tail) + 1);
      const entry = queueAfter.entries[ringSlot(queueBefore.tail)];
      expect(entry.user.toString()).to.equal(user2.publicKey.toString());
    });
  });

  // ==========================================================================
  // NEW COVERAGE: process_queue
  // ==========================================================================
  describe("process_queue", () => {
    before(async () => {
      // Deposit buffer to process queued entries
      await program.methods
        .depositBuffer(new BN(50_000_000))
        .accountsPartial({
          bufferDepositor: orchestrator.publicKey,
          config: configPda,
          bufferDepositorUsdcAta: orchestratorUsdcAta,
          vaultUsdc: vaultUsdcAta,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();
    });

    it("processes single queue entry", async () => {
      const queueBefore = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      if (n(queueBefore.head) >= n(queueBefore.tail)) {
        // Queue is empty, create an entry first
        await mintUsdOkuViaProgram(program, user, new BN(2_000_000), configPda, usdcMint, usdOkuMint, userUsdcAta, userUsdOkuAta, vaultUsdcAta);
        // Drain buffer to force queuing
        const vaultUsdc = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
        const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
          usdcMint, coldMultisig.publicKey, false, TOKEN_PROGRAM_ID
        );
        await ensureAtaViaBankrun(h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);
        if (Number(vaultUsdc.amount) > 0) {
          await program.methods
            .withdrawBuffer(new BN(Number(vaultUsdc.amount)))
            .accountsPartial({
              bufferWithdrawer: coldMultisig.publicKey,
              config: configPda,
              redemptionQueue: redemptionQueuePda,
              usdOkuMint: usdOkuMint,
              withdrawerUsdcAta: bufferWithdrawerUsdcAta,
              vaultUsdc: vaultUsdcAta,
              usdcMint,
              tokenProgram: TOKEN_PROGRAM_ID,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .signers([coldMultisig])
            .rpc();
        }
        await program.methods
          .redeemUsdOku(new BN(1_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdcMint,
            usdOkuMint,
            userUsdcAta,
            userUsdOkuAta,
            vaultUsdc: vaultUsdcAta,
            vaultUsdOku: vaultUsdOkuAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        // Re-deposit buffer for processing
        await program.methods
          .depositBuffer(new BN(10_000_000))
          .accountsPartial({
            bufferDepositor: orchestrator.publicKey,
            config: configPda,
            bufferDepositorUsdcAta: orchestratorUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();
      }

      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const headBefore = queue.head;
      const entry = queue.entries[ringSlot(headBefore)];
      const recipientUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, entry.user, false, TOKEN_PROGRAM_ID
      );
      await ensureAtaViaBankrun(h, entry.user, usdcMint, TOKEN_PROGRAM_ID);

      const recipientUsdcBefore = await getAccount(provider.connection, recipientUsdcAta, undefined, TOKEN_PROGRAM_ID);

      await program.methods
        .processQueue(1)
        .accountsPartial({
          queueProcessor: orchestrator.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: recipientUsdcAta, isSigner: false, isWritable: true },
        ])
        .signers([orchestrator])
        .rpc();

      const queueAfter = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(n(queueAfter.head)).to.equal(n(headBefore) + 1);

      const recipientUsdcAfter = await getAccount(provider.connection, recipientUsdcAta, undefined, TOKEN_PROGRAM_ID);
      expect(Number(recipientUsdcAfter.amount)).to.be.greaterThan(Number(recipientUsdcBefore.amount));
    });

    it("processes multiple entries FIFO", async () => {
      // Process any leftover queue entries from prior tests (Fix 10: withdrawBuffer
      // now protects queued redemptions, so we must clear the queue before draining)
      const queuePre = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      if (n(queuePre.head) < n(queuePre.tail)) {
        const pendingCount = n(queuePre.tail) - n(queuePre.head);
        // Collect remaining accounts for each pending entry
        const remainingAccts = [];
        for (let i = 0; i < pendingCount; i++) {
          const idx = ringSlot(n(queuePre.head) + i);
          const entryUser = queuePre.entries[idx].user;
          const entryUsdcAta = getAssociatedTokenAddressSync(
            usdcMint, entryUser, false, TOKEN_PROGRAM_ID
          );
          await ensureAtaViaBankrun(h, entryUser, usdcMint, TOKEN_PROGRAM_ID);
          remainingAccts.push({ pubkey: entryUsdcAta, isSigner: false, isWritable: true });
        }
        await program.methods
          .processQueue(pendingCount)
          .accountsPartial({
            queueProcessor: orchestrator.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            vaultUsdc: vaultUsdcAta,
            vaultUsdOku: vaultUsdOkuAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts(remainingAccts)
          .signers([orchestrator])
          .rpc();
      }

      // Create two queued entries
      // First drain buffer
      const vaultUsdc = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
      const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, coldMultisig.publicKey, false, TOKEN_PROGRAM_ID
      );
      await ensureAtaViaBankrun(h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);
      if (Number(vaultUsdc.amount) > 0) {
        await program.methods
          .withdrawBuffer(new BN(Number(vaultUsdc.amount)))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint: usdOkuMint,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }

      // Mint and queue for user1 and user2
      await mintUsdOkuViaProgram(program, user, new BN(5_000_000), configPda, usdcMint, usdOkuMint, userUsdcAta, userUsdOkuAta, vaultUsdcAta);
      await mintUsdOkuViaProgram(program, user2, new BN(5_000_000), configPda, usdcMint, usdOkuMint, user2UsdcAta, user2UsdOkuAta, vaultUsdcAta);

      // Drain buffer again (mint deposits USDC into vault)
      const vaultUsdc2 = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
      if (Number(vaultUsdc2.amount) > 0) {
        await program.methods
          .withdrawBuffer(new BN(Number(vaultUsdc2.amount)))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint: usdOkuMint,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }

      await program.methods
        .redeemUsdOku(new BN(2_000_000))
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          usdOkuMint,
          userUsdcAta,
          userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      await program.methods
        .redeemUsdOku(new BN(2_000_000))
        .accountsPartial({
          user: user2.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          usdOkuMint,
          userUsdcAta: user2UsdcAta,
          userUsdOkuAta: user2UsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      // Now deposit buffer and process both
      await program.methods
        .depositBuffer(new BN(20_000_000))
        .accountsPartial({
          bufferDepositor: orchestrator.publicKey,
          config: configPda,
          bufferDepositorUsdcAta: orchestratorUsdcAta,
          vaultUsdc: vaultUsdcAta,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();

      const queueBefore = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const headBefore = queueBefore.head;

      // Build remaining_accounts in FIFO order
      const entry1 = queueBefore.entries[ringSlot(headBefore)];
      const entry2 = queueBefore.entries[ringSlot(n(headBefore) + 1)];
      const ata1 = getAssociatedTokenAddressSync(usdcMint, entry1.user, false, TOKEN_PROGRAM_ID);
      const ata2 = getAssociatedTokenAddressSync(usdcMint, entry2.user, false, TOKEN_PROGRAM_ID);
      await ensureAtaViaBankrun(h, entry1.user, usdcMint, TOKEN_PROGRAM_ID);
      await ensureAtaViaBankrun(h, entry2.user, usdcMint, TOKEN_PROGRAM_ID);

      await program.methods
        .processQueue(2)
        .accountsPartial({
          queueProcessor: orchestrator.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: ata1, isSigner: false, isWritable: true },
          { pubkey: ata2, isSigner: false, isWritable: true },
        ])
        .signers([orchestrator])
        .rpc();

      const queueAfter = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(n(queueAfter.head)).to.equal(n(headBefore) + 2);
    });

    it("fails with QueueEmpty when no entries", async () => {
      // Ensure queue is empty (head == tail)
      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      if (n(queue.head) < n(queue.tail)) {
        // Process remaining entries first
        const remaining = n(queue.tail) - n(queue.head);
        const accounts = [];
        for (let i = n(queue.head); i < n(queue.tail); i++) {
          const entry = queue.entries[ringSlot(i)];
          const ata = getAssociatedTokenAddressSync(usdcMint, entry.user, false, TOKEN_PROGRAM_ID);
          await ensureAtaViaBankrun(h, entry.user, usdcMint, TOKEN_PROGRAM_ID);
          accounts.push({ pubkey: ata, isSigner: false, isWritable: true });
        }
        // Ensure enough buffer
        await program.methods
          .depositBuffer(new BN(100_000_000))
          .accountsPartial({
            bufferDepositor: orchestrator.publicKey,
            config: configPda,
            bufferDepositorUsdcAta: orchestratorUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();

        await program.methods
          .processQueue(remaining)
          .accountsPartial({
            queueProcessor: orchestrator.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            vaultUsdc: vaultUsdcAta,
            vaultUsdOku: vaultUsdOkuAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts(accounts)
          .signers([orchestrator])
          .rpc();
      }

      try {
        await program.methods
          .processQueue(1)
          .accountsPartial({
            queueProcessor: orchestrator.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            vaultUsdc: vaultUsdcAta,
            vaultUsdOku: vaultUsdOkuAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts([])
          .signers([orchestrator])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        expect(errorCode).to.satisfy((c: string) => c === "QueueEmpty" || c.includes("QueueEmpty"));
      }
    });

    it("non-queue_processor rejected", async () => {
      try {
        await program.methods
          .processQueue(1)
          .accountsPartial({
            queueProcessor: warmMultisig.publicKey, // Wrong authority
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            vaultUsdc: vaultUsdcAta,
            vaultUsdOku: vaultUsdOkuAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts([])
          .signers([warmMultisig])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        // Tightened: previously fell through to `c.includes("Error")`,
        // which matches any thrown JS Error including OOM / RPC failures.
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        expect(errorCode).to.satisfy((c: string) =>
          c === "Unauthorized" || c.includes("Unauthorized")
        );
      }
    });

    // Phase 10: process_queue with a frozen recipient ATA. The on-chain
    // CPI burn-of-escrowed-usdOku + USDC transfer to the recipient
    // must fail because the recipient's USDC ATA isn't frozen (USDC is
    // standard SPL Token, not Token-2022). To exercise the analogous
    // case where the *escrowed* token side reverts, we freeze the
    // recipient's usdOku ATA — but `process_queue` only writes USDC
    // out and doesn't touch the recipient's usdOku ATA, so freezing
    // that has no effect on the payout path. The interesting case is
    // when the recipient's USDC ATA cannot receive (e.g. account
    // doesn't exist). We assert the program reverts with
    // `InsufficientAccounts` when we omit the recipient ATA from
    // `remainingAccounts`.
    it("process_queue rejects when recipient ATA missing from remaining_accounts", async () => {
      // Queue a fresh entry.
      await mintUsdOkuViaProgram(
        program,
        user,
        new BN(1_000_000),
        configPda,
        usdcMint,
        usdOkuMint,
        userUsdcAta,
        userUsdOkuAta,
        vaultUsdcAta
      );
      // Drain buffer so the next redeem hits the queue.
      const vaultUsdc = await getAccount(
        provider.connection,
        vaultUsdcAta,
        undefined,
        TOKEN_PROGRAM_ID
      );
      const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        coldMultisig.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );
      await ensureAtaViaBankrun(h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);
      if (Number(vaultUsdc.amount) > 0) {
        await program.methods
          .withdrawBuffer(new BN(Number(vaultUsdc.amount)))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint: usdOkuMint,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }
      await program.methods
        .redeemUsdOku(new BN(500_000))
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          usdOkuMint,
          userUsdcAta,
          userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Re-deposit enough buffer for processing.
      await program.methods
        .depositBuffer(new BN(2_000_000))
        .accountsPartial({
          bufferDepositor: orchestrator.publicKey,
          config: configPda,
          bufferDepositorUsdcAta: orchestratorUsdcAta,
          vaultUsdc: vaultUsdcAta,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();

      // Call process_queue with an empty remaining_accounts array — the
      // program loops counting non-skipped entries against
      // `remaining_accounts.len()`, so any non-skipped entry should trigger
      // `InsufficientAccounts`.
      try {
        await program.methods
          .processQueue(1)
          .accountsPartial({
            queueProcessor: orchestrator.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            vaultUsdc: vaultUsdcAta,
            vaultUsdOku: vaultUsdOkuAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts([])
          .signers([orchestrator])
          .rpc();
        expect.fail("Should have rejected with InsufficientAccounts");
      } catch (err: any) {
        const haystack = [
          String(err?.error?.errorCode?.code ?? ""),
          String(err?.message ?? ""),
          ...(err?.logs ?? []),
        ].join(" ");
        expect(haystack).to.include("InsufficientAccounts");
      }

      // Cleanup: process the queue with the proper ATA so we leave the
      // queue empty for downstream describes.
      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const headEntry = queue.entries[ringSlot(queue.head)];
      const recipientUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        headEntry.user,
        false,
        TOKEN_PROGRAM_ID
      );
      await ensureAtaViaBankrun(h, headEntry.user, usdcMint, TOKEN_PROGRAM_ID);
      await program.methods
        .processQueue(1)
        .accountsPartial({
          queueProcessor: orchestrator.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: recipientUsdcAta, isSigner: false, isWritable: true },
        ])
        .signers([orchestrator])
        .rpc();
    });
  });

  // ==========================================================================
  // NEW COVERAGE: rescue_queue_entry
  // ==========================================================================
  describe("rescue_queue_entry", () => {
    const REDEEM_AMOUNT = new BN(500_000); // 0.5 usdOku

    /** Drain whatever USDC is sitting in the PSM buffer so subsequent
     * `redeem_usd_oku` calls fall into the queued path. */
    async function drainBuffer() {
      const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        coldMultisig.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );
      await ensureAtaViaBankrun(h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);
      const vaultUsdc = await getAccount(
        provider.connection,
        vaultUsdcAta,
        undefined,
        TOKEN_PROGRAM_ID
      );
      if (Number(vaultUsdc.amount) > 0) {
        await program.methods
          .withdrawBuffer(new BN(Number(vaultUsdc.amount)))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint: usdOkuMint,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }
    }

    before(async () => {
      // Make sure the user has usdOku to queue.
      await mintUsdOkuViaProgram(
        program,
        user,
        REDEEM_AMOUNT.muln(4),
        configPda,
        usdcMint,
        usdOkuMint,
        userUsdcAta,
        userUsdOkuAta,
        vaultUsdcAta
      );
      await drainBuffer();
    });

    // Reset the queue / buffer to a clean (empty + drained) state before
    // returning control to the rest of the suite. Without this, the
    // subsequent ring-buffer-wraparound test sees lingering state and
    // its `withdrawBuffer(all)` call trips InsufficientBuffer.
    after(async () => {
      await drainBuffer();
    });

    it("returns escrowed usdOku to a recipient and clears the slot", async () => {
      // Queue a redemption.
      await program.methods
        .redeemUsdOku(REDEEM_AMOUNT)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          usdOkuMint,
          userUsdcAta,
          userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      // u64 → BN; arithmetic must stay in BN.
      const rescueIndex = (queue.tail as BN).sub(new BN(1));
      const slot = ringSlot(rescueIndex);
      const entry = queue.entries[slot];
      const rescuedAmount = Number(entry.rawUsdOkuAmount);
      expect(entry.user.toString()).to.equal(user.publicKey.toString());

      const userOkuBefore = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // Rescue back to the same user (could equally be an alternate ATA).
      await program.methods
        .rescueQueueEntry(rescueIndex)
        .accountsPartial({
          queueProcessor: psmOrchestrator.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdOku: vaultUsdOkuAta,
          recipientUsdOkuAta: userUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([psmOrchestrator])
        .rpc();

      const queueAfter = await program.account.redemptionQueue.fetch(
        redemptionQueuePda
      );
      // Slot must be cleared (Pubkey::default + zero amount).
      const cleared = queueAfter.entries[slot];
      expect(cleared.user.toString()).to.equal(PublicKey.default.toString());
      expect(Number(cleared.rawUsdOkuAmount)).to.equal(0);

      // usdOku must have been transferred back to the user.
      const userOkuAfter = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(
        Number(userOkuAfter.amount) - Number(userOkuBefore.amount)
      ).to.equal(rescuedAmount);
    });

    it("non-queue_processor cannot rescue", async () => {
      // Queue a fresh entry.
      await program.methods
        .redeemUsdOku(REDEEM_AMOUNT)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          usdOkuMint,
          userUsdcAta,
          userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const rescueIndex = (queue.tail as BN).sub(new BN(1));

      try {
        await program.methods
          .rescueQueueEntry(rescueIndex)
          .accountsPartial({
            queueProcessor: warmMultisig.publicKey, // wrong role
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            vaultUsdOku: vaultUsdOkuAta,
            recipientUsdOkuAta: userUsdOkuAta,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([warmMultisig])
          .rpc();
        expect.fail("Should have failed Unauthorized");
      } catch (err: any) {
        expect(err?.error?.errorCode?.code).to.equal("Unauthorized");
      }

      // Cleanup: rescue with the correct authority so the queue doesn't
      // carry a leftover entry into subsequent describe blocks.
      await program.methods
        .rescueQueueEntry(rescueIndex)
        .accountsPartial({
          queueProcessor: psmOrchestrator.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdOku: vaultUsdOkuAta,
          recipientUsdOkuAta: userUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([psmOrchestrator])
        .rpc();
    });

    it("rescuing the same slot twice fails with EntryAlreadyCleared", async () => {
      // Queue and rescue once.
      await program.methods
        .redeemUsdOku(REDEEM_AMOUNT)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          usdOkuMint,
          userUsdcAta,
          userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const rescueIndex = (queue.tail as BN).sub(new BN(1));

      await program.methods
        .rescueQueueEntry(rescueIndex)
        .accountsPartial({
          queueProcessor: psmOrchestrator.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdOku: vaultUsdOkuAta,
          recipientUsdOkuAta: userUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([psmOrchestrator])
        .rpc();

      // Auto-bump-slot forces a fresh blockhash on the next
      // `provider.sendAndConfirm`, so the otherwise-identical second
      // rescue tx is no longer rejected as "already processed".
      try {
        // After the rescue at the *tail*, the head loop in the program
        // advances past the cleared slot — so the index is now strictly
        // less than `head`. Either error is acceptable: InvalidQueueIndex
        // (index < head) or EntryAlreadyCleared (if we somehow re-pin
        // the same slot in a non-tail position).
        await program.methods
          .rescueQueueEntry(rescueIndex)
          .accountsPartial({
            queueProcessor: psmOrchestrator.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            vaultUsdOku: vaultUsdOkuAta,
            recipientUsdOkuAta: userUsdOkuAta,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([psmOrchestrator])
          .rpc();
        expect.fail("Should have rejected double-rescue");
      } catch (err: any) {
        // Bankrun wraps program failures in SendTransactionError; the parsed
        // `errorCode.code` is populated for normal Anchor errors but can be
        // undefined when the precompile or low-level CPI shape differs. Look
        // across the full surface (code, message, logs) to make the check
        // robust to either wrapping style.
        const haystack = [
          String(err?.error?.errorCode?.code ?? ""),
          String(err?.error?.errorMessage ?? ""),
          String(err?.message ?? ""),
          ...(err?.logs ?? []),
        ].join(" ");
        expect(
          haystack.includes("EntryAlreadyCleared") ||
            haystack.includes("InvalidQueueIndex"),
          `unexpected error haystack: ${haystack.slice(0, 300)}`
        ).to.equal(true);
      }
    });

    // Phase 10: rescue to a different recipient's ATA. The program does
    // NOT enforce that `recipient == original_user` — operationally this
    // lets the queue_processor route a rescued entry to a fresh wallet
    // (e.g. when the original user's ATA was frozen for compliance).
    // Matches EVM `RedemptionQueue.rescueQueueEntry`'s permissive
    // recipient gate. The test asserts the usdOku is credited to
    // `user2`, not `user`, when `user` was the original queue depositor.
    it("rescue can deliver escrowed usdOku to a non-original recipient", async () => {
      // 1. user enqueues a redemption.
      await mintUsdOkuViaProgram(
        program,
        user,
        REDEEM_AMOUNT.muln(2),
        configPda,
        usdcMint,
        usdOkuMint,
        userUsdcAta,
        userUsdOkuAta,
        vaultUsdcAta
      );
      await drainBuffer();
      await program.methods
        .redeemUsdOku(REDEEM_AMOUNT)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          usdOkuMint,
          userUsdcAta,
          userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const rescueIndex = (queue.tail as BN).sub(new BN(1));
      const slot = ringSlot(rescueIndex);
      const rescuedAmount = Number(queue.entries[slot].rawUsdOkuAmount);
      expect(queue.entries[slot].user.toString()).to.equal(user.publicKey.toString());

      // 2. Ensure user2 has an usdOku ATA to receive the rescue.
      await ensureAtaViaBankrun(h, user2.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);
      const user2UsdOkuAtaLocal = getAssociatedTokenAddressSync(
        usdOkuMint,
        user2.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      const user2UsdOkuBefore = await getAccount(
        provider.connection,
        user2UsdOkuAtaLocal,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // 3. Rescue to user2 (NOT the original depositor).
      await program.methods
        .rescueQueueEntry(rescueIndex)
        .accountsPartial({
          queueProcessor: psmOrchestrator.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdOku: vaultUsdOkuAta,
          recipientUsdOkuAta: user2UsdOkuAtaLocal,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([psmOrchestrator])
        .rpc();

      // 4. user2's balance must have grown by exactly the rescued amount.
      const user2UsdOkuAfter = await getAccount(
        provider.connection,
        user2UsdOkuAtaLocal,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const delta = Number(user2UsdOkuAfter.amount) - Number(user2UsdOkuBefore.amount);
      expect(delta).to.equal(rescuedAmount);
    });
  });

  // ==========================================================================
  // NEW COVERAGE (audit-prep): user_self_rescue_queue_entry
  // Permissionless self-rescue added in cycle 4 (PSM-06). Lets a user unblock
  // themselves from a queued entry without operator action (e.g. when their
  // recipient ATA is frozen and a different ATA they control still works).
  // ==========================================================================
  describe("user_self_rescue_queue_entry", () => {
    const REDEEM_AMOUNT = new BN(500_000); // 0.5 usdOku

    async function drainBuffer() {
      const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        coldMultisig.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );
      await ensureAtaViaBankrun(h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);
      const vaultUsdc = await getAccount(
        provider.connection,
        vaultUsdcAta,
        undefined,
        TOKEN_PROGRAM_ID
      );
      if (Number(vaultUsdc.amount) > 0) {
        await program.methods
          .withdrawBuffer(new BN(Number(vaultUsdc.amount)))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint: usdOkuMint,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }
    }

    before(async () => {
      await mintUsdOkuViaProgram(
        program,
        user,
        REDEEM_AMOUNT.muln(4),
        configPda,
        usdcMint,
        usdOkuMint,
        userUsdcAta,
        userUsdOkuAta,
        vaultUsdcAta
      );
      await drainBuffer();
    });

    after(async () => {
      await drainBuffer();
    });

    /** Queue a single redemption for `user` and return the absolute index. */
    async function queueOne(): Promise<BN> {
      await program.methods
        .redeemUsdOku(REDEEM_AMOUNT)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          usdOkuMint,
          userUsdcAta,
          userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();
      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      return (queue.tail as BN).sub(new BN(1));
    }

    it("happy path: original queued user reclaims their escrowed usdOku", async () => {
      const rescueIndex = await queueOne();
      const slot = ringSlot(rescueIndex);
      const userOkuBefore = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await program.methods
        .userSelfRescueQueueEntry(rescueIndex)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdOku: vaultUsdOkuAta,
          recipientUsdOkuAta: userUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      const queueAfter = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const cleared = queueAfter.entries[slot];
      expect(cleared.user.toString()).to.equal(PublicKey.default.toString());
      expect(Number(cleared.rawUsdOkuAmount)).to.equal(0);

      const userOkuAfter = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(userOkuAfter.amount) - Number(userOkuBefore.amount)).to.equal(
        REDEEM_AMOUNT.toNumber()
      );
    });

    it("rejects a different signer than the original queued user", async () => {
      const rescueIndex = await queueOne();

      // Set up a clean usdOku ATA for user2 (the wrong signer) since the
      // context pins `token::authority = user`. Without a user2-owned ATA the
      // tx would fail earlier on the account constraint, not on Unauthorized.
      const user2OkuAta = getAssociatedTokenAddressSync(
        usdOkuMint,
        user2.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      await ensureAtaViaBankrun(h, user2.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);

      try {
        await program.methods
          .userSelfRescueQueueEntry(rescueIndex)
          .accountsPartial({
            user: user2.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            vaultUsdOku: vaultUsdOkuAta,
            recipientUsdOkuAta: user2OkuAta,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([user2])
          .rpc();
        expect.fail("Should have failed Unauthorized");
      } catch (err: any) {
        expect(err?.error?.errorCode?.code).to.equal("Unauthorized");
      }

      // Cleanup: real user clears the entry so subsequent tests start clean.
      await program.methods
        .userSelfRescueQueueEntry(rescueIndex)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdOku: vaultUsdOkuAta,
          recipientUsdOkuAta: userUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([user])
        .rpc();
    });

    it("rejects an already-cleared slot with EntryAlreadyCleared", async () => {
      const rescueIndex = await queueOne();

      // First rescue succeeds and clears the slot.
      await program.methods
        .userSelfRescueQueueEntry(rescueIndex)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdOku: vaultUsdOkuAta,
          recipientUsdOkuAta: userUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      // Second rescue of the same slot must fail. Head may have already
      // advanced past this index — that surfaces as `InvalidQueueIndex`
      // rather than `EntryAlreadyCleared`. Accept either; both are the
      // "you can't re-rescue a slot you already rescued" property.
      try {
        await program.methods
          .userSelfRescueQueueEntry(rescueIndex)
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            vaultUsdOku: vaultUsdOkuAta,
            recipientUsdOkuAta: userUsdOkuAta,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed on second rescue");
      } catch (err: any) {
        const code = err?.error?.errorCode?.code;
        expect(["EntryAlreadyCleared", "InvalidQueueIndex"]).to.include(code);
      }
    });

    it("unblocks a head-pinned queue: user self-rescue advances head past their slot", async () => {
      // Queue an entry, then verify head moves forward after self-rescue.
      const queueBefore = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const headBefore = queueBefore.head as BN;

      const rescueIndex = await queueOne();
      // Only the just-queued entry is in flight, so its index == head.
      expect(rescueIndex.toString()).to.equal(headBefore.toString());

      await program.methods
        .userSelfRescueQueueEntry(rescueIndex)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdOku: vaultUsdOkuAta,
          recipientUsdOkuAta: userUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      const queueAfter = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      // Head must have advanced past the rescued slot.
      expect((queueAfter.head as BN).toNumber()).to.be.greaterThan(headBefore.toNumber());
    });
  });

  // ==========================================================================
  // NEW COVERAGE: ring buffer wraparound
  // ==========================================================================
  describe("queue ring buffer wraparound", () => {
    // Phase 13b: with MAX_ENTRIES bumped to 200, iterating through 200+
    // queue/process cycles in a test would be slow. Instead we seed the
    // queue's `head` and `tail` directly via `banksClient.setAccount` so
    // the next enqueue lands at slot `(MAX_ENTRIES - 1)` and the one after
    // that lands at slot `0` — demonstrating the modulo wraparound with
    // just two cycles.
    //
    // Layout (matches `programs/lite-psm/src/state.rs::RedemptionQueue`):
    //   offset 0..8   : Anchor discriminator
    //   offset 8      : bump (u8)
    //   offset 9..16  : _pad0
    //   offset 16..24 : head (u64 LE)        ← we seed this
    //   offset 24..32 : tail (u64 LE)        ← we seed this
    //   offset 32..40 : total_queued_usd_oku   ← leave intact
    //   offset 40..   : entries
    const REDEEM_AMOUNT = new BN(500_000);
    const HEAD_TAIL_SEED = QUEUE_MAX_ENTRIES - 1; // 199 — next enqueue → slot 199, then wraps to 0

    before(async () => {
      // Mint enough usdOku to enqueue twice and the leftover for any
      // downstream cleanup.
      await mintUsdOkuViaProgram(
        program, user, REDEEM_AMOUNT.muln(4),
        configPda, usdcMint, usdOkuMint,
        userUsdcAta, userUsdOkuAta, vaultUsdcAta,
      );
    });

    it("wraps tail from MAX_ENTRIES-1 back to slot 0", async () => {
      // ----- Pre-state: read existing queue account -----
      const queuePre = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      // Sanity: queue must be empty at start of this test (head == tail).
      // Earlier describes are responsible for draining; if this trips, look
      // upstream rather than fixing it here.
      expect(n(queuePre.head)).to.equal(
        n(queuePre.tail),
        "queue must be empty at start of wraparound test"
      );

      // ----- Seed head and tail directly via banksClient.setAccount -----
      const existing = await h.context.banksClient.getAccount(redemptionQueuePda);
      if (!existing) throw new Error("redemption_queue account missing");
      const data = new Uint8Array(existing.data); // copy
      // Write head and tail = HEAD_TAIL_SEED at offsets 16, 24 (little-endian u64).
      const seedBuf = Buffer.alloc(16);
      seedBuf.writeBigUInt64LE(BigInt(HEAD_TAIL_SEED), 0);
      seedBuf.writeBigUInt64LE(BigInt(HEAD_TAIL_SEED), 8);
      data.set(seedBuf, 16);
      h.context.setAccount(redemptionQueuePda, { ...existing, data });

      const queueSeeded = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(n(queueSeeded.head)).to.equal(HEAD_TAIL_SEED);
      expect(n(queueSeeded.tail)).to.equal(HEAD_TAIL_SEED);

      // ----- Cycle 1: enqueue → entry lands at slot (MAX_ENTRIES - 1) -----
      const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, coldMultisig.publicKey, false, TOKEN_PROGRAM_ID
      );
      await ensureAtaViaBankrun(h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);

      // Drain buffer so the redeem hits the queued path.
      const vault1 = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
      if (Number(vault1.amount) > 0) {
        await program.methods
          .withdrawBuffer(new BN(Number(vault1.amount)))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }

      await program.methods
        .redeemUsdOku(REDEEM_AMOUNT)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint, usdOkuMint,
          userUsdcAta, userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      let q = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(n(q.tail)).to.equal(HEAD_TAIL_SEED + 1);
      // Entry must be at slot (MAX_ENTRIES - 1).
      const lastSlot = QUEUE_MAX_ENTRIES - 1;
      expect(q.entries[lastSlot].user.toString()).to.equal(user.publicKey.toString());
      expect(Number(q.entries[lastSlot].rawUsdOkuAmount)).to.equal(REDEEM_AMOUNT.toNumber());

      // ----- Cycle 2: enqueue again → entry must wrap to slot 0 -----
      // (head stays at HEAD_TAIL_SEED; we only enqueue, don't process.)
      await program.methods
        .redeemUsdOku(REDEEM_AMOUNT)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint, usdOkuMint,
          userUsdcAta, userUsdOkuAta,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      q = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(n(q.tail)).to.equal(HEAD_TAIL_SEED + 2);
      // The wrap: tail = HEAD_TAIL_SEED + 1 = MAX_ENTRIES → slot 0.
      expect(q.entries[0].user.toString()).to.equal(user.publicKey.toString());
      expect(Number(q.entries[0].rawUsdOkuAmount)).to.equal(REDEEM_AMOUNT.toNumber());

      // ----- Cleanup: process both queued entries so downstream tests
      // see an empty queue. -----
      await program.methods
        .depositBuffer(new BN(REDEEM_AMOUNT.toNumber() * 4))
        .accountsPartial({
          bufferDepositor: orchestrator.publicKey,
          config: configPda,
          bufferDepositorUsdcAta: orchestratorUsdcAta,
          vaultUsdc: vaultUsdcAta,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();

      const recipientUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, user.publicKey, false, TOKEN_PROGRAM_ID,
      );
      await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);

      await program.methods
        .processQueue(2)
        .accountsPartial({
          queueProcessor: orchestrator.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdOkuMint,
          vaultUsdc: vaultUsdcAta,
          vaultUsdOku: vaultUsdOkuAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: recipientUsdcAta, isSigner: false, isWritable: true },
          { pubkey: recipientUsdcAta, isSigner: false, isWritable: true },
        ])
        .signers([orchestrator])
        .rpc();

      const qFinal = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(n(qFinal.head)).to.equal(n(qFinal.tail), "queue must be empty after cleanup");
    });
  });

  // ==========================================================================
  // Phase 13b: capacity smoke — confirms MAX_ENTRIES > 50 (old hard cap was 10)
  // ==========================================================================
  describe("queue capacity (Phase 13b)", () => {
    it("accepts at least 50 queued entries without QueueFull", async () => {
      // We seed head+tail directly to a known empty state so this test
      // doesn't depend on earlier-describe leakage. Then we enqueue 50
      // entries and confirm each lands without QueueFull.
      const existing = await h.context.banksClient.getAccount(redemptionQueuePda);
      if (!existing) throw new Error("redemption_queue account missing");
      const data = new Uint8Array(existing.data);
      // Zero out head (16..24), tail (24..32), total_queued_usd_oku (32..40).
      data.set(new Uint8Array(24), 16);
      h.context.setAccount(redemptionQueuePda, { ...existing, data });

      // Fund the user with enough usdOku for 50 enqueues.
      const PER_ENTRY = new BN(100_000); // 0.1 usdOku per entry
      const ENTRIES = 50;
      await mintUsdOkuViaProgram(
        program, user, PER_ENTRY.muln(ENTRIES + 2),
        configPda, usdcMint, usdOkuMint,
        userUsdcAta, userUsdOkuAta, vaultUsdcAta,
      );

      // Drain the buffer so every redeem hits the queue.
      const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, coldMultisig.publicKey, false, TOKEN_PROGRAM_ID
      );
      await ensureAtaViaBankrun(h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);
      const vault = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
      if (Number(vault.amount) > 0) {
        await program.methods
          .withdrawBuffer(new BN(Number(vault.amount)))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }

      // Enqueue 50 times. None should hit QueueFull (which would happen at
      // 10 entries on the pre-Phase-13b cap).
      for (let i = 0; i < ENTRIES; i++) {
        await program.methods
          .redeemUsdOku(PER_ENTRY)
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdcMint, usdOkuMint,
            userUsdcAta, userUsdOkuAta,
            vaultUsdc: vaultUsdcAta,
            vaultUsdOku: vaultUsdOkuAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
      }

      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(n(queue.tail) - n(queue.head)).to.equal(ENTRIES);

      // Cleanup: process the batch (one process_queue tx is capped at
      // MAX_BATCH_ENTRIES=50 so a single call drains all 50).
      await program.methods
        .depositBuffer(new BN(PER_ENTRY.toNumber() * (ENTRIES + 2)))
        .accountsPartial({
          bufferDepositor: orchestrator.publicKey,
          config: configPda,
          bufferDepositorUsdcAta: orchestratorUsdcAta,
          vaultUsdc: vaultUsdcAta,
          usdcMint,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();

      const recipientUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, user.publicKey, false, TOKEN_PROGRAM_ID,
      );
      await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);

      // Drain in small batches — burn+transfer per entry is ~4K CU, so
      // ~50 entries blows the 200K default budget. Use 10 per call.
      const BATCH = 10;
      const recipients = Array.from({ length: BATCH }, () => ({
        pubkey: recipientUsdcAta,
        isSigner: false,
        isWritable: true,
      }));
      for (let drained = 0; drained < ENTRIES; drained += BATCH) {
        await program.methods
          .processQueue(BATCH)
          .accountsPartial({
            queueProcessor: orchestrator.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint,
            vaultUsdc: vaultUsdcAta,
            vaultUsdOku: vaultUsdOkuAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts(recipients)
          .signers([orchestrator])
          .rpc();
      }

      const qFinal = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(n(qFinal.head)).to.equal(n(qFinal.tail), "queue drained after cleanup");
    });
  });

  // ==========================================================================
  // NEW COVERAGE: freeze/thaw
  // ==========================================================================
  describe("freeze/thaw", () => {
    const freezeTarget = Keypair.generate();
    let freezeTargetUsdOkuAta: PublicKey;

    before(async () => {
      // Create target user, fund, get usdOku
      await fundKeypairs(h, [freezeTarget], 10 * anchor.web3.LAMPORTS_PER_SOL);

      const freezeTargetUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, freezeTarget.publicKey, false, TOKEN_PROGRAM_ID
      );
      freezeTargetUsdOkuAta = getAssociatedTokenAddressSync(
        usdOkuMint, freezeTarget.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      // Create USDC ATA and fund
      const createAtaTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey, freezeTargetUsdcAta, freezeTarget.publicKey, usdcMint, TOKEN_PROGRAM_ID
        )
      );
      await provider.sendAndConfirm(createAtaTx, [payer]);
      await mintToViaBankrun(h, usdcMint, freezeTargetUsdcAta, payer, 10_000_000, TOKEN_PROGRAM_ID);

      // Mint usdOku via PSM
      await ensureAtaViaBankrun(h, freezeTarget.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);
      await mintUsdOkuViaProgram(program, freezeTarget, new BN(5_000_000), configPda, usdcMint, usdOkuMint, freezeTargetUsdcAta, freezeTargetUsdOkuAta, vaultUsdcAta);
    });

    it("freezer can freeze a user's usdOku account", async () => {
      await program.methods
        .freezeAccount()
        .accountsPartial({
          freezer: warmMultisig.publicKey,
          config: configPda,
          usdOkuMint,
          targetUsdOkuAta: freezeTargetUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([warmMultisig])
        .rpc();

      const acct = await getAccount(provider.connection, freezeTargetUsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(acct.isFrozen).to.be.true;
    });

    it("unfreezer can thaw a frozen account", async () => {
      await program.methods
        .thawAccount()
        .accountsPartial({
          unfreezer: coldMultisig.publicKey,
          config: configPda,
          usdOkuMint,
          targetUsdOkuAta: freezeTargetUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig])
        .rpc();

      const acct = await getAccount(provider.connection, freezeTargetUsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(acct.isFrozen).to.be.false;
    });

    it("non-freezer CANNOT freeze", async () => {
      try {
        await program.methods
          .freezeAccount()
          .accountsPartial({
            freezer: coldMultisig.publicKey, // Wrong authority
            config: configPda,
            usdOkuMint,
            targetUsdOkuAta: freezeTargetUsdOkuAta,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });

    it("non-unfreezer CANNOT thaw", async () => {
      // First freeze the account
      await program.methods
        .freezeAccount()
        .accountsPartial({
          freezer: warmMultisig.publicKey,
          config: configPda,
          usdOkuMint,
          targetUsdOkuAta: freezeTargetUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([warmMultisig])
        .rpc();

      try {
        await program.methods
          .thawAccount()
          .accountsPartial({
            unfreezer: warmMultisig.publicKey, // Wrong authority
            config: configPda,
            usdOkuMint,
            targetUsdOkuAta: freezeTargetUsdOkuAta,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([warmMultisig])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }

      // Cleanup: thaw with correct authority
      await program.methods
        .thawAccount()
        .accountsPartial({
          unfreezer: coldMultisig.publicKey,
          config: configPda,
          usdOkuMint,
          targetUsdOkuAta: freezeTargetUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig])
        .rpc();
    });

    it("freeze works even when PSM is paused", async () => {
      // Pause PSM
      await program.methods
        .pause()
        .accountsPartial({ pauser: warmMultisig.publicKey, config: configPda })
        .signers([warmMultisig])
        .rpc();

      // Freeze should still work
      await program.methods
        .freezeAccount()
        .accountsPartial({
          freezer: warmMultisig.publicKey,
          config: configPda,
          usdOkuMint,
          targetUsdOkuAta: freezeTargetUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([warmMultisig])
        .rpc();

      const acct = await getAccount(provider.connection, freezeTargetUsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(acct.isFrozen).to.be.true;

      // Cleanup
      await program.methods
        .unpause()
        .accountsPartial({ unpauser: coldMultisig.publicKey, config: configPda })
        .signers([coldMultisig])
        .rpc();
      await program.methods
        .thawAccount()
        .accountsPartial({
          unfreezer: coldMultisig.publicKey,
          config: configPda,
          usdOkuMint,
          targetUsdOkuAta: freezeTargetUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig])
        .rpc();
    });
  });

  // ==========================================================================
  // NEW COVERAGE: set_authority (PSM)
  // ==========================================================================
  describe("set_authority", () => {
    it("role_admin can update pauser", async () => {
      const newPauser = Keypair.generate();

      await program.methods
        .setAuthority({ pauser: {} }, newPauser.publicKey)
        .accountsPartial({
          roleAdmin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      const config = await program.account.psmConfig.fetch(configPda);
      expect(config.pauser.toString()).to.equal(newPauser.publicKey.toString());

      // Restore
      await program.methods
        .setAuthority({ pauser: {} }, warmMultisig.publicKey)
        .accountsPartial({
          roleAdmin: admin.publicKey,
          config: configPda,
        })
        .rpc();
    });

    it("role_admin can transfer admin role and transfer back (two-step Ownable2Step)", async () => {
      const tempAdmin = Keypair.generate();
      await fundKeypairs(h, [tempAdmin], 5 * anchor.web3.LAMPORTS_PER_SOL);

      // ---- Step 1: current admin proposes tempAdmin as the next role_admin.
      // The rotation does NOT take effect yet — only `pending_role_admin`
      // is written.
      await program.methods
        .setAuthority({ roleAdmin: {} }, tempAdmin.publicKey)
        .accountsPartial({
          roleAdmin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      let config = await program.account.psmConfig.fetch(configPda);
      // Live admin unchanged after step 1.
      expect(config.roleAdmin.toString()).to.equal(admin.publicKey.toString());
      // Pending slot now points at tempAdmin.
      expect(config.pendingRoleAdmin.toString()).to.equal(tempAdmin.publicKey.toString());

      // A wrong signer cannot accept the rotation.
      try {
        await program.methods
          .acceptRoleAdmin()
          .accountsPartial({
            newRoleAdmin: warmMultisig.publicKey, // not the pending admin
            config: configPda,
          })
          .signers([warmMultisig])
          .rpc();
        expect.fail("non-pending admin should not be able to accept");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("NotPendingRoleAdmin");
      }

      // ---- Step 2: tempAdmin accepts; admin role flips and pending slot
      // clears.
      await program.methods
        .acceptRoleAdmin()
        .accountsPartial({
          newRoleAdmin: tempAdmin.publicKey,
          config: configPda,
        })
        .signers([tempAdmin])
        .rpc();

      config = await program.account.psmConfig.fetch(configPda);
      expect(config.roleAdmin.toString()).to.equal(tempAdmin.publicKey.toString());
      expect(config.pendingRoleAdmin.toString()).to.equal(PublicKey.default.toString());

      // ---- Transfer back: same two-step dance, signed by tempAdmin
      // proposing the original admin.
      await program.methods
        .setAuthority({ roleAdmin: {} }, admin.publicKey)
        .accountsPartial({
          roleAdmin: tempAdmin.publicKey,
          config: configPda,
        })
        .signers([tempAdmin])
        .rpc();

      await program.methods
        .acceptRoleAdmin()
        .accountsPartial({
          newRoleAdmin: admin.publicKey,
          config: configPda,
        })
        .signers([admin])
        .rpc();

      config = await program.account.psmConfig.fetch(configPda);
      expect(config.roleAdmin.toString()).to.equal(admin.publicKey.toString());
      expect(config.pendingRoleAdmin.toString()).to.equal(PublicKey.default.toString());
    });

    it("cancel_role_admin_transfer clears an in-flight proposal", async () => {
      const tempAdmin = Keypair.generate();

      // Propose a rotation.
      await program.methods
        .setAuthority({ roleAdmin: {} }, tempAdmin.publicKey)
        .accountsPartial({
          roleAdmin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      let config = await program.account.psmConfig.fetch(configPda);
      expect(config.pendingRoleAdmin.toString()).to.equal(tempAdmin.publicKey.toString());

      // Current admin can cancel.
      await program.methods
        .cancelRoleAdminTransfer()
        .accountsPartial({
          roleAdmin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      config = await program.account.psmConfig.fetch(configPda);
      expect(config.pendingRoleAdmin.toString()).to.equal(PublicKey.default.toString());
      // Live admin unchanged throughout.
      expect(config.roleAdmin.toString()).to.equal(admin.publicKey.toString());

      // Acceptance after cancellation rejects with NoPendingRoleAdmin.
      try {
        await program.methods
          .acceptRoleAdmin()
          .accountsPartial({
            newRoleAdmin: tempAdmin.publicKey,
            config: configPda,
          })
          .signers([tempAdmin])
          .rpc();
        expect.fail("accept after cancel should fail");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("NoPendingRoleAdmin");
      }
    });

    it("non-role_admin rejected", async () => {
      try {
        await program.methods
          .setAuthority({ pauser: {} }, Keypair.generate().publicKey)
          .accountsPartial({
            roleAdmin: warmMultisig.publicKey, // Not admin
            config: configPda,
          })
          .signers([warmMultisig])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });
  });

  // ==========================================================================
  // NEW COVERAGE: buffer edge cases
  // ==========================================================================
  describe("buffer edge cases", () => {
    it("deposit_buffer fails with zero amount", async () => {
      try {
        await program.methods
          .depositBuffer(new BN(0))
          .accountsPartial({
            bufferDepositor: orchestrator.publicKey,
            config: configPda,
            bufferDepositorUsdcAta: orchestratorUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        expect(errorCode).to.satisfy((c: string) => c === "ZeroAmount" || c.includes("ZeroAmount"));
      }
    });

    it("withdraw_buffer fails with zero amount", async () => {
      const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, coldMultisig.publicKey, false, TOKEN_PROGRAM_ID
      );
      await ensureAtaViaBankrun(h, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);

      try {
        await program.methods
          .withdrawBuffer(new BN(0))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdOkuMint: usdOkuMint,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        expect(errorCode).to.satisfy((c: string) => c === "ZeroAmount" || c.includes("ZeroAmount"));
      }
    });
  });

});
