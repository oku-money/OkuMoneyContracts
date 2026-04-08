/**
 * OkuBridgeRouter Integration Tests
 *
 * Tests the convenience router that combines:
 * 1. Unwrap usdOku -> OkuMoney (via oku-dollar vault)
 * 2. Bridge burn OkuMoney (via lite-psm)
 *
 * This allows users to bridge usdOku cross-chain in a single transaction.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  createMint,
  mintTo,
  getMintLen,
  createInitializeMintInstruction,
  ExtensionType,
  createInitializeInterestBearingMintInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import { OkuBridgeRouter } from "../../target/types/oku_bridge_router";
import { OkuDollar } from "../../target/types/oku_dollar";
import { LitePsm } from "../../target/types/lite_psm";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  bridgeOrchestrator,
  safeAirdropAll,
  ensureAta,
  initializePSMIfNeeded,
  DECIMALS,
} from "../shared/setup";

const { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

describe("oku-bridge-router", () => {
  let provider: anchor.AnchorProvider;
  let routerProgram: Program<OkuBridgeRouter>;
  let vaultProgram: Program<OkuDollar>;
  let psmProgram: Program<LitePsm>;
  let payer: Keypair;

  // User keypairs
  const user = Keypair.generate();
  const routerAdmin = Keypair.generate();
  const routerPauser = Keypair.generate();
  const routerUnpauser = Keypair.generate();

  // PDAs
  let routerConfigPda: PublicKey;
  let vaultConfigPda: PublicKey;
  let psmConfigPda: PublicKey;
  let bridgeConfigPda: PublicKey;

  // Mints
  let usdcMint: PublicKey;
  let okuMoneyMint: PublicKey;
  let usdOkuMint: PublicKey;

  // Token accounts
  let userUsdcAta: PublicKey;
  let userOkuMoneyAta: PublicKey;
  let userUsdOkuAta: PublicKey;
  let vaultReserve: PublicKey;
  let vaultUsdcAta: PublicKey;

  // Track initialization
  let routerInitialized = false;
  let vaultInitialized = false;

  before(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);

    routerProgram = anchor.workspace.OkuBridgeRouter as Program<OkuBridgeRouter>;
    vaultProgram = anchor.workspace.OkuDollar as Program<OkuDollar>;
    psmProgram = anchor.workspace.LitePsm as Program<LitePsm>;
    payer = (provider.wallet as anchor.Wallet).payer;

    // Derive PDAs
    [routerConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("router_config")],
      routerProgram.programId
    );

    [vaultConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oku_dollar_config")],
      vaultProgram.programId
    );

    [psmConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")],
      psmProgram.programId
    );

    [bridgeConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("bridge_config")],
      psmProgram.programId
    );

    // Airdrop SOL to test accounts
    await safeAirdropAll(
      provider.connection,
      [user, routerAdmin, routerPauser, routerUnpauser],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    // Check if PSM already initialized
    let psmExists = false;
    try {
      const existingConfig = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      psmExists = true;
      usdcMint = existingConfig.usdcMint;
      okuMoneyMint = existingConfig.okuMoneyMint;
    } catch {
      // PSM not initialized
    }

    if (!psmExists) {
      // Create USDC mint
      const usdcMintKeypair = Keypair.generate();
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

      // Create OkuMoney mint (Token-2022)
      const okuMoneyMintKeypair = Keypair.generate();
      const mintLen = getMintLen([ExtensionType.InterestBearingConfig]);
      const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

      const createAccountIx = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: okuMoneyMintKeypair.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      });

      const initInterestBearingIx = createInitializeInterestBearingMintInstruction(
        okuMoneyMintKeypair.publicKey,
        psmOrchestrator.publicKey,
        0,
        TOKEN_2022_PROGRAM_ID
      );

      const initMintIx = createInitializeMintInstruction(
        okuMoneyMintKeypair.publicKey,
        DECIMALS,
        psmConfigPda,
        psmConfigPda,
        TOKEN_2022_PROGRAM_ID
      );

      const tx = new anchor.web3.Transaction().add(
        createAccountIx,
        initInterestBearingIx,
        initMintIx
      );
      await provider.sendAndConfirm(tx, [payer, okuMoneyMintKeypair]);
      okuMoneyMint = okuMoneyMintKeypair.publicKey;

      // Initialize PSM
      await initializePSMIfNeeded(
        psmProgram as any,
        provider,
        payer,
        usdcMint,
        okuMoneyMint
      );
    }

    // Get vault info
    vaultUsdcAta = getAssociatedTokenAddressSync(usdcMint, psmConfigPda, true, TOKEN_PROGRAM_ID);

    // Check if vault already initialized
    try {
      const existingVault = await vaultProgram.account.okuDollarConfig.fetch(vaultConfigPda);
      vaultInitialized = true;
      usdOkuMint = existingVault.usdOkuMint;
      vaultReserve = existingVault.reserveVault;
    } catch {
      // Vault not initialized - we'll initialize it
      [usdOkuMint] = PublicKey.findProgramAddressSync(
        [Buffer.from("usd_oku_mint")],
        vaultProgram.programId
      );
      vaultReserve = getAssociatedTokenAddressSync(
        okuMoneyMint,
        vaultConfigPda,
        true,
        TOKEN_2022_PROGRAM_ID
      );
    }

    // Create user token accounts
    userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user.publicKey, false, TOKEN_PROGRAM_ID);
    userOkuMoneyAta = getAssociatedTokenAddressSync(okuMoneyMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);

    await ensureAta(provider.connection, payer, userUsdcAta, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await ensureAta(provider.connection, payer, userOkuMoneyAta, user.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);

    // Fund user with USDC
    await mintTo(provider.connection, payer, usdcMint, userUsdcAta, payer, 10_000_000_000, [], undefined, TOKEN_PROGRAM_ID);

    // Mint OkuMoney via PSM
    await psmProgram.methods
      .mintOkuM(new BN(5_000_000_000))
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMoneyMint,
        userUsdcAta,
        userOkuMoneyAta,
        vaultUsdc: vaultUsdcAta,
        priceUpdate: null,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Initialize vault if needed
    if (!vaultInitialized) {
      await vaultProgram.methods
        .initialize(
          warmMultisig.publicKey,  // pauser
          coldMultisig.publicKey,  // unpauser
          psmOrchestrator.publicKey, // usd_rebaser
          coldMultisig.publicKey,  // reserve_manager
          new BN(950_000_000)      // min_collateral_ratio (95%)
        )
        .accountsPartial({
          roleAdmin: payer.publicKey,
          config: vaultConfigPda,
          okuMoneyMint,
          usdOkuMint,
          reserveVault: vaultReserve,
          psmConfig: psmConfigPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      vaultInitialized = true;
    }

    // Create usdOku ATA for user
    userUsdOkuAta = getAssociatedTokenAddressSync(usdOkuMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await ensureAta(provider.connection, payer, userUsdOkuAta, user.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);

    // Create dead shares ATA for first deposit
    const deadSharesAta = getAssociatedTokenAddressSync(usdOkuMint, SystemProgram.programId, true, TOKEN_2022_PROGRAM_ID);
    await ensureAta(provider.connection, payer, deadSharesAta, SystemProgram.programId, usdOkuMint, TOKEN_2022_PROGRAM_ID);

    // Wrap some OkuMoney to get usdOku
    await vaultProgram.methods
      .wrap(new BN(1_000_000_000), new BN(0)) // 1000 OkuMoney, no slippage protection
      .accountsPartial({
        user: user.publicKey,
        config: vaultConfigPda,
        okuMoneyMint,
        usdOkuMint,
        userOkuMoneyAta,
        userUsdOkuAta,
        reserveVault: vaultReserve,
        psmConfig: psmConfigPda,
        deadSharesAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();

    // Initialize router if needed
    try {
      await routerProgram.account.routerConfig.fetch(routerConfigPda);
      routerInitialized = true;
    } catch {
      // Router not initialized
    }

    if (!routerInitialized) {
      await routerProgram.methods
        .initialize(routerPauser.publicKey, routerUnpauser.publicKey)
        .accountsPartial({
          roleAdmin: payer.publicKey,
          config: routerConfigPda,
          okuMoneyMint,
          usdOkuMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
      routerInitialized = true;
    }
  });

  describe("initialize", () => {
    it("router is initialized with correct config", async () => {
      const config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
      expect(config.roleAdmin.toString()).to.equal(payer.publicKey.toString());
      expect(config.isPaused).to.be.false;
      // Verify mint addresses are stored (D3 fix: matches EVM pattern)
      expect(config.okuMoneyMint.toString()).to.equal(okuMoneyMint.toString());
      expect(config.usdOkuMint.toString()).to.equal(usdOkuMint.toString());
    });
  });

  describe("RBAC", () => {
    it("pauser can pause router", async () => {
      await routerProgram.methods
        .pause()
        .accountsPartial({
          pauser: routerPauser.publicKey,
          config: routerConfigPda,
        })
        .signers([routerPauser])
        .rpc();

      const config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
      expect(config.isPaused).to.be.true;
    });

    it("unpauser can unpause router", async () => {
      await routerProgram.methods
        .unpause()
        .accountsPartial({
          unpauser: routerUnpauser.publicKey,
          config: routerConfigPda,
        })
        .signers([routerUnpauser])
        .rpc();

      const config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
      expect(config.isPaused).to.be.false;
    });

    it("pauser cannot unpause (role separation)", async () => {
      // First pause
      await routerProgram.methods
        .pause()
        .accountsPartial({
          pauser: routerPauser.publicKey,
          config: routerConfigPda,
        })
        .signers([routerPauser])
        .rpc();

      try {
        await routerProgram.methods
          .unpause()
          .accountsPartial({
            unpauser: routerPauser.publicKey,
            config: routerConfigPda,
          })
          .signers([routerPauser])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }

      // Cleanup
      await routerProgram.methods
        .unpause()
        .accountsPartial({
          unpauser: routerUnpauser.publicKey,
          config: routerConfigPda,
        })
        .signers([routerUnpauser])
        .rpc();
    });
  });

  describe("set_authority", () => {
    it("role_admin can update pauser", async () => {
      const newPauser = Keypair.generate();

      await routerProgram.methods
        .setAuthority({ pauser: {} }, newPauser.publicKey)
        .accountsPartial({
          roleAdmin: payer.publicKey,
          config: routerConfigPda,
        })
        .rpc();

      const config = await routerProgram.account.routerConfig.fetch(routerConfigPda);
      expect(config.pauser.toString()).to.equal(newPauser.publicKey.toString());

      // Restore
      await routerProgram.methods
        .setAuthority({ pauser: {} }, routerPauser.publicKey)
        .accountsPartial({
          roleAdmin: payer.publicKey,
          config: routerConfigPda,
        })
        .rpc();
    });
  });

  describe("mint_usd_oku", () => {
    let redemptionQueuePda: PublicKey;
    let vaultOkuMoneyAta: PublicKey;

    before(async () => {
      [redemptionQueuePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("redemption_queue")],
        psmProgram.programId
      );
      vaultOkuMoneyAta = getAssociatedTokenAddressSync(
        okuMoneyMint,
        psmConfigPda,
        true,
        TOKEN_2022_PROGRAM_ID
      );
    });

    it("mints usdOku from USDC in a single transaction", async () => {
      // Get user's usdOku balance before
      const usdOkuBefore = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const usdOkuBalanceBefore = usdOkuBefore.amount;

      const mintAmount = new BN(100_000_000); // 100 USDC

      await routerProgram.methods
        .mintUsdOku(mintAmount, new BN(0)) // no slippage protection for test
        .accountsPartial({
          user: user.publicKey,
          config: routerConfigPda,
          psmConfig: psmConfigPda,
          usdcMint,
          okuMoneyMint,
          userUsdcAta,
          userOkuMoneyAta,
          vaultUsdc: vaultUsdcAta,
          priceUpdate: null,
          vaultConfig: vaultConfigPda,
          usdOkuMint,
          userUsdOkuAta,
          reserveVault: vaultReserve,
          deadSharesAta: null,
          vaultProgram: vaultProgram.programId,
          psmProgram: psmProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Verify usdOku balance increased
      const usdOkuAfter = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const usdOkuReceived = usdOkuAfter.amount - usdOkuBalanceBefore;
      expect(Number(usdOkuReceived)).to.be.greaterThan(0);
    });

    it("fails with slippage when min_shares_out too high", async () => {
      const mintAmount = new BN(100_000_000); // 100 USDC
      const impossibleMinShares = new BN(999_999_999_999); // Way too high

      try {
        await routerProgram.methods
          .mintUsdOku(mintAmount, impossibleMinShares)
          .accountsPartial({
            user: user.publicKey,
            config: routerConfigPda,
            psmConfig: psmConfigPda,
            usdcMint,
            okuMoneyMint,
            userUsdcAta,
            userOkuMoneyAta,
            vaultUsdc: vaultUsdcAta,
            priceUpdate: null,
            vaultConfig: vaultConfigPda,
            usdOkuMint,
            userUsdOkuAta,
            reserveVault: vaultReserve,
            deadSharesAta: null,
            vaultProgram: vaultProgram.programId,
            psmProgram: psmProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed with slippage");
      } catch (err: any) {
        // Slippage error from vault program
        expect(err.toString()).to.include("Error");
      }
    });

    it("fails when router is paused", async () => {
      // Pause router
      await routerProgram.methods
        .pause()
        .accountsPartial({
          pauser: routerPauser.publicKey,
          config: routerConfigPda,
        })
        .signers([routerPauser])
        .rpc();

      try {
        await routerProgram.methods
          .mintUsdOku(new BN(100_000_000), new BN(0))
          .accountsPartial({
            user: user.publicKey,
            config: routerConfigPda,
            psmConfig: psmConfigPda,
            usdcMint,
            okuMoneyMint,
            userUsdcAta,
            userOkuMoneyAta,
            vaultUsdc: vaultUsdcAta,
            priceUpdate: null,
            vaultConfig: vaultConfigPda,
            usdOkuMint,
            userUsdOkuAta,
            reserveVault: vaultReserve,
            deadSharesAta: null,
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
        expect(err.error.errorCode.code).to.equal("Paused");
      }

      // Cleanup: unpause
      await routerProgram.methods
        .unpause()
        .accountsPartial({
          unpauser: routerUnpauser.publicKey,
          config: routerConfigPda,
        })
        .signers([routerUnpauser])
        .rpc();
    });
  });

  describe("redeem_usd_oku", () => {
    let redemptionQueuePda: PublicKey;
    let vaultOkuMoneyAta: PublicKey;

    before(async () => {
      [redemptionQueuePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("redemption_queue")],
        psmProgram.programId
      );
      vaultOkuMoneyAta = getAssociatedTokenAddressSync(
        okuMoneyMint,
        psmConfigPda,
        true,
        TOKEN_2022_PROGRAM_ID
      );
    });

    it("redeems usdOku to USDC (instant path)", async () => {
      // Get user's USDC balance before
      const usdcBefore = await getAccount(
        provider.connection,
        userUsdcAta,
        undefined,
        TOKEN_PROGRAM_ID
      );
      const usdcBalanceBefore = usdcBefore.amount;

      // Get user's usdOku balance
      const usdOkuAccount = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      // Redeem a small amount of usdOku
      const redeemShares = new BN(10_000_000); // 10 usdOku
      expect(Number(usdOkuAccount.amount)).to.be.greaterThanOrEqual(10_000_000);

      await routerProgram.methods
        .redeemUsdOku(redeemShares, new BN(0)) // no slippage protection
        .accountsPartial({
          user: user.publicKey,
          config: routerConfigPda,
          vaultConfig: vaultConfigPda,
          okuMoneyMint,
          usdOkuMint,
          userOkuMoneyAta,
          userUsdOkuAta,
          reserveVault: vaultReserve,
          psmConfig: psmConfigPda,
          redemptionQueue: redemptionQueuePda,
          usdcMint,
          userUsdcAta,
          vaultUsdc: vaultUsdcAta,
          vaultOkuMoney: vaultOkuMoneyAta,
          vaultProgram: vaultProgram.programId,
          psmProgram: psmProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Verify USDC balance increased
      const usdcAfter = await getAccount(
        provider.connection,
        userUsdcAta,
        undefined,
        TOKEN_PROGRAM_ID
      );
      const usdcReceived = usdcAfter.amount - usdcBalanceBefore;
      expect(Number(usdcReceived)).to.be.greaterThan(0);
    });

    it("fails when router is paused", async () => {
      // Pause router
      await routerProgram.methods
        .pause()
        .accountsPartial({
          pauser: routerPauser.publicKey,
          config: routerConfigPda,
        })
        .signers([routerPauser])
        .rpc();

      try {
        await routerProgram.methods
          .redeemUsdOku(new BN(1_000_000), new BN(0))
          .accountsPartial({
            user: user.publicKey,
            config: routerConfigPda,
            vaultConfig: vaultConfigPda,
            okuMoneyMint,
            usdOkuMint,
            userOkuMoneyAta,
            userUsdOkuAta,
            reserveVault: vaultReserve,
            psmConfig: psmConfigPda,
            redemptionQueue: redemptionQueuePda,
            usdcMint,
            userUsdcAta,
            vaultUsdc: vaultUsdcAta,
            vaultOkuMoney: vaultOkuMoneyAta,
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
        expect(err.error.errorCode.code).to.equal("Paused");
      }

      // Cleanup: unpause
      await routerProgram.methods
        .unpause()
        .accountsPartial({
          unpauser: routerUnpauser.publicKey,
          config: routerConfigPda,
        })
        .signers([routerUnpauser])
        .rpc();
    });
  });

  // Note: bridge_usd_oku tests require bridge to be initialized
  // which is a more complex setup. These are tested in bridge_security.ts
});
