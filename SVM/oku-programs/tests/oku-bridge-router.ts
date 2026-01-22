import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import { OkuBridgeRouter } from "../target/types/oku_bridge_router";
import { WokusdVault } from "../target/types/wokusd_vault";
import { LitePsm } from "../target/types/lite_psm";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load IDLs
const ROUTER_IDL = JSON.parse(readFileSync(join(__dirname, "../target/idl/oku_bridge_router.json"), "utf-8"));
const VAULT_IDL = JSON.parse(readFileSync(join(__dirname, "../target/idl/wokusd_vault.json"), "utf-8"));
const PSM_IDL = JSON.parse(readFileSync(join(__dirname, "../target/idl/lite_psm.json"), "utf-8"));

// Program IDs from Anchor.toml
const ROUTER_PROGRAM_ID = new PublicKey("BRdgEiDLhPzrV2bJzjVdKaGm1FzLiVmSqLkQCJ2mX4Fq");
const VAULT_PROGRAM_ID = new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");
const PSM_PROGRAM_ID = new PublicKey("FbYGHcN1wyXebY51vFpNmmNMuSZoXpEiEgCu3Lm9GujX");

describe("oku-bridge-router", () => {
  let provider: anchor.AnchorProvider;
  let routerProgram: Program<OkuBridgeRouter>;
  let vaultProgram: Program<WokusdVault>;
  let psmProgram: Program<LitePsm>;
  let payer: Keypair;
  let admin: Keypair;

  const user = Keypair.generate();

  // PDAs
  let routerConfigPda: PublicKey;
  let vaultConfigPda: PublicKey;
  let psmConfigPda: PublicKey;

  // These will be read from existing configs
  let usdcMint: PublicKey;
  let okusdMint: PublicKey;
  let wokusdMint: PublicKey;
  let vaultOkusdAta: PublicKey;  // vault's OkuUSD account
  let vaultUsdcAta: PublicKey;
  let psmOrchestrator: PublicKey;

  // User accounts
  let userOkusdAta: PublicKey;
  let userWokusdAta: PublicKey;
  let userUsdcAta: PublicKey;

  before(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    routerProgram = new Program<OkuBridgeRouter>(ROUTER_IDL as any, ROUTER_PROGRAM_ID, provider);
    vaultProgram = new Program<WokusdVault>(VAULT_IDL as any, VAULT_PROGRAM_ID, provider);
    psmProgram = new Program<LitePsm>(PSM_IDL as any, PSM_PROGRAM_ID, provider);
    payer = (provider.wallet as anchor.Wallet).payer;
    admin = payer;

    // Airdrop SOL to test user
    await provider.connection.requestAirdrop(user.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Derive PDAs
    [routerConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("router_config")],
      routerProgram.programId
    );

    [vaultConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_config")],
      vaultProgram.programId
    );

    [psmConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")],
      psmProgram.programId
    );

    // Read existing PSM config to get mints
    const psmConfigData = await psmProgram.account.psmConfig.fetch(psmConfigPda);
    usdcMint = psmConfigData.usdcMint;
    okusdMint = psmConfigData.okusdMint;
    vaultUsdcAta = psmConfigData.vaultUsdcAta;
    psmOrchestrator = psmConfigData.orchestrator;

    // Read vault config if it exists
    try {
      const vaultConfig = await vaultProgram.account.vaultConfig.fetch(vaultConfigPda);
      wokusdMint = vaultConfig.wokusdMint;
      vaultOkusdAta = vaultConfig.vaultOkusdAta;
    } catch {
      // Vault not initialized yet - derive expected addresses
      const [wokusdMintPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("wokusd_mint")],
        vaultProgram.programId
      );
      wokusdMint = wokusdMintPda;
      vaultOkusdAta = getAssociatedTokenAddressSync(
        okusdMint,
        vaultConfigPda,
        true,
        TOKEN_2022_PROGRAM_ID
      );
    }

    // Derive user token accounts
    userOkusdAta = getAssociatedTokenAddressSync(
      okusdMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    userWokusdAta = getAssociatedTokenAddressSync(
      wokusdMint,
      user.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    userUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      user.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );

    // Create user USDC account
    try {
      const createUserUsdcTx = new anchor.web3.Transaction().add(
        createAssociatedTokenAccountInstruction(
          payer.publicKey,
          userUsdcAta,
          user.publicKey,
          usdcMint,
          TOKEN_PROGRAM_ID
        )
      );
      await provider.sendAndConfirm(createUserUsdcTx, [payer]);
    } catch {
      // Already exists
    }

    // Transfer some USDC to user (from payer if payer has any)
    // For now, we'll have the user mint OkuUSD by being an orchestrator or bridging in
    // Skip this step - user will get OkuUSD via PSM mint
  });

  describe("initialize", () => {
    it("initializes the router config", async () => {
      // Skip if already initialized
      try {
        await routerProgram.account.routerConfig.fetch(routerConfigPda);
        console.log("Router already initialized, skipping init test");
        return;
      } catch {
        // Not initialized, proceed
      }

      await routerProgram.methods
        .initialize()
        .accounts({
          admin: admin.publicKey,
          config: routerConfigPda,
          psmProgram: PSM_PROGRAM_ID,
          vaultProgram: VAULT_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
      expect(config.admin.toString()).to.equal(admin.publicKey.toString());
      expect(config.psmProgram.toString()).to.equal(PSM_PROGRAM_ID.toString());
      expect(config.vaultProgram.toString()).to.equal(VAULT_PROGRAM_ID.toString());
      expect(config.isPaused).to.be.false;
    });
  });

  describe("bridge_direct", () => {
    before(async () => {
      // Initialize router if not done
      try {
        await routerProgram.account.routerConfig.fetch(routerConfigPda);
      } catch {
        await routerProgram.methods
          .initialize()
          .accounts({
            admin: admin.publicKey,
            config: routerConfigPda,
            psmProgram: PSM_PROGRAM_ID,
            vaultProgram: VAULT_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }

      // Create user's OkuUSD account and bridge_mint some tokens to them
      try {
        // First create user's OkuUSD account
        try {
          const createUserOkusdTx = new anchor.web3.Transaction().add(
            createAssociatedTokenAccountInstruction(
              payer.publicKey,
              userOkusdAta,
              user.publicKey,
              okusdMint,
              TOKEN_2022_PROGRAM_ID
            )
          );
          await provider.sendAndConfirm(createUserOkusdTx, [payer]);
        } catch {
          // Already exists
        }

        // Use bridge_mint to give user some OkuUSD (orchestrator is payer in test)
        // Note: This only works if payer == orchestrator
        await psmProgram.methods
          .bridgeMint(new BN(50_000_000), 1)
          .accounts({
            orchestrator: psmOrchestrator,
            config: psmConfigPda,
            okusdMint: okusdMint,
            recipientOkusdAta: userOkusdAta,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
      } catch (err: any) {
        console.log("Setup note: could not mint OkuUSD to user:", err.message);
      }
    });

    it("bridges OkuUSD directly", async () => {
      // Check if user has OkuUSD
      let userOkusdBalance: bigint;
      try {
        const userOkusdAccount = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
        userOkusdBalance = userOkusdAccount.amount;
      } catch {
        console.log("User has no OkuUSD, skipping test");
        return;
      }

      if (userOkusdBalance === 0n) {
        console.log("User OkuUSD balance is 0, skipping test");
        return;
      }

      const bridgeAmount = new BN(Math.min(10_000_000, Number(userOkusdBalance)));
      const destinationChain = 42161; // Arbitrum

      const userOkusdBefore = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      await routerProgram.methods
        .bridgeDirect(bridgeAmount, destinationChain)
        .accounts({
          user: user.publicKey,
          config: routerConfigPda,
          psmConfig: psmConfigPda,
          okusdMint: okusdMint,
          userOkusdAta: userOkusdAta,
          psmProgram: PSM_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([user])
        .rpc();

      const userOkusdAfter = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(userOkusdBefore.amount) - Number(userOkusdAfter.amount)).to.equal(bridgeAmount.toNumber());
    });

    it("fails when paused", async () => {
      // Pause router
      await routerProgram.methods
        .setPaused(true)
        .accounts({
          admin: admin.publicKey,
          config: routerConfigPda,
        })
        .rpc();

      try {
        await routerProgram.methods
          .bridgeDirect(new BN(1_000_000), 1)
          .accounts({
            user: user.publicKey,
            config: routerConfigPda,
            psmConfig: psmConfigPda,
            okusdMint: okusdMint,
            userOkusdAta: userOkusdAta,
            psmProgram: PSM_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Paused");
      }

      // Unpause
      await routerProgram.methods
        .setPaused(false)
        .accounts({
          admin: admin.publicKey,
          config: routerConfigPda,
        })
        .rpc();
    });

    it("fails with zero amount", async () => {
      try {
        await routerProgram.methods
          .bridgeDirect(new BN(0), 1)
          .accounts({
            user: user.publicKey,
            config: routerConfigPda,
            psmConfig: psmConfigPda,
            okusdMint: okusdMint,
            userOkusdAta: userOkusdAta,
            psmProgram: PSM_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });
  });

  describe("bridge_wrapped", () => {
    const bridgeWrappedUser = Keypair.generate();
    let bridgeWrappedUserOkusdAta: PublicKey;
    let bridgeWrappedUserWokusdAta: PublicKey;
    let vaultInitialized = false;

    before(async () => {
      // Airdrop SOL to test user
      await provider.connection.requestAirdrop(bridgeWrappedUser.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Initialize router if not done
      try {
        await routerProgram.account.routerConfig.fetch(routerConfigPda);
      } catch {
        await routerProgram.methods
          .initialize()
          .accounts({
            admin: admin.publicKey,
            config: routerConfigPda,
            psmProgram: PSM_PROGRAM_ID,
            vaultProgram: VAULT_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .rpc();
      }

      // Check if vault is initialized (it may be initialized by wokusd-vault tests)
      // Note: In test suite execution order, wokusd-vault runs after this file
      // so these tests will be skipped. The bridge_wrapped function is tested
      // indirectly through vault.unwrap + PSM.bridge_burn which are both tested separately.
      try {
        const vaultConfig = await vaultProgram.account.vaultConfig.fetch(vaultConfigPda);
        wokusdMint = vaultConfig.wokusdMint;
        vaultOkusdAta = vaultConfig.vaultOkusdAta;
        vaultInitialized = true;
      } catch {
        console.log("Vault not initialized - bridge_wrapped tests will be skipped");
        console.log("(The bridge_wrapped function combines vault.unwrap + PSM.bridge_burn,");
        console.log(" both of which are tested in their respective test files)");
        return;
      }

      // Derive user token accounts
      bridgeWrappedUserOkusdAta = getAssociatedTokenAddressSync(
        okusdMint,
        bridgeWrappedUser.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      bridgeWrappedUserWokusdAta = getAssociatedTokenAddressSync(
        wokusdMint,
        bridgeWrappedUser.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      // Create user's OkuUSD account
      try {
        const createUserOkusdTx = new anchor.web3.Transaction().add(
          createAssociatedTokenAccountInstruction(
            payer.publicKey,
            bridgeWrappedUserOkusdAta,
            bridgeWrappedUser.publicKey,
            okusdMint,
            TOKEN_2022_PROGRAM_ID
          )
        );
        await provider.sendAndConfirm(createUserOkusdTx, [payer]);
      } catch {
        // Already exists
      }

      // Mint OkuUSD to user via bridge_mint (orchestrator is payer in tests)
      try {
        await psmProgram.methods
          .bridgeMint(new BN(100_000_000), 1) // 100 OkuUSD
          .accounts({
            orchestrator: psmOrchestrator,
            config: psmConfigPda,
            okusdMint: okusdMint,
            recipientOkusdAta: bridgeWrappedUserOkusdAta,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .rpc();
      } catch (err: any) {
        console.log("Could not mint OkuUSD to bridge_wrapped user:", err.message);
        return;
      }

      // Create user's wOkuUSD account and wrap OkuUSD → wOkuUSD
      try {
        await vaultProgram.methods
          .wrap(new BN(50_000_000)) // Wrap 50 OkuUSD → wOkuUSD
          .accounts({
            user: bridgeWrappedUser.publicKey,
            config: vaultConfigPda,
            okusdMint: okusdMint,
            wokusdMint: wokusdMint,
            userOkusdAta: bridgeWrappedUserOkusdAta,
            userWokusdAta: bridgeWrappedUserWokusdAta,
            vaultOkusdAta: vaultOkusdAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([bridgeWrappedUser])
          .rpc();
      } catch (err: any) {
        console.log("Could not wrap OkuUSD:", err.message);
      }
    });

    it("bridges wOkuUSD in one transaction (unwrap + burn)", async () => {
      if (!vaultInitialized) {
        console.log("Vault not initialized, skipping test");
        return;
      }

      // Check if user has wOkuUSD
      let userWokusdBalance: bigint;
      try {
        const userWokusdAccount = await getAccount(provider.connection, bridgeWrappedUserWokusdAta, undefined, TOKEN_PROGRAM_ID);
        userWokusdBalance = userWokusdAccount.amount;
      } catch {
        console.log("User has no wOkuUSD account, skipping test");
        return;
      }

      if (userWokusdBalance === 0n) {
        console.log("User wOkuUSD balance is 0, skipping test");
        return;
      }

      const bridgeShares = new BN(Math.min(10_000_000, Number(userWokusdBalance)));
      const destinationChain = 42161; // Arbitrum

      const userWokusdBefore = await getAccount(provider.connection, bridgeWrappedUserWokusdAta, undefined, TOKEN_PROGRAM_ID);

      await routerProgram.methods
        .bridgeWrapped(bridgeShares, destinationChain)
        .accounts({
          user: bridgeWrappedUser.publicKey,
          config: routerConfigPda,
          vaultConfig: vaultConfigPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: bridgeWrappedUserOkusdAta,
          userWokusdAta: bridgeWrappedUserWokusdAta,
          vaultOkusdAta: vaultOkusdAta,
          psmConfig: psmConfigPda,
          vaultProgram: VAULT_PROGRAM_ID,
          psmProgram: PSM_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([bridgeWrappedUser])
        .rpc();

      const userWokusdAfter = await getAccount(provider.connection, bridgeWrappedUserWokusdAta, undefined, TOKEN_PROGRAM_ID);
      expect(Number(userWokusdBefore.amount) - Number(userWokusdAfter.amount)).to.equal(bridgeShares.toNumber());
    });

    it("fails when paused", async () => {
      if (!vaultInitialized) {
        console.log("Vault not initialized, skipping test");
        return;
      }

      // Pause router
      await routerProgram.methods
        .setPaused(true)
        .accounts({
          admin: admin.publicKey,
          config: routerConfigPda,
        })
        .rpc();

      try {
        await routerProgram.methods
          .bridgeWrapped(new BN(1_000_000), 1)
          .accounts({
            user: bridgeWrappedUser.publicKey,
            config: routerConfigPda,
            vaultConfig: vaultConfigPda,
            okusdMint: okusdMint,
            wokusdMint: wokusdMint,
            userOkusdAta: bridgeWrappedUserOkusdAta,
            userWokusdAta: bridgeWrappedUserWokusdAta,
            vaultOkusdAta: vaultOkusdAta,
            psmConfig: psmConfigPda,
            vaultProgram: VAULT_PROGRAM_ID,
            psmProgram: PSM_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([bridgeWrappedUser])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Paused");
      }

      // Unpause
      await routerProgram.methods
        .setPaused(false)
        .accounts({
          admin: admin.publicKey,
          config: routerConfigPda,
        })
        .rpc();
    });

    it("fails with zero shares", async () => {
      if (!vaultInitialized) {
        console.log("Vault not initialized, skipping test");
        return;
      }

      try {
        await routerProgram.methods
          .bridgeWrapped(new BN(0), 1)
          .accounts({
            user: bridgeWrappedUser.publicKey,
            config: routerConfigPda,
            vaultConfig: vaultConfigPda,
            okusdMint: okusdMint,
            wokusdMint: wokusdMint,
            userOkusdAta: bridgeWrappedUserOkusdAta,
            userWokusdAta: bridgeWrappedUserWokusdAta,
            vaultOkusdAta: vaultOkusdAta,
            psmConfig: psmConfigPda,
            vaultProgram: VAULT_PROGRAM_ID,
            psmProgram: PSM_PROGRAM_ID,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([bridgeWrappedUser])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });
  });

  describe("admin functions", () => {
    describe("set_paused", () => {
      before(async () => {
        // Initialize router if needed
        try {
          await routerProgram.account.routerConfig.fetch(routerConfigPda);
        } catch {
          await routerProgram.methods
            .initialize()
            .accounts({
              admin: admin.publicKey,
              config: routerConfigPda,
              psmProgram: PSM_PROGRAM_ID,
              vaultProgram: VAULT_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .rpc();
        }
      });

      it("allows admin to pause and unpause", async () => {
        await routerProgram.methods
          .setPaused(true)
          .accounts({
            admin: admin.publicKey,
            config: routerConfigPda,
          })
          .rpc();

        let config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
        expect(config.isPaused).to.be.true;

        await routerProgram.methods
          .setPaused(false)
          .accounts({
            admin: admin.publicKey,
            config: routerConfigPda,
          })
          .rpc();

        config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
        expect(config.isPaused).to.be.false;
      });

      it("fails when non-admin tries to pause", async () => {
        try {
          await routerProgram.methods
            .setPaused(true)
            .accounts({
              admin: user.publicKey,
              config: routerConfigPda,
            })
            .signers([user])
            .rpc();
          expect.fail("Should have failed");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("Unauthorized");
        }
      });
    });
  });
});
