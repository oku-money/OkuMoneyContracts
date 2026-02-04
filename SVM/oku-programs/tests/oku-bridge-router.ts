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
  let vaultUsdcAta: PublicKey;

  // User accounts
  let userOkusdAta: PublicKey;

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

    // Derive user OkuUSD account
    userOkusdAta = getAssociatedTokenAddressSync(
      okusdMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
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

      // Create user's OkuUSD account
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

  // Note: bridge_wrapped tests removed - functionality is covered by:
  // - vault.unwrap tested in wokusd-vault.ts
  // - PSM.bridge_burn tested in lite-psm.ts

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
