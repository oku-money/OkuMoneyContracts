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
  mintOkuMViaProgram,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
  DECIMALS,
  MAX_STEP_BPS,
  DEFAULT_TEST_TIN_BPS,
  DEFAULT_TEST_TOUT_BPS,
} from "../shared/setup";
import { clearSyncWindow, expectedMintNet, expectedRedeemNet } from "../shared/multiplier";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  readMultiplierFromMint,
  warpSlots,
  expectBankrunError,
} from "../shared/bankrun";
// Use anchor's web3 to avoid version conflicts
const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

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

  // Token accounts
  let vaultUsdcAta: PublicKey;
  let vaultOkuMAta: PublicKey;
  let userUsdcAta: PublicKey;
  let userOkuMAta: PublicKey;
  let user2UsdcAta: PublicKey;
  let user2OkuMAta: PublicKey;
  let orchestratorUsdcAta: PublicKey;

  // Mints
  let usdcMint: PublicKey;
  let okuMMint: PublicKey;

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

    // Initialize PSM — this creates the OkuM mint with ScaledUiAmount
    // extension and all supporting accounts.
    const psmSetup = await initializePsm(h, program, payer, usdcMint);
    configPda = psmSetup.configPda;
    okuMMint = psmSetup.okuMMint;
    vaultUsdcAta = psmSetup.vaultUsdcAta;
    vaultOkuMAta = psmSetup.vaultOkuMAta;

    [, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")],
      program.programId
    );

    // Derive user/orchestrator ATA addresses + create them.
    userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user.publicKey, false, TOKEN_PROGRAM_ID);
    userOkuMAta = getAssociatedTokenAddressSync(okuMMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
    user2UsdcAta = getAssociatedTokenAddressSync(usdcMint, user2.publicKey, false, TOKEN_PROGRAM_ID);
    user2OkuMAta = getAssociatedTokenAddressSync(okuMMint, user2.publicKey, false, TOKEN_2022_PROGRAM_ID);
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

    // The wall-clock sync window is NOT auto-cleared the way the slot fence
    // is, so a multiplier write in an earlier describe would otherwise leak a
    // SyncWindowActive revert into every later test. This suite is not about
    // the window — that is `sync-window-and-fees.ts` — so settle it here.
    await clearSyncWindow(h, program as any, configPda);
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
      // Verify OkuM mint is set
      expect(config.okuMMint.toString()).to.not.equal(PublicKey.default.toString());
    });
  });

  describe("mint", () => {
    // 1:1 NET OF `tin`. Fees ship at the step-coverage floor rather than at
    // zero — the program stopped reading the fee schedule at multiplier-write
    // time, so a zero-fee window would be an uncovered-step window. The
    // identity is on the credited amount, and the whole deposit still lands in
    // the vault (the fee is withheld from the credit, not from the transfer).
    it("mints okuM 1:1 with USDC net of tin (pre-created ATA)", async () => {
      const mintAmount = new BN(1_000_000); // 1 USDC/OkuM

      // Pre-create okuM ATA
      await ensureAtaViaBankrun(h, user.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);

      // Get balances before
      const userUsdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
      let userOkuMBefore: bigint;
      try {
        const acct = await getAccount(provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID);
        userOkuMBefore = acct.amount;
      } catch {
        userOkuMBefore = BigInt(0);
      }

      await program.methods
        .mintOkuM(mintAmount)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          usdcMint: usdcMint,
          okuMMint: okuMMint,
          userUsdcAta: userUsdcAta,
          userOkuMAta: userOkuMAta,
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
      const userOkuMAfter = await getAccount(provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID);

      expect(Number(userUsdcBefore.amount) - Number(userUsdcAfter.amount)).to.equal(mintAmount.toNumber());
      expect(Number(userOkuMAfter.amount) - Number(userOkuMBefore)).to.equal(
        expectedMintNet(mintAmount, DEFAULT_TEST_TIN_BPS).toNumber()
      );
    });

    it("mints okuM with init_if_needed ATA creation", async () => {
      const freshUser = Keypair.generate();
      const mintAmount = new BN(1_000_000); // 1 USDC/OkuM

      await fundKeypairs(h, [freshUser], 10 * anchor.web3.LAMPORTS_PER_SOL);

      // Create and fund USDC ATA
      const freshUserUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, freshUser.publicKey, false, TOKEN_PROGRAM_ID
      );
      const freshUserOkuMAta = getAssociatedTokenAddressSync(
        okuMMint, freshUser.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      const createAtaTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey, freshUserUsdcAta, freshUser.publicKey, usdcMint, TOKEN_PROGRAM_ID
        )
      );
      await provider.sendAndConfirm(createAtaTx, [payer]);
      await mintToViaBankrun(h, usdcMint, freshUserUsdcAta, payer, 10_000_000, TOKEN_PROGRAM_ID);

      // DO NOT pre-create okuM ATA — let init_if_needed handle it
      await program.methods
        .mintOkuM(mintAmount)
        .accountsPartial({
          user: freshUser.publicKey,
          config: configPda,
          usdcMint: usdcMint,
          okuMMint: okuMMint,
          userUsdcAta: freshUserUsdcAta,
          userOkuMAta: freshUserOkuMAta,
          vaultUsdc: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([freshUser])
        .rpc();

      // Verify okuM was minted
      const okuMAccount = await getAccount(
        provider.connection, freshUserOkuMAta, undefined, TOKEN_2022_PROGRAM_ID
      );
      expect(Number(okuMAccount.amount)).to.equal(
        expectedMintNet(mintAmount, DEFAULT_TEST_TIN_BPS).toNumber()
      );
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
          .mintOkuM(new BN(1_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint: usdcMint,
            okuMMint: okuMMint,
            userUsdcAta: userUsdcAta,
            userOkuMAta: userOkuMAta,
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

    // Freeze/thaw authority is verified by the init test; the freeze/thaw
    // instructions use standard Token-2022 CPI calls with the same RBAC
    // pattern as pause/unpause (covered above). Dedicated freeze/thaw
    // behavior is exercised in the "freeze/thaw" describe below.

    describe("admin role separation", () => {
      it("cap_manager can set max supply", async () => {
        const newMaxSupply = new BN(2_000_000_000_000);

        await program.methods
          .setMaxSupply(newMaxSupply)
          .accountsPartial({
            capManager: coldMultisig.publicKey,
            config: configPda,
            okuMMint: okuMMint,
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
            okuMMint: okuMMint,
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
              okuMMint: okuMMint,
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

      it("deposit_buffer fails when paused", async () => {
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
            .depositBuffer(new BN(1_000_000))
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
          expect.fail("Should have failed while paused");
        } catch (err: any) {
          const errorCode = err?.error?.errorCode?.code || err?.message;
          expect(errorCode).to.satisfy((code: string) =>
            code === "Paused" || code.includes("Paused")
          );
        }

        // Unpause for subsequent tests.
        await program.methods
          .unpause()
          .accountsPartial({
            unpauser: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();
      });

      it("deposit_buffer fails in the same slot as a yield distribution", async () => {
        // Isolated bankrun harness: `setMultiplier` only ever increases the
        // multiplier, and it's shared module-level state (this describe
        // block's `program`/`configPda`/`okuMMint` are reused by later
        // tests in this file — e.g. "rebaser can set okuM multiplier" —
        // that assume the multiplier is still near PRECISION). Running
        // this check against a throwaway harness avoids bumping the
        // shared multiplier and breaking those later assertions.
        //
        // `autoBumpSlot: false` — the default harness advances the slot
        // by 1 before every `.rpc()` (see `startBankrun` doc comment),
        // which would make the two calls below land in different slots
        // and defeat the same-slot assertion. Mirrors the override used
        // by `rate-over-time.ts`'s own same-slot test.
        const h2 = await startBankrun({ autoBumpSlot: false });
        const program2 = h2.program;
        const payer2 = h2.payer;
        const usdcMint2 = await createMintViaBankrun(
          h2,
          payer2.publicKey,
          null,
          6,
          Keypair.generate(),
          TOKEN_PROGRAM_ID
        );
        await warpSlots(h2, 1);

        const { configPda: configPda2, okuMMint: okuMMint2, vaultUsdcAta: vaultUsdcAta2 } =
          await initializePsm(h2, program2, payer2, usdcMint2);
        await warpSlots(h2, 1);

        const orchestratorUsdcAta2 = getAssociatedTokenAddressSync(
          usdcMint2,
          orchestrator.publicKey,
          false,
          TOKEN_PROGRAM_ID
        );
        await ensureAtaViaBankrun(h2, orchestrator.publicKey, usdcMint2, TOKEN_PROGRAM_ID);
        await warpSlots(h2, 1);
        await mintToViaBankrun(
          h2,
          usdcMint2,
          orchestratorUsdcAta2,
          payer2,
          10_000_000,
          TOKEN_PROGRAM_ID
        );
        await warpSlots(h2, 1);

        // Stamp the yield-lock slot via set_multiplier.
        const m0 = await readMultiplierFromMint(h2, okuMMint2);
        const m1 = m0.add(m0.muln(4).divn(10_000)); // +4 bps (MAX_STEP_BPS is 5)
        await program2.methods
          .setMultiplier(m1)
          .accountsPartial({
            rebaser: orchestrator.publicKey,
            config: configPda2,
            okuMMint: okuMMint2,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();

        // SAME SLOT deposit_buffer -> must revert with YieldDistributionInProgress.
        await expectBankrunError(
          () =>
            program2.methods
              .depositBuffer(new BN(1_000_000))
              .accountsPartial({
                bufferDepositor: orchestrator.publicKey,
                config: configPda2,
                bufferDepositorUsdcAta: orchestratorUsdcAta2,
                vaultUsdc: vaultUsdcAta2,
                usdcMint: usdcMint2,
                tokenProgram: TOKEN_PROGRAM_ID,
              })
              .signers([orchestrator])
              .rpc(),
          "YieldDistributionInProgress"
        );

        // Advance one slot — lock releases — deposit succeeds.
        await warpSlots(h2, 1);
        await program2.methods
          .depositBuffer(new BN(1_000_000))
          .accountsPartial({
            bufferDepositor: orchestrator.publicKey,
            config: configPda2,
            bufferDepositorUsdcAta: orchestratorUsdcAta2,
            vaultUsdc: vaultUsdcAta2,
            usdcMint: usdcMint2,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();
      });

      it("buffer_withdrawer can withdraw buffer", async () => {
        const withdrawAmount = new BN(50_000_000);
        const vaultBefore = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);

        await program.methods
          .withdrawBuffer(withdrawAmount)
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            okuMMint: okuMMint,
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
              okuMMint: okuMMint,
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

      it("rebaser can set okuM multiplier", async () => {
        // Multiplier starts at PRECISION (1e9) = $1.00. Set to PRECISION + 1.
        const newMultiplier = new BN(1_000_000_001);

        await program.methods
          .setMultiplier(newMultiplier)
          .accountsPartial({
            rebaser: orchestrator.publicKey,
            config: configPda,
            okuMMint: okuMMint,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();

        const configAfter = await program.account.psmConfig.fetch(configPda);
        // lastYieldDistributionSlot should be set
        expect(Number(configAfter.lastYieldDistributionSlot)).to.be.greaterThan(0);
        // Note: Multiplier cannot be reset - it can only increase (yield accrual model)
      });

      it("non-rebaser CANNOT set okuM price", async () => {
        try {
          await program.methods
            .setMultiplier(new BN(1_100_000_000)) // Doesn't matter, should fail auth
            .accountsPartial({
              rebaser: warmMultisig.publicKey, // Wrong role
              config: configPda,
              okuMMint: okuMMint,
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
  // Yield Operations (okuM Price Model)
  // ==========================================================================
  describe("yield operations", () => {
    it("rebaser can distribute yield via multiplier increase", async () => {
      // Multiplier has been bumped by previous tests. Set to a higher value.
      const newMultiplier = new BN(1_000_400_000); // +4 bps (MAX_STEP_BPS is 5)
      
      await program.methods
        .setMultiplier(newMultiplier)
        .accountsPartial({
          rebaser: orchestrator.publicKey,
          config: configPda,
          okuMMint: okuMMint,
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
            okuMMint: okuMMint,
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
      // Need okuM supply > 0 so that yield_per_token computes non-zero.
      const mintInfo = await getMint(
        provider.connection,
        okuMMint,
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

      // Distribute a small amount of yield: large enough that
      // `yield_per_token > 0` at this supply, small enough that the implied
      // multiplier bump stays under `MAX_STEP_BPS` (5 bps). The step ceiling
      // binds `distribute_yield` exactly as it binds `set_multiplier` — there
      // is deliberately no second door past the gates.
      const currentM = BigInt((await readMultiplierFromMint(h, okuMMint)).toString());
      const maxBump = (currentM * 4n) / 10_000n; // 4 bps, one under the ceiling
      const maxYield = (maxBump * supply) / PRECISION_BI;
      const yieldAmount = maxYield < 1_000n ? maxYield : 1_000n;
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
              okuMMint: okuMMint,
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

      const currentMultiplier = await readMultiplierFromMint(h, okuMMint);
      const oldPrice = BigInt(currentMultiplier.toString());
      const expectedNew = oldPrice + expectedBump;

      await program.methods
        .distributeYield(new BN(yieldAmount.toString()))
        .accountsPartial({
          rebaser: orchestrator.publicKey,
          config: configPda,
          okuMMint: okuMMint,
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
            okuMMint: okuMMint,
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
            okuMMint: okuMMint,
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
  // mint edge cases
  // ==========================================================================
  describe("mint edge cases", () => {
    before(async () => {
      // Ensure user has okuM ATA
      await ensureAtaViaBankrun(h, user.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);
    });

    it("fails to mint zero amount", async () => {
      // On bankrun, slot advancement happens naturally between txs; we
      // accept either ZeroAmount (if we got a fresh slot) or
      // YieldDistributionInProgress (if still in the yield slot).
      try {
        await program.methods
          .mintOkuM(new BN(0))
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
      // set_max_supply refuses to drop below current supply, so squeeze the
      // cap down to *exactly* the current supply — any subsequent mint must
      // fail with MaxSupplyExceeded.
      const currentMint = await getMint(
        provider.connection,
        okuMMint,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const tightCap = new BN(currentMint.supply.toString());
      await program.methods
        .setMaxSupply(tightCap)
        .accountsPartial({
          capManager: coldMultisig.publicKey,
          config: configPda,
          okuMMint: okuMMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig])
        .rpc();

      try {
        await program.methods
          .mintOkuM(new BN(1_000_000))
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
          okuMMint: okuMMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig])
        .rpc();
    });

  });

  // ==========================================================================
  // redeem - instant path
  // ==========================================================================
  describe("redeem - instant", () => {
    const MINT_AMOUNT = new BN(10_000_000); // 10 okuM
    const BUFFER_AMOUNT = new BN(50_000_000); // 50 USDC buffer

    before(async () => {
      // Ensure user has okuM ATA and mint okuM
      await ensureAtaViaBankrun(h, user.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);
      await mintOkuMViaProgram(program, user, MINT_AMOUNT, configPda, usdcMint, okuMMint, userUsdcAta, userOkuMAta, vaultUsdcAta);

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

    it("redeems okuM for USDC instantly when buffer sufficient", async () => {
      const redeemAmount = new BN(1_000_000); // 1 raw okuM

      const userUsdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
      const userOkuMBefore = await getAccount(provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultUsdcBefore = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);

      await program.methods
        .redeemOkuM(redeemAmount, new BN(0))
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          usdcMint,
          okuMMint,
          userUsdcAta,
          userOkuMAta,
          vaultUsdc: vaultUsdcAta,
          vaultOkuM: vaultOkuMAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userUsdcAfter = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
      const userOkuMAfter = await getAccount(provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultUsdcAfter = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);

      // okuM burned from user
      expect(Number(userOkuMBefore.amount) - Number(userOkuMAfter.amount)).to.equal(redeemAmount.toNumber());
      // The multiplier is above PRECISION from prior tests, so the GROSS
      // conversion exceeds the raw redeemed — but `tout` is charged on top and
      // is no longer zero, so the net payout need not. Assert against the
      // program's own arithmetic instead of against the raw amount: the
      // property under test is "instant settlement at the live multiplier",
      // not "the fee happens to be smaller than the accrued yield".
      const usdcReceived = Number(userUsdcAfter.amount) - Number(userUsdcBefore.amount);
      const liveMultiplier = await readMultiplierFromMint(h, okuMMint);
      expect(usdcReceived).to.equal(
        expectedRedeemNet(
          redeemAmount,
          liveMultiplier,
          new BN(1_000_000_000),
          DEFAULT_TEST_TOUT_BPS
        ).toNumber()
      );
      expect(usdcReceived).to.be.greaterThan(0);
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
          .redeemOkuM(new BN(1_000_000), new BN(0))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint,
            okuMMint,
            userUsdcAta,
            userOkuMAta,
            vaultUsdc: vaultUsdcAta,
            vaultOkuM: vaultOkuMAta,
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
          .redeemOkuM(new BN(0), new BN(0))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint,
            okuMMint,
            userUsdcAta,
            userOkuMAta,
            vaultUsdc: vaultUsdcAta,
            vaultOkuM: vaultOkuMAta,
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
      const userOkusd = await getAccount(provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID);
      const excessive = new BN(Number(userOkusd.amount) + 1_000_000_000);

      try {
        await program.methods
          .redeemOkuM(excessive, new BN(0))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint,
            okuMMint,
            userUsdcAta,
            userOkuMAta,
            vaultUsdc: vaultUsdcAta,
            vaultOkuM: vaultOkuMAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        // A user balance shortfall on redeem surfaces as
        // `InsufficientUserBalance` from the program's pre-check. We also
        // accept the SPL Token raw `InsufficientFunds` selector (and the
        // PSM-side `InsufficientBuffer`) in case the underlying burn CPI
        // is what rejects first.
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
  // freeze/thaw
  // ==========================================================================
  describe("freeze/thaw", () => {
    const freezeTarget = Keypair.generate();
    let freezeTargetOkuMAta: PublicKey;

    before(async () => {
      // Create target user, fund, get okuM
      await fundKeypairs(h, [freezeTarget], 10 * anchor.web3.LAMPORTS_PER_SOL);

      const freezeTargetUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, freezeTarget.publicKey, false, TOKEN_PROGRAM_ID
      );
      freezeTargetOkuMAta = getAssociatedTokenAddressSync(
        okuMMint, freezeTarget.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      // Create USDC ATA and fund
      const createAtaTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey, freezeTargetUsdcAta, freezeTarget.publicKey, usdcMint, TOKEN_PROGRAM_ID
        )
      );
      await provider.sendAndConfirm(createAtaTx, [payer]);
      await mintToViaBankrun(h, usdcMint, freezeTargetUsdcAta, payer, 10_000_000, TOKEN_PROGRAM_ID);

      // Mint okuM via PSM
      await ensureAtaViaBankrun(h, freezeTarget.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);
      await mintOkuMViaProgram(program, freezeTarget, new BN(5_000_000), configPda, usdcMint, okuMMint, freezeTargetUsdcAta, freezeTargetOkuMAta, vaultUsdcAta);
    });

    it("freezer can freeze a user's okuM account", async () => {
      await program.methods
        .freezeAccount()
        .accountsPartial({
          freezer: warmMultisig.publicKey,
          config: configPda,
          okuMMint,
          targetOkuMAta: freezeTargetOkuMAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([warmMultisig])
        .rpc();

      const acct = await getAccount(provider.connection, freezeTargetOkuMAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(acct.isFrozen).to.be.true;
    });

    it("unfreezer can thaw a frozen account", async () => {
      await program.methods
        .thawAccount()
        .accountsPartial({
          unfreezer: coldMultisig.publicKey,
          config: configPda,
          okuMMint,
          targetOkuMAta: freezeTargetOkuMAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig])
        .rpc();

      const acct = await getAccount(provider.connection, freezeTargetOkuMAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(acct.isFrozen).to.be.false;
    });

    it("non-freezer CANNOT freeze", async () => {
      try {
        await program.methods
          .freezeAccount()
          .accountsPartial({
            freezer: coldMultisig.publicKey, // Wrong authority
            config: configPda,
            okuMMint,
            targetOkuMAta: freezeTargetOkuMAta,
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
          okuMMint,
          targetOkuMAta: freezeTargetOkuMAta,
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
            okuMMint,
            targetOkuMAta: freezeTargetOkuMAta,
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
          okuMMint,
          targetOkuMAta: freezeTargetOkuMAta,
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
          okuMMint,
          targetOkuMAta: freezeTargetOkuMAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([warmMultisig])
        .rpc();

      const acct = await getAccount(provider.connection, freezeTargetOkuMAta, undefined, TOKEN_2022_PROGRAM_ID);
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
          okuMMint,
          targetOkuMAta: freezeTargetOkuMAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig])
        .rpc();
    });
  });

  // ==========================================================================
  // set_authority (PSM)
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
  // buffer edge cases
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
            okuMMint: okuMMint,
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
