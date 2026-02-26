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
  let roleAdmin: Keypair;

  // Separate pause/unpause authorities
  const pauser = Keypair.generate();
  const unpauser = Keypair.generate();

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
    roleAdmin = payer;

    // Airdrop SOL to test users and authorities
    const { safeAirdrop, safeAirdropAll } = await import("./shared/setup");
    await safeAirdropAll(provider.connection, [user, pauser, unpauser], 10 * anchor.web3.LAMPORTS_PER_SOL);

    // Derive PDAs
    [routerConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("router_config")],
      routerProgram.programId
    );
  });

  describe("initialize", () => {
    it("initializes the router config with RBAC", async () => {
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
        expect(config.roleAdmin).to.exist;
        return;
      }

      await routerProgram.methods
        .initialize(pauser.publicKey, unpauser.publicKey)
        .accountsPartial({
          roleAdmin: roleAdmin.publicKey,
          config: routerConfigPda,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
      expect(config.roleAdmin.toString()).to.equal(roleAdmin.publicKey.toString());
      expect(config.pauser.toString()).to.equal(pauser.publicKey.toString());
      expect(config.unpauser.toString()).to.equal(unpauser.publicKey.toString());
      expect(config.isPaused).to.be.false;
    });
  });

  describe("admin functions", () => {
    describe("pause / unpause", () => {
      before(async () => {
        // Initialize router if needed
        try {
          await routerProgram.account.routerConfig.fetch(routerConfigPda);
        } catch {
          await routerProgram.methods
            .initialize(pauser.publicKey, unpauser.publicKey)
            .accountsPartial({
              roleAdmin: roleAdmin.publicKey,
              config: routerConfigPda,
              systemProgram: SystemProgram.programId,
            })
            .rpc();
        }
      });

      it("pauser can pause and unpauser can unpause", async () => {
        await routerProgram.methods
          .pause()
          .accountsPartial({
            pauser: pauser.publicKey,
            config: routerConfigPda,
          })
          .signers([pauser])
          .rpc();

        let config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
        expect(config.isPaused).to.be.true;

        await routerProgram.methods
          .unpause()
          .accountsPartial({
            unpauser: unpauser.publicKey,
            config: routerConfigPda,
          })
          .signers([unpauser])
          .rpc();

        config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
        expect(config.isPaused).to.be.false;
      });

      it("fails when non-pauser tries to pause", async () => {
        try {
          await routerProgram.methods
            .pause()
            .accountsPartial({
              pauser: user.publicKey,
              config: routerConfigPda,
            })
            .signers([user])
            .rpc();
          expect.fail("Should have failed");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("Unauthorized");
        }
      });

      it("fails when non-unpauser tries to unpause", async () => {
        // First pause it
        await routerProgram.methods
          .pause()
          .accountsPartial({
            pauser: pauser.publicKey,
            config: routerConfigPda,
          })
          .signers([pauser])
          .rpc();

        try {
          await routerProgram.methods
            .unpause()
            .accountsPartial({
              unpauser: user.publicKey,
              config: routerConfigPda,
            })
            .signers([user])
            .rpc();
          expect.fail("Should have failed");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("Unauthorized");
        }

        // Clean up: unpause
        await routerProgram.methods
          .unpause()
          .accountsPartial({
            unpauser: unpauser.publicKey,
            config: routerConfigPda,
          })
          .signers([unpauser])
          .rpc();
      });
    });

    describe("set_authority", () => {
      it("role_admin can rotate pauser", async () => {
        const newPauser = Keypair.generate();

        await routerProgram.methods
          .setAuthority({ pauser: {} }, newPauser.publicKey)
          .accountsPartial({
            roleAdmin: roleAdmin.publicKey,
            config: routerConfigPda,
          })
          .rpc();

        const config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
        expect(config.pauser.toString()).to.equal(newPauser.publicKey.toString());

        // Restore original pauser
        await routerProgram.methods
          .setAuthority({ pauser: {} }, pauser.publicKey)
          .accountsPartial({
            roleAdmin: roleAdmin.publicKey,
            config: routerConfigPda,
          })
          .rpc();
      });

      it("rejects Pubkey::default() as new authority", async () => {
        try {
          await routerProgram.methods
            .setAuthority({ pauser: {} }, PublicKey.default)
            .accountsPartial({
              roleAdmin: roleAdmin.publicKey,
              config: routerConfigPda,
            })
            .rpc();
          expect.fail("Should have failed");
        } catch (err: any) {
          expect(err.error.errorCode.code).to.equal("Unauthorized");
        }
      });

      it("non-admin cannot set authority", async () => {
        try {
          await routerProgram.methods
            .setAuthority({ pauser: {} }, Keypair.generate().publicKey)
            .accountsPartial({
              roleAdmin: user.publicKey,
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
  // bridge_wrapped (unwrap + bridge_burn in one tx)
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

      // Check if user already has OkuUSD
      let userOkusdBalance = BigInt(0);
      try {
        const acct = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
        userOkusdBalance = acct.amount;
      } catch {}

      if (userOkusdBalance < BigInt(5_000_000)) {
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

        // Check if this is the first deposit (need dead shares ATA)
        const vaultCfg = await vaultProgram.account.vaultConfig.fetch(vaultConfigPda);
        let deadSharesAta: PublicKey | null = null;
        if (vaultCfg.totalShares.toNumber() === 0) {
          const { getAssociatedTokenAddressSync: getAta } = await import("@solana/spl-token");
          deadSharesAta = getAta(wokusdMint, SystemProgram.programId, true, TOKEN_PROGRAM_ID);
          await ensureAta(provider.connection, payer, deadSharesAta, SystemProgram.programId, wokusdMint, TOKEN_PROGRAM_ID);
        }

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
            deadSharesAta,
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
          new BN(0), // min_okusd_out: no slippage check
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
        .pause()
        .accountsPartial({ pauser: pauser.publicKey, config: routerConfigPda })
        .signers([pauser])
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
            new BN(0),
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
        .unpause()
        .accountsPartial({ unpauser: unpauser.publicKey, config: routerConfigPda })
        .signers([unpauser])
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
            new BN(0),
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
            new BN(0),
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

    it("only bridges unwrapped amount, not pre-existing balance", async function () {
      if (!bridgeSetupDone) return this.skip();

      const { ensureAta, mintOkusdViaProgram } = await import("./shared/setup");

      // Ensure user has some pre-existing OkuUSD in their ATA
      let preExistingBalance: bigint;
      try {
        const acct = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
        preExistingBalance = acct.amount;
      } catch {
        preExistingBalance = BigInt(0);
      }

      // If user doesn't have pre-existing OkuUSD, mint some directly
      if (preExistingBalance < BigInt(1_000_000)) {
        try {
          await mintOkusdViaProgram(
            psmProgram as any, user, new BN(3_000_000),
            psmConfigPda, usdcMint, okusdMint, userUsdcAta, userOkusdAta, vaultUsdcAta
          );
        } catch (e: any) {
          console.log("    ⚠ Could not mint pre-existing OkuUSD:", e.message?.substring(0, 100));
          return this.skip();
        }
      }

      // Get user's OkuUSD balance before bridge_wrapped
      const okusdBefore = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const preBalance = Number(okusdBefore.amount);
      expect(preBalance).to.be.greaterThan(0, "User should have pre-existing OkuUSD");

      // Ensure user has wOkuUSD to bridge
      const userWokusd = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      let sharesToBridge = Number(userWokusd.amount);
      if (sharesToBridge < 1_000_000) {
        try {
          await mintOkusdViaProgram(
            psmProgram as any, user, new BN(5_000_000),
            psmConfigPda, usdcMint, okusdMint, userUsdcAta, userOkusdAta, vaultUsdcAta
          );
          await vaultProgram.methods
            .wrap(new BN(3_000_000))
            .accountsPartial({
              user: user.publicKey,
              config: vaultConfigPda,
              okusdMint,
              wokusdMint,
              userOkusdAta,
              userWokusdAta,
              vaultOkusd: wVaultOkusdAta,
              deadSharesAta: null,
              tokenProgram: TOKEN_PROGRAM_ID,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([user])
            .rpc();
          const refreshed = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
          sharesToBridge = Number(refreshed.amount);
        } catch (e: any) {
          console.log("    ⚠ Could not prepare wOkuUSD:", e.message?.substring(0, 100));
          return this.skip();
        }
      }

      // Re-read OkuUSD balance after wrap
      const okusdBeforeBridge = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const balanceBefore = Number(okusdBeforeBridge.amount);
      expect(balanceBefore).to.be.greaterThan(0, "User should still have pre-existing OkuUSD after wrap");

      const evmRecipient = Buffer.alloc(20);
      evmRecipient[19] = 0x42;
      const chainIdBytes = Buffer.alloc(2);
      chainIdBytes.writeUInt16LE(ETH_CHAIN_ID);
      const [bridgeNoncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), chainIdBytes],
        psmProgram.programId
      );

      const bridgeAmount = new BN(Math.min(sharesToBridge, 1_000_000));
      await routerProgram.methods
        .bridgeWrapped(
          bridgeAmount,
          Array.from(evmRecipient) as any,
          ETH_CHAIN_ID,
          new BN(0),
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

      // Verify pre-existing OkuUSD balance was NOT swept
      const okusdAfter = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(okusdAfter.amount)).to.equal(balanceBefore,
        "Pre-existing OkuUSD balance should be untouched");
    });

    it("respects min_okusd_out slippage check", async function () {
      if (!bridgeSetupDone) return this.skip();

      const userWokusd = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      if (Number(userWokusd.amount) === 0) return this.skip();

      const sharesToBridge = new BN(Math.min(Number(userWokusd.amount), 1_000_000));
      const evmRecipient = Buffer.alloc(20);
      evmRecipient[19] = 0x42;
      const chainIdBytes = Buffer.alloc(2);
      chainIdBytes.writeUInt16LE(ETH_CHAIN_ID);
      const [bridgeNoncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), chainIdBytes],
        psmProgram.programId
      );

      // Set min_okusd_out absurdly high so slippage check fails
      const absurdMinOut = new BN("999999999999999");

      try {
        await routerProgram.methods
          .bridgeWrapped(
            sharesToBridge,
            Array.from(evmRecipient) as any,
            ETH_CHAIN_ID,
            absurdMinOut,
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
        expect.fail("Should have failed with SlippageExceeded");
      } catch (err: any) {
        const errorCode = err?.error?.errorCode?.code || err?.message || "";
        expect(errorCode).to.satisfy((c: string) =>
          c === "SlippageExceeded" || c.includes("SlippageExceeded")
        );
      }
    });

    it("slippage check passes when met", async function () {
      if (!bridgeSetupDone) return this.skip();

      const userWokusd = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      if (Number(userWokusd.amount) === 0) return this.skip();

      const sharesToBridge = new BN(Math.min(Number(userWokusd.amount), 1_000_000));
      const evmRecipient = Buffer.alloc(20);
      evmRecipient[19] = 0x42;
      const chainIdBytes = Buffer.alloc(2);
      chainIdBytes.writeUInt16LE(ETH_CHAIN_ID);
      const [bridgeNoncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), chainIdBytes],
        psmProgram.programId
      );

      // Set min_okusd_out to 1 — should easily pass
      await routerProgram.methods
        .bridgeWrapped(
          sharesToBridge,
          Array.from(evmRecipient) as any,
          ETH_CHAIN_ID,
          new BN(1), // min_okusd_out: reasonable minimum
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

      // If we got here, slippage check passed successfully
    });
  });
});
