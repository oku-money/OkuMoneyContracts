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
  getAssociatedTokenAddress,
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
  mintOkusdViaProgram,
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

  // ==========================================================================
  // NEW COVERAGE: mint edge cases
  // ==========================================================================
  describe("mint edge cases", () => {
    before(async () => {
      // Ensure user has OkuUSD ATA
      await ensureAta(provider.connection, payer, userOkusdAta, user.publicKey, okusdMint, TOKEN_2022_PROGRAM_ID);
    });

    it("fails to mint zero amount", async () => {
      try {
        await program.methods
          .mint(new BN(0))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint,
            okusdMint,
            userUsdcAta,
            userOkusdAta,
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
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        expect(errorCode).to.satisfy((c: string) => c === "ZeroAmount" || c.includes("ZeroAmount"));
      }
    });

    it("fails to mint when max supply exceeded", async () => {
      // Set max supply very low
      await program.methods
        .setMaxSupply(new BN(1))
        .accountsPartial({
          capManager: coldMultisig.publicKey,
          config: configPda,
        })
        .signers([coldMultisig])
        .rpc();

      try {
        await program.methods
          .mint(new BN(1_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint,
            okusdMint,
            userUsdcAta,
            userOkusdAta,
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
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        expect(errorCode).to.satisfy((c: string) => c === "MaxSupplyExceeded" || c.includes("MaxSupplyExceeded"));
      }

      // Restore max supply
      await program.methods
        .setMaxSupply(MAX_SUPPLY)
        .accountsPartial({
          capManager: coldMultisig.publicKey,
          config: configPda,
        })
        .signers([coldMultisig])
        .rpc();
    });

    it("fails when oracle configured but no price account passed", async () => {
      const oracleKey = Keypair.generate().publicKey;

      // Set oracle
      await program.methods
        .setOracle(oracleKey, new BN(3600))
        .accountsPartial({
          oracleManager: coldMultisig.publicKey,
          config: configPda,
        })
        .signers([coldMultisig])
        .rpc();

      try {
        await program.methods
          .mint(new BN(1_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            usdcMint,
            okusdMint,
            userUsdcAta,
            userOkusdAta,
            vaultUsdc: vaultUsdcAta,
            priceUpdate: null, // Oracle configured but no account passed
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
        expect(errorCode).to.satisfy((c: string) =>
          c === "OracleAccountMissing" || c.includes("OracleAccountMissing") || c.includes("oracle")
        );
      }

      // Reset oracle to disabled
      await program.methods
        .setOracle(PublicKey.default, new BN(0))
        .accountsPartial({
          oracleManager: coldMultisig.publicKey,
          config: configPda,
        })
        .signers([coldMultisig])
        .rpc();
    });
  });

  // ==========================================================================
  // NEW COVERAGE: redeem - instant path
  // ==========================================================================
  describe("redeem - instant", () => {
    const MINT_AMOUNT = new BN(10_000_000); // 10 OkuUSD
    const BUFFER_AMOUNT = new BN(50_000_000); // 50 USDC buffer

    before(async () => {
      // Ensure user has OkuUSD ATA and mint OkuUSD
      await ensureAta(provider.connection, payer, userOkusdAta, user.publicKey, okusdMint, TOKEN_2022_PROGRAM_ID);
      await mintOkusdViaProgram(program, user, MINT_AMOUNT, configPda, usdcMint, okusdMint, userUsdcAta, userOkusdAta, vaultUsdcAta);

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

    it("redeems OkuUSD for USDC instantly when buffer sufficient", async () => {
      const redeemAmount = new BN(1_000_000); // 1 OkuUSD

      const userUsdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
      const userOkusdBefore = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultUsdcBefore = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);

      await program.methods
        .redeem(redeemAmount)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          okusdMint,
          userUsdcAta,
          userOkusdAta,
          vaultUsdc: vaultUsdcAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const userUsdcAfter = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
      const userOkusdAfter = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultUsdcAfter = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);

      // OkuUSD burned from user
      expect(Number(userOkusdBefore.amount) - Number(userOkusdAfter.amount)).to.equal(redeemAmount.toNumber());
      // USDC sent to user
      expect(Number(userUsdcAfter.amount) - Number(userUsdcBefore.amount)).to.equal(redeemAmount.toNumber());
      // Vault USDC decreased
      expect(Number(vaultUsdcBefore.amount) - Number(vaultUsdcAfter.amount)).to.equal(redeemAmount.toNumber());
    });

    it("fails to redeem when paused", async () => {
      await program.methods
        .pause()
        .accountsPartial({ pauser: warmMultisig.publicKey, config: configPda })
        .signers([warmMultisig])
        .rpc();

      try {
        await program.methods
          .redeem(new BN(1_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdcMint,
            okusdMint,
            userUsdcAta,
            userOkusdAta,
            vaultUsdc: vaultUsdcAta,
            vaultOkusd: vaultOkusdAta,
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
          .redeem(new BN(0))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdcMint,
            okusdMint,
            userUsdcAta,
            userOkusdAta,
            vaultUsdc: vaultUsdcAta,
            vaultOkusd: vaultOkusdAta,
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
      const userOkusd = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const excessive = new BN(Number(userOkusd.amount) + 1_000_000_000);

      try {
        await program.methods
          .redeem(excessive)
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdcMint,
            okusdMint,
            userUsdcAta,
            userOkusdAta,
            vaultUsdc: vaultUsdcAta,
            vaultOkusd: vaultOkusdAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        // Token-2022 burn failure or custom error
        expect(err).to.exist;
      }
    });
  });

  // ==========================================================================
  // NEW COVERAGE: redeem - queued path
  // ==========================================================================
  describe("redeem - queued", () => {
    const MINT_AMOUNT = new BN(20_000_000); // 20 OkuUSD

    before(async () => {
      // Ensure user has OkuUSD
      await ensureAta(provider.connection, payer, userOkusdAta, user.publicKey, okusdMint, TOKEN_2022_PROGRAM_ID);
      await ensureAta(provider.connection, payer, user2OkusdAta, user2.publicKey, okusdMint, TOKEN_2022_PROGRAM_ID);
      await mintOkusdViaProgram(program, user, MINT_AMOUNT, configPda, usdcMint, okusdMint, userUsdcAta, userOkusdAta, vaultUsdcAta);
      await mintOkusdViaProgram(program, user2, MINT_AMOUNT, configPda, usdcMint, okusdMint, user2UsdcAta, user2OkusdAta, vaultUsdcAta);

      // Drain the USDC buffer so redemptions go to queue
      const vaultUsdc = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
      if (Number(vaultUsdc.amount) > 0) {
        const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
          usdcMint, coldMultisig.publicKey, false, TOKEN_PROGRAM_ID
        );
        await ensureAta(provider.connection, payer, bufferWithdrawerUsdcAta, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);
        await program.methods
          .withdrawBuffer(new BN(Number(vaultUsdc.amount)))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }
    });

    it("queues redemption when buffer insufficient", async () => {
      const redeemAmount = new BN(1_000_000); // 1 OkuUSD
      const queueBefore = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const escrowBefore = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      await program.methods
        .redeem(redeemAmount)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          okusdMint,
          userUsdcAta,
          userOkusdAta,
          vaultUsdc: vaultUsdcAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const queueAfter = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      const escrowAfter = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      // Tail should advance
      expect(queueAfter.tail).to.equal(queueBefore.tail + 1);
      // OkuUSD transferred to escrow
      expect(Number(escrowAfter.amount) - Number(escrowBefore.amount)).to.equal(redeemAmount.toNumber());
      // Queue entry has correct user
      const entry = queueAfter.entries[queueBefore.tail];
      expect(entry.user.toString()).to.equal(user.publicKey.toString());
      expect(Number(entry.okusdRawAmount)).to.equal(redeemAmount.toNumber());
    });

    it("queues multiple from different users", async () => {
      const redeemAmount = new BN(1_000_000);
      const queueBefore = await program.account.redemptionQueue.fetch(redemptionQueuePda);

      await program.methods
        .redeem(redeemAmount)
        .accountsPartial({
          user: user2.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          okusdMint,
          userUsdcAta: user2UsdcAta,
          userOkusdAta: user2OkusdAta,
          vaultUsdc: vaultUsdcAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      const queueAfter = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(queueAfter.tail).to.equal(queueBefore.tail + 1);
      const entry = queueAfter.entries[queueBefore.tail];
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
      if (queueBefore.head >= queueBefore.tail) {
        // Queue is empty, create an entry first
        await mintOkusdViaProgram(program, user, new BN(2_000_000), configPda, usdcMint, okusdMint, userUsdcAta, userOkusdAta, vaultUsdcAta);
        // Drain buffer to force queuing
        const vaultUsdc = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
        const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
          usdcMint, coldMultisig.publicKey, false, TOKEN_PROGRAM_ID
        );
        await ensureAta(provider.connection, payer, bufferWithdrawerUsdcAta, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);
        if (Number(vaultUsdc.amount) > 0) {
          await program.methods
            .withdrawBuffer(new BN(Number(vaultUsdc.amount)))
            .accountsPartial({
              bufferWithdrawer: coldMultisig.publicKey,
              config: configPda,
              withdrawerUsdcAta: bufferWithdrawerUsdcAta,
              vaultUsdc: vaultUsdcAta,
              usdcMint,
              tokenProgram: TOKEN_PROGRAM_ID,
            })
            .signers([coldMultisig])
            .rpc();
        }
        await program.methods
          .redeem(new BN(1_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            redemptionQueue: redemptionQueuePda,
            usdcMint,
            okusdMint,
            userUsdcAta,
            userOkusdAta,
            vaultUsdc: vaultUsdcAta,
            vaultOkusd: vaultOkusdAta,
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
      const entry = queue.entries[headBefore];
      const recipientUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, entry.user, false, TOKEN_PROGRAM_ID
      );
      await ensureAta(provider.connection, payer, recipientUsdcAta, entry.user, usdcMint, TOKEN_PROGRAM_ID);

      const recipientUsdcBefore = await getAccount(provider.connection, recipientUsdcAta, undefined, TOKEN_PROGRAM_ID);

      await program.methods
        .processQueue(1)
        .accountsPartial({
          queueProcessor: orchestrator.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          okusdMint,
          vaultUsdc: vaultUsdcAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .remainingAccounts([
          { pubkey: recipientUsdcAta, isSigner: false, isWritable: true },
        ])
        .signers([orchestrator])
        .rpc();

      const queueAfter = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      expect(queueAfter.head).to.equal(headBefore + 1);

      const recipientUsdcAfter = await getAccount(provider.connection, recipientUsdcAta, undefined, TOKEN_PROGRAM_ID);
      expect(Number(recipientUsdcAfter.amount)).to.be.greaterThan(Number(recipientUsdcBefore.amount));
    });

    it("processes multiple entries FIFO", async () => {
      // Create two queued entries
      // First drain buffer
      const vaultUsdc = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
      const bufferWithdrawerUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, coldMultisig.publicKey, false, TOKEN_PROGRAM_ID
      );
      await ensureAta(provider.connection, payer, bufferWithdrawerUsdcAta, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);
      if (Number(vaultUsdc.amount) > 0) {
        await program.methods
          .withdrawBuffer(new BN(Number(vaultUsdc.amount)))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }

      // Mint and queue for user1 and user2
      await mintOkusdViaProgram(program, user, new BN(5_000_000), configPda, usdcMint, okusdMint, userUsdcAta, userOkusdAta, vaultUsdcAta);
      await mintOkusdViaProgram(program, user2, new BN(5_000_000), configPda, usdcMint, okusdMint, user2UsdcAta, user2OkusdAta, vaultUsdcAta);

      // Drain buffer again (mint deposits USDC into vault)
      const vaultUsdc2 = await getAccount(provider.connection, vaultUsdcAta, undefined, TOKEN_PROGRAM_ID);
      if (Number(vaultUsdc2.amount) > 0) {
        await program.methods
          .withdrawBuffer(new BN(Number(vaultUsdc2.amount)))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }

      await program.methods
        .redeem(new BN(2_000_000))
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          okusdMint,
          userUsdcAta,
          userOkusdAta,
          vaultUsdc: vaultUsdcAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      await program.methods
        .redeem(new BN(2_000_000))
        .accountsPartial({
          user: user2.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          okusdMint,
          userUsdcAta: user2UsdcAta,
          userOkusdAta: user2OkusdAta,
          vaultUsdc: vaultUsdcAta,
          vaultOkusd: vaultOkusdAta,
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
      const entry1 = queueBefore.entries[headBefore];
      const entry2 = queueBefore.entries[headBefore + 1];
      const ata1 = getAssociatedTokenAddressSync(usdcMint, entry1.user, false, TOKEN_PROGRAM_ID);
      const ata2 = getAssociatedTokenAddressSync(usdcMint, entry2.user, false, TOKEN_PROGRAM_ID);
      await ensureAta(provider.connection, payer, ata1, entry1.user, usdcMint, TOKEN_PROGRAM_ID);
      await ensureAta(provider.connection, payer, ata2, entry2.user, usdcMint, TOKEN_PROGRAM_ID);

      await program.methods
        .processQueue(2)
        .accountsPartial({
          queueProcessor: orchestrator.publicKey,
          config: configPda,
          redemptionQueue: redemptionQueuePda,
          okusdMint,
          vaultUsdc: vaultUsdcAta,
          vaultOkusd: vaultOkusdAta,
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
      expect(queueAfter.head).to.equal(headBefore + 2);
    });

    it("fails with QueueEmpty when no entries", async () => {
      // Ensure queue is empty (head == tail)
      const queue = await program.account.redemptionQueue.fetch(redemptionQueuePda);
      if (queue.head < queue.tail) {
        // Process remaining entries first
        const remaining = queue.tail - queue.head;
        const accounts = [];
        for (let i = queue.head; i < queue.tail; i++) {
          const entry = queue.entries[i];
          const ata = getAssociatedTokenAddressSync(usdcMint, entry.user, false, TOKEN_PROGRAM_ID);
          await ensureAta(provider.connection, payer, ata, entry.user, usdcMint, TOKEN_PROGRAM_ID);
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
            okusdMint,
            vaultUsdc: vaultUsdcAta,
            vaultOkusd: vaultOkusdAta,
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
            okusdMint,
            vaultUsdc: vaultUsdcAta,
            vaultOkusd: vaultOkusdAta,
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
            okusdMint,
            vaultUsdc: vaultUsdcAta,
            vaultOkusd: vaultOkusdAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .remainingAccounts([])
          .signers([warmMultisig])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        expect(errorCode).to.satisfy((c: string) =>
          c === "Unauthorized" || c.includes("Unauthorized") || c.includes("Error")
        );
      }
    });
  });

  // ==========================================================================
  // NEW COVERAGE: freeze/thaw
  // ==========================================================================
  describe("freeze/thaw", () => {
    const freezeTarget = Keypair.generate();
    let freezeTargetOkusdAta: PublicKey;

    before(async () => {
      // Create target user, fund, get OkuUSD
      await safeAirdropAll(provider.connection, [freezeTarget], 10 * anchor.web3.LAMPORTS_PER_SOL);

      const freezeTargetUsdcAta = getAssociatedTokenAddressSync(
        usdcMint, freezeTarget.publicKey, false, TOKEN_PROGRAM_ID
      );
      freezeTargetOkusdAta = getAssociatedTokenAddressSync(
        okusdMint, freezeTarget.publicKey, false, TOKEN_2022_PROGRAM_ID
      );

      // Create USDC ATA and fund
      const createAtaTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey, freezeTargetUsdcAta, freezeTarget.publicKey, usdcMint, TOKEN_PROGRAM_ID
        )
      );
      await provider.sendAndConfirm(createAtaTx, [payer]);
      await mintTo(provider.connection, payer, usdcMint, freezeTargetUsdcAta, payer,
        10_000_000, [], undefined, TOKEN_PROGRAM_ID);

      // Mint OkuUSD via PSM
      await ensureAta(provider.connection, payer, freezeTargetOkusdAta, freezeTarget.publicKey, okusdMint, TOKEN_2022_PROGRAM_ID);
      await mintOkusdViaProgram(program, freezeTarget, new BN(5_000_000), configPda, usdcMint, okusdMint, freezeTargetUsdcAta, freezeTargetOkusdAta, vaultUsdcAta);
    });

    it("freezer can freeze a user's OkuUSD account", async () => {
      await program.methods
        .freezeAccount()
        .accountsPartial({
          freezer: warmMultisig.publicKey,
          config: configPda,
          okusdMint,
          targetOkusdAta: freezeTargetOkusdAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([warmMultisig])
        .rpc();

      const acct = await getAccount(provider.connection, freezeTargetOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(acct.isFrozen).to.be.true;
    });

    it("unfreezer can thaw a frozen account", async () => {
      await program.methods
        .thawAccount()
        .accountsPartial({
          unfreezer: coldMultisig.publicKey,
          config: configPda,
          okusdMint,
          targetOkusdAta: freezeTargetOkusdAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig])
        .rpc();

      const acct = await getAccount(provider.connection, freezeTargetOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(acct.isFrozen).to.be.false;
    });

    it("non-freezer CANNOT freeze", async () => {
      try {
        await program.methods
          .freezeAccount()
          .accountsPartial({
            freezer: coldMultisig.publicKey, // Wrong authority
            config: configPda,
            okusdMint,
            targetOkusdAta: freezeTargetOkusdAta,
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
          okusdMint,
          targetOkusdAta: freezeTargetOkusdAta,
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
            okusdMint,
            targetOkusdAta: freezeTargetOkusdAta,
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
          okusdMint,
          targetOkusdAta: freezeTargetOkusdAta,
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
          okusdMint,
          targetOkusdAta: freezeTargetOkusdAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([warmMultisig])
        .rpc();

      const acct = await getAccount(provider.connection, freezeTargetOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
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
          okusdMint,
          targetOkusdAta: freezeTargetOkusdAta,
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

    it("role_admin can transfer admin role and transfer back", async () => {
      const tempAdmin = Keypair.generate();
      await safeAirdropAll(provider.connection, [tempAdmin], 5 * anchor.web3.LAMPORTS_PER_SOL);

      // Transfer admin to tempAdmin
      await program.methods
        .setAuthority({ roleAdmin: {} }, tempAdmin.publicKey)
        .accountsPartial({
          roleAdmin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      let config = await program.account.psmConfig.fetch(configPda);
      expect(config.roleAdmin.toString()).to.equal(tempAdmin.publicKey.toString());

      // Transfer back
      await program.methods
        .setAuthority({ roleAdmin: {} }, admin.publicKey)
        .accountsPartial({
          roleAdmin: tempAdmin.publicKey,
          config: configPda,
        })
        .signers([tempAdmin])
        .rpc();

      config = await program.account.psmConfig.fetch(configPda);
      expect(config.roleAdmin.toString()).to.equal(admin.publicKey.toString());
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
      await ensureAta(provider.connection, payer, bufferWithdrawerUsdcAta, coldMultisig.publicKey, usdcMint, TOKEN_PROGRAM_ID);

      try {
        await program.methods
          .withdrawBuffer(new BN(0))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: configPda,
            withdrawerUsdcAta: bufferWithdrawerUsdcAta,
            vaultUsdc: vaultUsdcAta,
            usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
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
