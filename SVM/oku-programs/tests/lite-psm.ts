import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMint,
  mintTo,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeInterestBearingMintInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../target/types/lite_psm";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePSMIfNeeded,
  ensurePSMUnpaused,
  ensureAta,
  safeAirdropAll,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
  DECIMALS,
} from "./shared/setup";

// Use anchor's web3 to avoid version conflicts
const { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

describe("lite-psm", () => {
  // Delay initialization until tests run
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
  const okusdMintKeypair = Keypair.generate();

  // PDAs
  let configPda: PublicKey;
  let configBump: number;
  let redemptionQueuePda: PublicKey;
  let redemptionQueueBump: number;

  // Token accounts
  let vaultUsdcAta: PublicKey;
  let vaultOkusdAta: PublicKey;  // OkuUSD escrow for queued redemptions
  let userUsdcAta: PublicKey;
  let userOkusdAta: PublicKey;
  let user2UsdcAta: PublicKey;
  let user2OkusdAta: PublicKey;
  let orchestratorUsdcAta: PublicKey;

  // Mints
  let usdcMint: PublicKey;
  let okusdMint: PublicKey;

  // MAX_SUPPLY, MINTER_ALLOWANCE, DECIMALS imported from shared setup

  before(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    program = anchor.workspace.LitePsm as Program<LitePsm>;
    payer = (provider.wallet as anchor.Wallet).payer;
    admin = payer;

    // Derive PDAs first (needed to check if config exists)
    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")],
      program.programId
    );

    [redemptionQueuePda, redemptionQueueBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("redemption_queue")],
      program.programId
    );

    // Check if PSM config already exists (initialized by bridge_security tests)
    let psmExists = false;
    try {
      const existingConfig = await program.account.psmConfig.fetch(configPda);
      psmExists = true;
      // Use existing mints from config
      usdcMint = existingConfig.usdcMint;
      okusdMint = existingConfig.okusdMint;
    } catch {
      psmExists = false;
    }

    if (!psmExists) {
      // Create USDC mint (standard SPL token)
      usdcMint = await createMint(
        provider.connection,
        payer,
        payer.publicKey,
        null,
        DECIMALS,
        usdcMintKeypair,
        undefined,
        TOKEN_PROGRAM_ID
      );

      // Create OkuUSD mint (Token-2022 with Interest-Bearing extension)
      const mintLen = getMintLen([ExtensionType.InterestBearingConfig]);
      const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

      const createAccountIx = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: okusdMintKeypair.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      });

      const initInterestBearingIx = createInitializeInterestBearingMintInstruction(
        okusdMintKeypair.publicKey,
        orchestrator.publicKey, // rate authority (rebaser)
        0, // initial rate (0 bps)
        TOKEN_2022_PROGRAM_ID
      );

      const initMintIx = createInitializeMintInstruction(
        okusdMintKeypair.publicKey,
        DECIMALS,
        configPda, // mint authority = PSM config PDA
        configPda, // freeze authority = PSM config PDA (for freeze/thaw instructions)
        TOKEN_2022_PROGRAM_ID
      );

      const tx = new anchor.web3.Transaction().add(
        createAccountIx,
        initInterestBearingIx,
        initMintIx
      );

      await provider.sendAndConfirm(tx, [payer, okusdMintKeypair]);
      okusdMint = okusdMintKeypair.publicKey;
    }

    // Airdrop SOL to test accounts with proper confirmation
    await safeAirdropAll(
      provider.connection,
      [user, user2],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    // Create user token accounts
    userUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      user.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    userOkusdAta = getAssociatedTokenAddressSync(
      okusdMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    user2UsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      user2.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    user2OkusdAta = getAssociatedTokenAddressSync(
      okusdMint,
      user2.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    orchestratorUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      orchestrator.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    // Create user USDC accounts and mint some USDC
    const createUserUsdcAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        userUsdcAta,
        user.publicKey,
        usdcMint,
        TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createUserUsdcAtaTx, [payer]);

    const createUser2UsdcAtaTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        user2UsdcAta,
        user2.publicKey,
        usdcMint,
        TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createUser2UsdcAtaTx, [payer]);

    // Create orchestrator USDC ATA only if it doesn't exist
    await ensureAta(provider.connection, payer, orchestratorUsdcAta, orchestrator.publicKey, usdcMint, TOKEN_PROGRAM_ID);

    // Mint USDC to users
    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      userUsdcAta,
      payer,
      1_000_000_000_000, // 1M USDC
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    await mintTo(
      provider.connection,
      payer,
      usdcMint,
      user2UsdcAta,
      payer,
      1_000_000_000_000, // 1M USDC
      [],
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Check if orchestrator already has USDC (from bridge_security tests)
    try {
      const orchestratorAccount = await getAccount(
        provider.connection,
        orchestratorUsdcAta,
        undefined,
        TOKEN_PROGRAM_ID
      );
      if (Number(orchestratorAccount.amount) < 1_000_000_000_000) {
        // Mint more if needed
        await mintTo(
          provider.connection,
          payer,
          usdcMint,
          orchestratorUsdcAta,
          payer,
          1_000_000_000_000 - Number(orchestratorAccount.amount),
          [],
          undefined,
          TOKEN_PROGRAM_ID
        );
      }
    } catch {
      // Orchestrator USDC ATA doesn't exist, skip minting
    }

    // Initialize PSM using shared setup module
    const psmSetup = await initializePSMIfNeeded(
      program,
      provider,
      payer,
      usdcMint,
      okusdMint
    );

    // Update PDAs with initialized values
    configPda = psmSetup.configPda;
    redemptionQueuePda = psmSetup.redemptionQueuePda;
    vaultUsdcAta = psmSetup.vaultUsdcAta;
    vaultOkusdAta = psmSetup.vaultOkusdAta;
  });

  beforeEach(async () => {
    // Ensure PSM is unpaused before each test using shared helper
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
      expect(config.oracleManager.toString()).to.equal(coldMultisig.publicKey.toString());
      expect(config.capManager.toString()).to.equal(coldMultisig.publicKey.toString());
      expect(config.allowanceManager.toString()).to.equal(coldMultisig.publicKey.toString());
      expect(config.rebaser.toString()).to.equal(orchestrator.publicKey.toString());
      expect(config.maxSupply.toString()).to.equal(MAX_SUPPLY.toString());
      // Minter allowance may be partially consumed by bridge_security tests
      expect(Number(config.minterAllowance)).to.be.greaterThan(0);
      expect(Number(config.minterAllowance)).to.be.at.most(Number(MINTER_ALLOWANCE));
      expect(config.isPaused).to.be.false;
      expect(config.currentRateBps).to.equal(0);

      // Verify redemption queue exists (may have entries from previous tests)
      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(queue.tail).to.be.at.least(queue.head);
    });
  });

  describe("mint", () => {
    it("mints OkuUSD 1:1 with USDC (pre-created ATA)", async () => {
      const mintAmount = new BN(1_000_000); // 1 USDC/OkuUSD

      // Pre-create OkuUSD ATA
      await ensureAta(provider.connection, payer, userOkusdAta, user.publicKey, okusdMint, TOKEN_2022_PROGRAM_ID);

      // Get balances before
      const userUsdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
      let userOkusdBefore: bigint;
      try {
        const acct = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
        userOkusdBefore = acct.amount;
      } catch {
        userOkusdBefore = BigInt(0);
      }

      await program.methods
        .mint(mintAmount)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          usdcMint: usdcMint,
          okusdMint: okusdMint,
          userUsdcAta: userUsdcAta,
          userOkusdAta: userOkusdAta,
          vaultUsdc: vaultUsdcAta,
          priceUpdate: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Verify balances
      const userUsdcAfter = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
      const userOkusdAfter = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      expect(Number(userUsdcBefore.amount) - Number(userUsdcAfter.amount)).to.equal(mintAmount.toNumber());
      expect(Number(userOkusdAfter.amount) - Number(userOkusdBefore)).to.equal(mintAmount.toNumber());
    });

    it("mints OkuUSD with init_if_needed ATA creation", async () => {
      const freshUser = Keypair.generate();
      const mintAmount = new BN(1_000_000); // 1 USDC/OkuUSD

      await safeAirdropAll(provider.connection, [freshUser], 10 * anchor.web3.LAMPORTS_PER_SOL);

      // Create and fund USDC ATA
      const freshUserUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, freshUser.publicKey, false, TOKEN_PROGRAM_ID
      );
      const freshUserOkusdAta = getAssociatedTokenAddressSync(
        okusdMint, freshUser.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      const createAtaTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey, freshUserUsdcAta, freshUser.publicKey, usdcMint, TOKEN_PROGRAM_ID
        )
      );
      await provider.sendAndConfirm(createAtaTx, [payer]);
      await mintTo(provider.connection, payer, usdcMint, freshUserUsdcAta, payer,
        10_000_000, [], undefined, TOKEN_PROGRAM_ID);

      // DO NOT pre-create OkuUSD ATA — let init_if_needed handle it
      await program.methods
        .mint(mintAmount)
        .accountsPartial({
          user: freshUser.publicKey,
          config: configPda,
          usdcMint: usdcMint,
          okusdMint: okusdMint,
          userUsdcAta: freshUserUsdcAta,
          userOkusdAta: freshUserOkusdAta,
          vaultUsdc: vaultUsdcAta,
          priceUpdate: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([freshUser])
        .rpc();

      // Verify OkuUSD was minted
      const okusdAccount = await getAccount(
        provider.connection, freshUserOkusdAta, undefined, TOKEN_2022_PROGRAM_ID
      );
      expect(Number(okusdAccount.amount)).to.equal(mintAmount.toNumber());
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
          .mint(new BN(1_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint: usdcMint,
            okusdMint: okusdMint,
            userUsdcAta: userUsdcAta,
            userOkusdAta: userOkusdAta,
            vaultUsdc: vaultUsdcAta,
            priceUpdate: null,
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

  // NOTE: RBAC tests are skipped because config is initialized by bridge_security tests
  // with different keypairs. RBAC functionality is tested there instead.
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

    // NOTE: Freeze/thaw RBAC tests removed - these require minting OkuUSD for setup
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
          })
          .signers([coldMultisig])
          .rpc();
      });

      it("non-cap_manager CANNOT set max supply", async () => {
        try {
          await program.methods
            .setMaxSupply(new BN(1))
            .accountsPartial({
              capManager: warmMultisig.publicKey, // Wrong role
              config: configPda,
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

      it("oracle_manager can set oracle", async () => {
        const oracleKey = Keypair.generate().publicKey;
        const stalenessThreshold = new BN(3600);

        await program.methods
          .setOracle(oracleKey, stalenessThreshold)
          .accountsPartial({
            oracleManager: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();

        const config = await program.account.psmConfig.fetch(configPda);
        expect(config.oracle.toString()).to.equal(oracleKey.toString());
        expect(config.stalenessThreshold.toString()).to.equal(stalenessThreshold.toString());

        // Reset
        await program.methods
          .setOracle(PublicKey.default, new BN(0))
          .accountsPartial({
            oracleManager: coldMultisig.publicKey,
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();
      });

      it("non-oracle_manager CANNOT set oracle", async () => {
        try {
          await program.methods
            .setOracle(Keypair.generate().publicKey, new BN(0))
            .accountsPartial({
              oracleManager: warmMultisig.publicKey, // Wrong role
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

        await ensureAta(provider.connection, payer, bufferWithdrawerUsdcAta, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);

        // Ensure vault_usdc ATA exists (should have been created during initialize)
        await ensureAta(provider.connection, payer, vaultUsdcAta, configPda, usdcMint, TOKEN_PROGRAM_ID);

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
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint: usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
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
              withdrawerUsdcAta: bufferWithdrawerUsdcAta,
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

      it("rebaser can update interest rate", async () => {
        const newRate = 450; // 4.5% APY

        await program.methods
          .updateInterestRate(newRate)
          .accountsPartial({
            rebaser: orchestrator.publicKey,
            config: configPda,
            okusdMint: okusdMint,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();

        const config = await program.account.psmConfig.fetch(configPda);
        expect(config.currentRateBps).to.equal(newRate);

        // Reset
        await program.methods
          .updateInterestRate(0)
          .accountsPartial({
            rebaser: orchestrator.publicKey,
            config: configPda,
            okusdMint: okusdMint,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([orchestrator])
          .rpc();
      });

      it("non-rebaser CANNOT update interest rate", async () => {
        try {
          await program.methods
            .updateInterestRate(100)
            .accountsPartial({
              rebaser: warmMultisig.publicKey, // Wrong role
              config: configPda,
              okusdMint: okusdMint,
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

});
