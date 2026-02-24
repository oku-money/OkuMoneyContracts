import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { expect } from "chai";
import { OkuBridgeRouter } from "../target/types/oku_bridge_router";
import { WokusdVault } from "../target/types/wokusd_vault";
import { LitePsm } from "../target/types/lite_psm";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
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
});
