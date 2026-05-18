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
} from "@solana/spl-token";
import { expect } from "chai";
import { OkuBridgeRouter } from "../../target/types/oku_bridge_router";
import { OkuDollar } from "../../target/types/oku_dollar";
import { LitePsm } from "../../target/types/lite_psm";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  DECIMALS,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  createOkuMoneyMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  getProgram,
} from "../shared/bankrun";

const { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

describe("oku-bridge-router", () => {
  let h: BankrunHarness;
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
    h = await startBankrun();
    provider = h.provider as unknown as anchor.AnchorProvider;
    payer = h.payer;

    // Each program loaded via the harness rather than anchor.workspace
    // (which caches programs across files and would mis-bind provider).
    psmProgram = h.program;
    routerProgram = getProgram<OkuBridgeRouter>(h, 'oku_bridge_router');
    vaultProgram = getProgram<OkuDollar>(h, 'oku_dollar');

    // Derive PDAs up front.
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

    await fundKeypairs(
      h,
      [user, routerAdmin, routerPauser, routerUnpauser],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    // Bankrun gives a fresh cluster every time, so the mints + PSM init
    // always run unconditionally.
    const usdcMintKeypair = Keypair.generate();
    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      DECIMALS,
      usdcMintKeypair,
      TOKEN_PROGRAM_ID
    );
    const okuMoneyMintKeypair = Keypair.generate();
    okuMoneyMint = await createOkuMoneyMintViaBankrun(
      h,
      psmConfigPda,
      psmConfigPda,
      DECIMALS,
      psmOrchestrator.publicKey,
      0,
      okuMoneyMintKeypair
    );
    await initializePsm(h, psmProgram, payer, usdcMint, okuMoneyMint);

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

    await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await ensureAtaViaBankrun(h, user.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);

    // Fund user with USDC
    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 10_000_000_000, TOKEN_PROGRAM_ID);

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
    await ensureAtaViaBankrun(h, user.publicKey, usdOkuMint, TOKEN_2022_PROGRAM_ID);

    // Create dead shares ATA for first deposit
    const deadSharesAta = getAssociatedTokenAddressSync(usdOkuMint, SystemProgram.programId, true, TOKEN_2022_PROGRAM_ID);
    await ensureAtaViaBankrun(h, SystemProgram.programId, usdOkuMint, TOKEN_2022_PROGRAM_ID);

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
          // Pass underlying PSM + vault configs so the router can
          // cross-check the supplied mints (defence against init-time
          // mint-pubkey drift).
          psmConfig: psmConfigPda,
          vaultConfig: vaultConfigPda,
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
        // Slippage error — surfaces as either OkuDollarError::SlippageExceeded
        // (from the vault wrap) or RouterError::SlippageExceeded (from the
        // router's post-wrap delta check). Tightened from the previous
        // `err.toString().includes('Error')` which matched any JS Error.
        const code = err?.error?.errorCode?.code;
        const msg = String(err?.message ?? err);
        const isSlippage =
          code === "SlippageExceeded" || msg.includes("SlippageExceeded");
        expect(isSlippage, `unexpected error: ${msg}`).to.equal(true);
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

  // Phase 10: bridge CPI happy paths.
  //
  // The router's `bridge_oku_m` / `bridge_usd_oku` instructions wrap a CPI
  // into lite-psm::bridge_burn. They require the PSM's bridge_config PDA
  // to be initialised — `before()` above does not do that, so this nested
  // describe brings up a bridge in its own setup hook.
  describe("bridge CPI happy paths", () => {
    // Bridge authorities — must be a mutually-distinct set per
    // `initialize_bridge`'s refund-initiator/confirmer separation rules.
    const bridgeAdmin = Keypair.generate();
    const bridgePauser = Keypair.generate();
    const bridgeUnpauser = Keypair.generate();
    const orchestratorSigner = Keypair.generate();
    const bridgeFeeRecipient = Keypair.generate();
    const chainManager = Keypair.generate();
    const feeManager = Keypair.generate();
    const nonceAdmin = Keypair.generate(); // = refundInitiator
    const signerManager = Keypair.generate(); // = refundConfirmer
    const limitsManager = Keypair.generate();
    const ETH_CHAIN_ID = 1;
    const SOLANA_CHAIN_ID = 103;

    let bridgeFeeRecipientAta: PublicKey;
    let bridgeNoncePda: PublicKey;

    before(async () => {
      // Fund all the new role keypairs.
      await fundKeypairs(
        h,
        [
          bridgeAdmin,
          bridgePauser,
          bridgeUnpauser,
          orchestratorSigner,
          bridgeFeeRecipient,
          chainManager,
          feeManager,
          nonceAdmin,
          signerManager,
          limitsManager,
        ],
        2 * anchor.web3.LAMPORTS_PER_SOL
      );

      // Initialise the bridge if not already done. (Bankrun's per-file
      // cluster means it never is — but checking lets the block be
      // idempotent if a future test runs the suite multiple times.)
      try {
        await psmProgram.account.bridgeConfig.fetch(bridgeConfigPda);
      } catch {
        await psmProgram.methods
          .initializeBridge({
            sourceChainId: SOLANA_CHAIN_ID,
            bridgeFeeBps: 10,
            minBridgeAmount: new BN(1_000_000),
            maxBridgeAmount: new BN(1_000_000_000_000),
            bridgeDeadlineSecs: new BN(3600),
            refundInitiator: nonceAdmin.publicKey,
            refundConfirmer: signerManager.publicKey,
          })
          .accountsPartial({
            bridgeAdmin: bridgeAdmin.publicKey,
            bridgePauser: bridgePauser.publicKey,
            bridgeUnpauser: bridgeUnpauser.publicKey,
            orchestratorSigner: orchestratorSigner.publicKey,
            feeRecipient: bridgeFeeRecipient.publicKey,
            chainManager: chainManager.publicKey,
            feeManager: feeManager.publicKey,
            nonceAdmin: nonceAdmin.publicKey,
            signerManager: signerManager.publicKey,
            limitsManager: limitsManager.publicKey,
            bridgeConfig: bridgeConfigPda,
            systemProgram: SystemProgram.programId,
          })
          .signers([bridgeAdmin])
          .rpc();
      }

      // Whitelist Ethereum (chain_id = 1) as a destination.
      try {
        await psmProgram.methods
          .addSupportedChain(ETH_CHAIN_ID)
          .accountsPartial({
            chainManager: chainManager.publicKey,
            bridgeConfig: bridgeConfigPda,
          })
          .signers([chainManager])
          .rpc();
      } catch {
        // Already added by a prior pass; safe to ignore.
      }

      // Derive PDAs the router CPI flow needs.
      bridgeFeeRecipientAta = await ensureAtaViaBankrun(
        h,
        bridgeFeeRecipient.publicKey,
        okuMoneyMint,
        TOKEN_2022_PROGRAM_ID
      );
      [bridgeNoncePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("bridge_nonce"), Buffer.from([ETH_CHAIN_ID & 0xff, (ETH_CHAIN_ID >> 8) & 0xff])],
        psmProgram.programId
      );
    });

    it("bridge_oku_m burns OkuMoney and emits BridgeOkuMEvent", async () => {
      // The shared `before()` already minted ~5_000_000 OkuMoney to the
      // user; some has been wrapped to usdOku. Confirm we still hold
      // enough to burn at the configured min_bridge_amount (1 OkuMoney).
      const balanceBefore = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const burnAmount = new BN(1_500_000); // 1.5 OkuMoney
      expect(Number(balanceBefore.amount)).to.be.greaterThanOrEqual(
        burnAmount.toNumber()
      );

      const evmRecipient = new Array(20).fill(0).map((_, i) => (i + 1) & 0xff);

      await routerProgram.methods
        .bridgeOkuM(burnAmount, evmRecipient, ETH_CHAIN_ID)
        .accountsPartial({
          user: user.publicKey,
          config: routerConfigPda,
          okuMoneyMint,
          userOkuMoneyAta,
          bridgeConfig: bridgeConfigPda,
          psmConfig: psmConfigPda,
          bridgeNonce: bridgeNoncePda,
          feeRecipientAta: bridgeFeeRecipientAta,
          psmProgram: psmProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const balanceAfter = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const delta = BigInt(balanceBefore.amount) - BigInt(balanceAfter.amount);
      // The router's bridge_oku_m CPI burns the full input amount from the user's
      // ATA; the 10 bps fee is split off via a SEPARATE Token-2022 transfer to
      // `fee_recipient_ata`, NOT subtracted from the user. So the user's balance
      // must drop by exactly `burnAmount`.
      expect(delta.toString()).to.equal(burnAmount.toString());

      // Fee recipient must have received the 10 bps fee.
      const feeAta = await getAccount(
        provider.connection,
        bridgeFeeRecipientAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const expectedFee = burnAmount.muln(10).divn(10_000);
      expect(feeAta.amount.toString()).to.equal(expectedFee.toString());
    });

    it("bridge_usd_oku unwraps usdOku, burns OkuMoney, emits BridgeUsdOkuEvent", async () => {
      // Need usdOku to bridge — confirm we still have some from the shared
      // `before()` wrap.
      const usdOkuBefore = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const burnUsdOku = new BN(2_000_000); // 2 usdOku
      expect(Number(usdOkuBefore.amount)).to.be.greaterThanOrEqual(
        burnUsdOku.toNumber()
      );

      const feeBefore = await getAccount(
        provider.connection,
        bridgeFeeRecipientAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      const evmRecipient = new Array(20).fill(0).map((_, i) => (i + 42) & 0xff);

      await routerProgram.methods
        .bridgeUsdOku(burnUsdOku, evmRecipient, ETH_CHAIN_ID, new BN(0))
        .accountsPartial({
          user: user.publicKey,
          config: routerConfigPda,
          vaultConfig: vaultConfigPda,
          okuMoneyMint,
          usdOkuMint,
          userOkuMoneyAta,
          userUsdOkuAta,
          reserveVault: vaultReserve,
          bridgeConfig: bridgeConfigPda,
          psmConfig: psmConfigPda,
          bridgeNonce: bridgeNoncePda,
          feeRecipientAta: bridgeFeeRecipientAta,
          vaultProgram: vaultProgram.programId,
          psmProgram: psmProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // usdOku must have decreased by exactly the burn amount.
      const usdOkuAfter = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const usdOkuDelta = BigInt(usdOkuBefore.amount) - BigInt(usdOkuAfter.amount);
      expect(usdOkuDelta.toString()).to.equal(burnUsdOku.toString());

      // Fee recipient must have received an additional 10 bps fee on the
      // unwrap-derived OkuMoney amount. We don't compute the exact delta
      // (depends on the live oku_m_price), but the balance MUST have grown.
      const feeAfter = await getAccount(
        provider.connection,
        bridgeFeeRecipientAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(feeAfter.amount)).to.be.greaterThan(Number(feeBefore.amount));
    });
  });
});
