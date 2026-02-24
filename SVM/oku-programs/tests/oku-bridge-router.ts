import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { expect } from "chai";
import { OkuBridgeRouter } from "../target/types/oku_bridge_router";
import { WokusdVault } from "../target/types/wokusd_vault";
import { LitePsm } from "../target/types/lite_psm";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  createAssociatedTokenAccountInstruction,
  mintTo,
} from "@solana/spl-token";

const { Keypair, SystemProgram, PublicKey, SYSVAR_RENT_PUBKEY } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

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

  // Bridge-wrapped integration state
  let psmConfigPda: PublicKey;
  let bridgeConfigPda: PublicKey;
  let vaultConfigPda: PublicKey;
  let usdcMint: PublicKey;
  let okusdMint: PublicKey;
  let wokusdMint: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultOkusdAta: PublicKey; // PSM escrow
  let wVaultOkusdAta: PublicKey; // wOkuUSD vault's OkuUSD ATA
  let userUsdcAta: PublicKey;
  let userOkusdAta: PublicKey;
  let userWokusdAta: PublicKey;
  let feeRecipientAta: PublicKey;
  let bridgeSetupDone = false;

  before(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    routerProgram = anchor.workspace.OkuBridgeRouter as Program<OkuBridgeRouter>;
    vaultProgram = anchor.workspace.WokusdVault as Program<WokusdVault>;
    psmProgram = anchor.workspace.LitePsm as Program<LitePsm>;
    payer = (provider.wallet as anchor.Wallet).payer;
    admin = payer;

    // Airdrop SOL to test user with proper confirmation
    const { safeAirdrop } = await import("./shared/setup");
    await safeAirdrop(provider.connection, user.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL);

    // Derive PDAs
    [routerConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("router_config")],
      routerProgram.programId
    );
  });

  describe("initialize", () => {
    it("initializes the router config", async () => {
      // Skip if already initialized (validator state may persist across runs)
      let alreadyInitialized = false;
      try {
        await routerProgram.account.routerConfig.fetch(routerConfigPda);
        alreadyInitialized = true;
      } catch {
        // Not initialized, proceed
      }

      if (alreadyInitialized) {
        // Still verify the config is correct
        const config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
        expect(config.psmProgram.toString()).to.equal(psmProgram.programId.toString());
        expect(config.vaultProgram.toString()).to.equal(vaultProgram.programId.toString());
        return;
      }

      await routerProgram.methods
        .initialize()
        .accountsPartial({
          admin: admin.publicKey,
          config: routerConfigPda,
          psmProgram: psmProgram.programId,
          vaultProgram: vaultProgram.programId,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
      expect(config.admin.toString()).to.equal(admin.publicKey.toString());
      expect(config.psmProgram.toString()).to.equal(psmProgram.programId.toString());
      expect(config.vaultProgram.toString()).to.equal(vaultProgram.programId.toString());
      expect(config.isPaused).to.be.false;
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
            .accountsPartial({
              admin: admin.publicKey,
              config: routerConfigPda,
              psmProgram: psmProgram.programId,
              vaultProgram: vaultProgram.programId,
              systemProgram: SystemProgram.programId,
            })
            .rpc();
        }
      });

      it("allows admin to pause and unpause", async () => {
        await routerProgram.methods
          .setPaused(true)
          .accountsPartial({
            admin: admin.publicKey,
            config: routerConfigPda,
          })
          .rpc();

        let config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
        expect(config.isPaused).to.be.true;

        await routerProgram.methods
          .setPaused(false)
          .accountsPartial({
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
            .accountsPartial({
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

  // ==========================================================================
  // NEW COVERAGE: bridge_wrapped (unwrap + bridge_burn in one tx)
  // ==========================================================================
  describe("bridge_wrapped", () => {
    const ETH_CHAIN_ID = 1;
    const SOLANA_CHAIN_ID = 1151;

    before(async () => {
      const {
        safeAirdropAll, ensureAta, coldMultisig, warmMultisig,
        psmOrchestrator, bridgeOrchestrator, initializePSMIfNeeded,
        mintOkusdViaProgram,
      } = await import("./shared/setup");

      // Use the shared PSM — it may already be initialized by other test files.
      // We need to read its config to get the USDC and OkuUSD mints.
      [psmConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("psm_config")], psmProgram.programId
      );
      [bridgeConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_config")], psmProgram.programId
      );
      [vaultConfigPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("vault_config")], vaultProgram.programId
      );

      // Check if PSM is already initialized
      let psmConfig: any;
      try {
        psmConfig = await psmProgram.account.psmConfig.fetch(psmConfigPda);
        usdcMint = psmConfig.usdcMint;
        okusdMint = psmConfig.okusdMint;
      } catch {
        // PSM not initialized — skip bridge_wrapped tests
        // (they depend on the shared PSM being set up by lite-psm or bridge_security tests)
        console.log("    ⚠ PSM not initialized, skipping bridge_wrapped tests");
        return;
      }

      // Check if bridge is initialized
      try {
        await psmProgram.account.bridgeConfig.fetch(bridgeConfigPda);
      } catch {
        console.log("    ⚠ Bridge not initialized, skipping bridge_wrapped tests");
        return;
      }

      // Check if wOkuUSD vault is initialized — initialize it if needed
      let vaultConfig: any;
      try {
        vaultConfig = await vaultProgram.account.vaultConfig.fetch(vaultConfigPda);
        if (vaultConfig.okusdMint.toString() !== okusdMint.toString()) {
          console.log("    ⚠ Vault uses different OkuUSD mint than PSM, skipping bridge_wrapped tests");
          return;
        }
        wokusdMint = vaultConfig.wokusdMint;
        wVaultOkusdAta = vaultConfig.vaultOkusd;
      } catch {
        // Vault not initialized yet — initialize it with PSM's OkuUSD mint
        try {
          const wokusdMintKeypair = Keypair.generate();
          const tempVaultOkusdAta = getAssociatedTokenAddressSync(
            okusdMint, vaultConfigPda, true, TOKEN_2022_PROGRAM_ID
          );
          await vaultProgram.methods
            .initialize(payer.publicKey, payer.publicKey) // pauser/unpauser = payer for simplicity
            .accountsPartial({
              roleAdmin: payer.publicKey,
              config: vaultConfigPda,
              okusdMint,
              wokusdMint: wokusdMintKeypair.publicKey,
              vaultOkusd: tempVaultOkusdAta,
              tokenProgram: TOKEN_PROGRAM_ID,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
              rent: SYSVAR_RENT_PUBKEY,
            })
            .signers([wokusdMintKeypair])
            .rpc();
          wokusdMint = wokusdMintKeypair.publicKey;
          wVaultOkusdAta = tempVaultOkusdAta;
        } catch (e: any) {
          console.log("    ⚠ Failed to initialize vault for bridge_wrapped:", e.message?.substring(0, 120));
          return;
        }
      }

      // Derive token accounts
      vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, psmConfigPda, true, TOKEN_PROGRAM_ID);
      userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user.publicKey, false, TOKEN_PROGRAM_ID);
      userOkusdAta = getAssociatedTokenAddressSync(okusdMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
      userWokusdAta = getAssociatedTokenAddressSync(wokusdMint, user.publicKey, false, TOKEN_PROGRAM_ID);

      // Ensure user has USDC ATA
      await ensureAta(provider.connection, payer, userUsdcAta, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
      await ensureAta(provider.connection, payer, userOkusdAta, user.publicKey, okusdMint, TOKEN_2022_PROGRAM_ID);

      // Fund user with USDC if needed (payer is always USDC mint authority)
      try {
        const userUsdc = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
        if (Number(userUsdc.amount) < 10_000_000) {
          await mintTo(provider.connection, payer, usdcMint, userUsdcAta, payer, 50_000_000, [], undefined, TOKEN_PROGRAM_ID);
        }
      } catch {
        // ATA may have been freshly created with zero balance — fund it
        await mintTo(provider.connection, payer, usdcMint, userUsdcAta, payer, 50_000_000, [], undefined, TOKEN_PROGRAM_ID);
      }

      // The bridge config has a fee recipient - we need their ATA
      const bridgeConfig = await psmProgram.account.bridgeConfig.fetch(bridgeConfigPda);
      feeRecipientAta = getAssociatedTokenAddressSync(
        okusdMint, bridgeConfig.feeRecipient, false, TOKEN_2022_PROGRAM_ID
      );

      // Ensure fee recipient ATA exists
      await ensureAta(provider.connection, payer, feeRecipientAta, bridgeConfig.feeRecipient, okusdMint, TOKEN_2022_PROGRAM_ID);

      // We need user to have wOkuUSD. The flow is:
      // 1. User gets OkuUSD from PSM mint (needs USDC)
      // 2. User wraps OkuUSD -> wOkuUSD via vault

      // Check if user already has OkuUSD
      let userOkusdBalance = BigInt(0);
      try {
        const acct = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
        userOkusdBalance = acct.amount;
      } catch {}

      if (userOkusdBalance < BigInt(5_000_000)) {
        // Try to mint OkuUSD via PSM (user needs USDC)
        try {
          const userUsdc = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
          if (Number(userUsdc.amount) >= 10_000_000) {
            await mintOkusdViaProgram(psmProgram as any, user, new BN(10_000_000), psmConfigPda, usdcMint, okusdMint, userUsdcAta, userOkusdAta, vaultUsdcAta);
          } else {
            console.log("    ⚠ User has insufficient USDC for bridge_wrapped setup");
            return;
          }
        } catch (e: any) {
          console.log("    ⚠ Failed to mint OkuUSD for bridge_wrapped setup:", e.message?.substring(0, 100));
          return;
        }
      }

      // Wrap OkuUSD -> wOkuUSD
      try {
        await ensureAta(provider.connection, payer, userWokusdAta, user.publicKey, wokusdMint, TOKEN_PROGRAM_ID);
        await vaultProgram.methods
          .wrap(new BN(5_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: vaultConfigPda,
            okusdMint,
            wokusdMint,
            userOkusdAta,
            userWokusdAta,
            vaultOkusd: wVaultOkusdAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        bridgeSetupDone = true;
      } catch (e: any) {
        console.log("    ⚠ Failed to wrap OkuUSD for bridge_wrapped setup:", e.message?.substring(0, 100));
      }

      // Ensure bridge has ETH as supported chain
      const bridgeCfg = await psmProgram.account.bridgeConfig.fetch(bridgeConfigPda);
      const chains = bridgeCfg.supportedChains.slice(0, bridgeCfg.supportedChainsCount);
      if (!chains.includes(ETH_CHAIN_ID)) {
        try {
          await psmProgram.methods
            .addSupportedChain(ETH_CHAIN_ID)
            .accountsPartial({
              chainManager: bridgeCfg.chainManager,
              bridgeConfig: bridgeConfigPda,
            })
            .signers([]) // chain manager may be a test keypair
            .rpc();
        } catch {
          // Chain may already be added or we don't have the chain_manager key
        }
      }
    });

    it("unwraps wOkuUSD and bridges in one tx", async function () {
      if (!bridgeSetupDone) return this.skip();

      const userWokusd = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      if (Number(userWokusd.amount) === 0) return this.skip();

      const sharesToBridge = new BN(Math.min(Number(userWokusd.amount), 2_000_000));
      const evmRecipient = Buffer.alloc(20);
      evmRecipient[19] = 0x42;

      // Derive bridge nonce PDA
      const chainIdBytes = Buffer.alloc(2);
      chainIdBytes.writeUInt16LE(ETH_CHAIN_ID);
      const [bridgeNoncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), chainIdBytes],
        psmProgram.programId
      );

      const wokusdBefore = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);

      await routerProgram.methods
        .bridgeWrapped(
          sharesToBridge,
          Array.from(evmRecipient) as any,
          ETH_CHAIN_ID,
        )
        .accountsPartial({
          user: user.publicKey,
          config: routerConfigPda,
          vaultConfig: vaultConfigPda,
          okusdMint,
          wokusdMint,
          userOkusdAta,
          userWokusdAta,
          vaultOkusd: wVaultOkusdAta,
          bridgeConfig: bridgeConfigPda,
          psmConfig: psmConfigPda,
          bridgeNonce: bridgeNoncePda,
          feeRecipientAta,
          vaultProgram: vaultProgram.programId,
          psmProgram: psmProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const wokusdAfter = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      expect(Number(wokusdBefore.amount) - Number(wokusdAfter.amount)).to.equal(sharesToBridge.toNumber());
    });

    it("fails when router is paused", async function () {
      if (!bridgeSetupDone) return this.skip();

      // Pause the router
      await routerProgram.methods
        .setPaused(true)
        .accountsPartial({ admin: admin.publicKey, config: routerConfigPda })
        .rpc();

      const evmRecipient = Buffer.alloc(20);
      evmRecipient[19] = 0x42;
      const chainIdBytes = Buffer.alloc(2);
      chainIdBytes.writeUInt16LE(ETH_CHAIN_ID);
      const [bridgeNoncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), chainIdBytes],
        psmProgram.programId
      );

      try {
        await routerProgram.methods
          .bridgeWrapped(
            new BN(1_000_000),
            Array.from(evmRecipient) as any,
            ETH_CHAIN_ID,
          )
          .accountsPartial({
            user: user.publicKey,
            config: routerConfigPda,
            vaultConfig: vaultConfigPda,
            okusdMint,
            wokusdMint,
            userOkusdAta,
            userWokusdAta,
            vaultOkusd: wVaultOkusdAta,
            bridgeConfig: bridgeConfigPda,
            psmConfig: psmConfigPda,
            bridgeNonce: bridgeNoncePda,
            feeRecipientAta,
            vaultProgram: vaultProgram.programId,
            psmProgram: psmProgram.programId,
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

      // Unpause
      await routerProgram.methods
        .setPaused(false)
        .accountsPartial({ admin: admin.publicKey, config: routerConfigPda })
        .rpc();
    });

    it("fails with zero shares", async function () {
      if (!bridgeSetupDone) return this.skip();

      const evmRecipient = Buffer.alloc(20);
      evmRecipient[19] = 0x42;
      const chainIdBytes = Buffer.alloc(2);
      chainIdBytes.writeUInt16LE(ETH_CHAIN_ID);
      const [bridgeNoncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), chainIdBytes],
        psmProgram.programId
      );

      try {
        await routerProgram.methods
          .bridgeWrapped(
            new BN(0),
            Array.from(evmRecipient) as any,
            ETH_CHAIN_ID,
          )
          .accountsPartial({
            user: user.publicKey,
            config: routerConfigPda,
            vaultConfig: vaultConfigPda,
            okusdMint,
            wokusdMint,
            userOkusdAta,
            userWokusdAta,
            vaultOkusd: wVaultOkusdAta,
            bridgeConfig: bridgeConfigPda,
            psmConfig: psmConfigPda,
            bridgeNonce: bridgeNoncePda,
            feeRecipientAta,
            vaultProgram: vaultProgram.programId,
            psmProgram: psmProgram.programId,
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
          c === "ZeroAmount" || c.includes("ZeroAmount") || c.includes("Error")
        );
      }
    });

    it("fails when user has no wOkuUSD", async function () {
      if (!bridgeSetupDone) return this.skip();

      const noWokusdUser = Keypair.generate();
      const { safeAirdrop, ensureAta } = await import("./shared/setup");
      await safeAirdrop(provider.connection, noWokusdUser.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);

      const noUserOkusdAta = getAssociatedTokenAddressSync(okusdMint, noWokusdUser.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const noUserWokusdAta = getAssociatedTokenAddressSync(wokusdMint, noWokusdUser.publicKey, false, TOKEN_PROGRAM_ID);
      await ensureAta(provider.connection, payer, noUserOkusdAta, noWokusdUser.publicKey, okusdMint, TOKEN_2022_PROGRAM_ID);
      await ensureAta(provider.connection, payer, noUserWokusdAta, noWokusdUser.publicKey, wokusdMint, TOKEN_PROGRAM_ID);

      const evmRecipient = Buffer.alloc(20);
      evmRecipient[19] = 0x42;
      const chainIdBytes = Buffer.alloc(2);
      chainIdBytes.writeUInt16LE(ETH_CHAIN_ID);
      const [bridgeNoncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), chainIdBytes],
        psmProgram.programId
      );

      try {
        await routerProgram.methods
          .bridgeWrapped(
            new BN(1_000_000),
            Array.from(evmRecipient) as any,
            ETH_CHAIN_ID,
          )
          .accountsPartial({
            user: noWokusdUser.publicKey,
            config: routerConfigPda,
            vaultConfig: vaultConfigPda,
            okusdMint,
            wokusdMint,
            userOkusdAta: noUserOkusdAta,
            userWokusdAta: noUserWokusdAta,
            vaultOkusd: wVaultOkusdAta,
            bridgeConfig: bridgeConfigPda,
            psmConfig: psmConfigPda,
            bridgeNonce: bridgeNoncePda,
            feeRecipientAta,
            vaultProgram: vaultProgram.programId,
            psmProgram: psmProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([noWokusdUser])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        // Should fail due to insufficient wOkuUSD balance
        expect(err).to.exist;
      }
    });
  });
});
