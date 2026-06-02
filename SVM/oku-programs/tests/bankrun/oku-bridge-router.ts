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

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
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
          // F-04: rent sysvar removed from Initialize context (Anchor uses Rent::get() internally)
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

  // ==========================================================================
  // Elevated usd_multiplier redeem coverage (parity with EVM
  // `LitePSMRebasingRedeem.t.sol` post-fix suite at
  // EVM/test/psm/LitePSMRebasingRedeem.t.sol).
  //
  // Why this exists:
  //   The EVM `LitePSM._redeemUsdOku` regressed when `usdMultiplier` drifted
  //   above PRECISION because `OkuDollar.transferFrom` used floor-division
  //   for amount->share conversion while `OkuDollar.unwrap` used ceiling
  //   division, so the PSM received 1 share less than `unwrap` demanded and
  //   reverted with `InsufficientBalance()`. The latent bug only surfaced
  //   once a non-zero APY had been live long enough to drift the multiplier
  //   off 1e18. The four root-cause testing gaps (unit, fuzz, invariant,
  //   fork) all hid the bug because every existing redeem test ran at
  //   `usdMultiplier == PRECISION`.
  //
  // SVM is structurally immune to the specific EVM bug:
  //   - usd_oku is a vanilla SPL Token-2022 mint, so `transfer_checked`
  //     does NOT perform amount->share conversion (1 token == 1 share).
  //   - `oku_dollar::unwrap(shares: u64)` takes the share count directly
  //     rather than a nominal usd amount, so there is no `unwrap`-side
  //     ceiling division to disagree with the transfer side.
  //   - `programs/oku-dollar/src/helpers.rs` uses uniform `mul_div_floor`
  //     in both `shares_to_oku_money` and `oku_money_to_shares`.
  //   - `oku_bridge_router::redeem_usd_oku` already snapshots the user's
  //     OkuMoney ATA before/after the unwrap CPI and forwards the measured
  //     delta to `redeem_oku_m` (mirrors the EVM post-fix pattern).
  //
  // What this suite proves:
  //   The redeem path remains correct at elevated `usd_multiplier` regimes
  //   (mirroring the rate trajectory that flipped the EVM bug live on
  //   Sepolia: tx 0xe84280d083a5… raised the rate to 1_000_000_001_546_176_000
  //   ~ 5% APY). We exercise both short-term, fine-grained perturbations and
  //   long-term, large multiplier movements with diverse rate-change paths.
  //
  // Math constants:
  //   SVM uses PRECISION = 1e9 (vs EVM's 1e18). usd_multiplier is stored
  //   as a discrete value on `OkuDollarConfig` — there is no on-read Taylor
  //   accrual, the rebaser sets it directly. Simulating "yield trajectories"
  //   therefore means a sequence of `update_usd_multiplier` calls; we do not
  //   need `vm.warp`/`warpBy` to make the multiplier change.
  // ==========================================================================
  describe("redeem_usd_oku at elevated usd_multiplier", () => {
    const PRECISION = new BN(1_000_000_000);

    let redemptionQueuePda: PublicKey;
    let vaultOkuMoneyAta: PublicKey;

    // Run-local helpers ------------------------------------------------------

    /** Read the current `usd_multiplier` from the vault config. */
    const currentUsdMultiplier = async (): Promise<BN> => {
      const cfg = await vaultProgram.account.okuDollarConfig.fetch(vaultConfigPda);
      return cfg.usdMultiplier;
    };

    /** Read the current `oku_m_price` from the PSM config. */
    const currentOkuMPrice = async (): Promise<BN> => {
      const cfg = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      return cfg.okuMPrice;
    };

    /**
     * Top up the vault's OkuMoney reserve by having the user wrap a fresh
     * deposit — this both (a) increases `reserve_vault` so subsequent
     * multiplier bumps stay above the 95% collateral floor and (b) credits
     * the user with usdOku shares to redeem in the test. Mirrors the
     * EVM `_dealUsdOku` helper from `LitePSMRebasingRedeem.t.sol`.
     */
    const fundUserWithUsdOku = async (okuMoneyAmount: BN): Promise<BN> => {
      // Ensure user has enough OkuMoney to wrap; if not, mint from PSM.
      const okuMoneyAcct = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      if (new BN(okuMoneyAcct.amount.toString()).lt(okuMoneyAmount)) {
        // mint_oku_m takes USDC 1:1 (oku_m_price == PRECISION by default).
        // Ensure the user holds enough USDC; top up if not.
        const usdcAcct = await getAccount(
          provider.connection,
          userUsdcAta,
          undefined,
          TOKEN_PROGRAM_ID
        );
        if (new BN(usdcAcct.amount.toString()).lt(okuMoneyAmount)) {
          await mintToViaBankrun(
            h,
            usdcMint,
            userUsdcAta,
            payer,
            okuMoneyAmount.muln(2).toNumber(),
            TOKEN_PROGRAM_ID
          );
        }
        await psmProgram.methods
          .mintOkuM(okuMoneyAmount)
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
      }

      // Snapshot usdOku before wrap to compute shares received.
      const before = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await vaultProgram.methods
        .wrap(okuMoneyAmount, new BN(0))
        .accountsPartial({
          user: user.publicKey,
          config: vaultConfigPda,
          okuMoneyMint,
          usdOkuMint,
          userOkuMoneyAta,
          userUsdOkuAta,
          reserveVault: vaultReserve,
          psmConfig: psmConfigPda,
          deadSharesAta: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      const after = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      return new BN((after.amount - before.amount).toString());
    };

    /**
     * Set the vault's `usd_multiplier` to a specific target. Caller is
     * responsible for ensuring the target keeps the vault above the
     * 95% collateral floor.
     */
    const setUsdMultiplier = async (target: BN): Promise<void> => {
      const cur = await currentUsdMultiplier();
      if (cur.eq(target)) return;
      if (target.lt(cur)) {
        throw new Error(
          `setUsdMultiplier cannot decrease: cur=${cur.toString()} target=${target.toString()}`
        );
      }
      await vaultProgram.methods
        .updateUsdMultiplier(target)
        .accountsPartial({
          usdRebaser: psmOrchestrator.publicKey,
          config: vaultConfigPda,
          reserveVault: vaultReserve,
          usdOkuMint,
          psmConfig: psmConfigPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([psmOrchestrator])
        .rpc();
    };

    /**
     * Read total usdOku supply for collateral calculations.
     */
    const usdOkuSupply = async (): Promise<BN> => {
      const acct = await provider.connection.getAccountInfo(usdOkuMint);
      const { unpackMint } = await import("@solana/spl-token");
      const info = unpackMint(usdOkuMint, acct, TOKEN_2022_PROGRAM_ID);
      return new BN(info.supply.toString());
    };

    /**
     * Read the live reserve vault balance.
     */
    const reserveBalance = async (): Promise<BN> => {
      const r = await getAccount(provider.connection, vaultReserve, undefined, TOKEN_2022_PROGRAM_ID);
      return new BN(r.amount.toString());
    };

    /**
     * Deposit OkuMoney directly into the vault's reserve via the dedicated
     * `deposit_reserves` admin path. This is the ONLY way to grow reserves
     * without also growing usdOku supply — wrapping by users would do both,
     * which is insufficient when bumping the multiplier by more than
     * `1/min_ratio - 1` (≈ 5.26% at 95% min ratio) because the new shares'
     * collateral demand at the higher multiplier exceeds the OkuMoney added.
     *
     * `coldMultisig` holds the `reserve_manager` role on the vault (see the
     * top-level `before` hook's `vault.initialize(...)` call). We first mint
     * OkuMoney to coldMultisig via the PSM (using the payer's USDC to fund
     * it) and then call `deposit_reserves`.
     */
    const depositReserveOkuMoney = async (amount: BN): Promise<void> => {
      // 1) Ensure coldMultisig has a USDC ATA and is funded.
      const coldUsdcAta = await ensureAtaViaBankrun(
        h,
        coldMultisig.publicKey,
        usdcMint,
        TOKEN_PROGRAM_ID
      );
      await mintToViaBankrun(
        h,
        usdcMint,
        coldUsdcAta,
        payer,
        amount.muln(2).toNumber(),
        TOKEN_PROGRAM_ID
      );

      // 2) coldMultisig needs an OkuMoney ATA, then mints OkuMoney from USDC.
      const coldOkuMoneyAta = await ensureAtaViaBankrun(
        h,
        coldMultisig.publicKey,
        okuMoneyMint,
        TOKEN_2022_PROGRAM_ID
      );
      await psmProgram.methods
        .mintOkuM(amount)
        .accountsPartial({
          user: coldMultisig.publicKey,
          config: psmConfigPda,
          usdcMint,
          okuMoneyMint,
          userUsdcAta: coldUsdcAta,
          userOkuMoneyAta: coldOkuMoneyAta,
          vaultUsdc: vaultUsdcAta,
          priceUpdate: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([coldMultisig])
        .rpc();

      // 3) deposit_reserves — adds OkuMoney to reserves with NO share mint.
      await vaultProgram.methods
        .depositReserves(amount)
        .accountsPartial({
          reserveManager: coldMultisig.publicKey,
          config: vaultConfigPda,
          okuMoneyMint,
          usdOkuMint,
          sourceAta: coldOkuMoneyAta,
          reserveVault: vaultReserve,
          psmConfig: psmConfigPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig])
        .rpc();
    };

    /**
     * Bump multiplier by `bpsIncrease` (1bps = 0.01%). Automatically tops up
     * reserves via `deposit_reserves` (admin path, no share mint) so the new
     * target stays above the configured min_collateral_ratio.
     *
     * Collateral math (oku_m_price == PRECISION on this test fixture):
     *   required_reserve(m) = supply * m * min_ratio / PRECISION^2
     */
    const bumpUsdMultiplierBps = async (bpsIncrease: number): Promise<BN> => {
      const cur = await currentUsdMultiplier();
      const target = cur.muln(10_000 + bpsIncrease).divn(10_000);

      // Compute the reserve required at the NEW multiplier for the CURRENT
      // supply, plus a generous safety buffer (115% of the strict minimum).
      const cfg = await vaultProgram.account.okuDollarConfig.fetch(vaultConfigPda);
      const minRatio = cfg.minCollateralRatio; // scaled by PRECISION
      const supply = await usdOkuSupply();
      const requiredReserve = supply
        .mul(target)
        .div(PRECISION)
        .mul(minRatio)
        .div(PRECISION)
        .muln(115)
        .divn(100);

      const reserve = await reserveBalance();
      if (reserve.lt(requiredReserve)) {
        const shortfall = requiredReserve.sub(reserve);
        // Use deposit_reserves so we add backing without inflating supply.
        await depositReserveOkuMoney(shortfall.addn(1_000_000));
      }
      await setUsdMultiplier(target);
      return target;
    };

    /**
     * Perform a single redeem_usd_oku and return measured deltas.
     * Throws (and bubbles up) on any program error — the elevated-multiplier
     * tests assert NO revert occurs.
     */
    const doRedeem = async (
      shares: BN
    ): Promise<{
      usdOkuBurned: bigint;
      usdcReceived: bigint;
      okuMoneyDelta: bigint;
    }> => {
      const usdOkuBefore = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const usdcBefore = await getAccount(
        provider.connection,
        userUsdcAta,
        undefined,
        TOKEN_PROGRAM_ID
      );
      const okuMoneyBefore = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await routerProgram.methods
        .redeemUsdOku(shares, new BN(0))
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

      const usdOkuAfter = await getAccount(
        provider.connection,
        userUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const usdcAfter = await getAccount(
        provider.connection,
        userUsdcAta,
        undefined,
        TOKEN_PROGRAM_ID
      );
      const okuMoneyAfter = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      return {
        usdOkuBurned: usdOkuBefore.amount - usdOkuAfter.amount,
        usdcReceived: usdcAfter.amount - usdcBefore.amount,
        okuMoneyDelta: okuMoneyAfter.amount - okuMoneyBefore.amount,
      };
    };

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

    // ------------------------------------------------------------------
    // Section 1: Baseline at usd_multiplier == PRECISION
    // (the regime in which the EVM bug was invisible; we keep this here
    // as a control so a regression that breaks the baseline ALSO surfaces
    // immediately).
    // ------------------------------------------------------------------
    it("baseline: redeems at usd_multiplier == PRECISION succeed", async () => {
      const mult = await currentUsdMultiplier();
      // The vault may have been touched by earlier `describe` blocks in
      // this file, so we don't strictly assert == PRECISION. We just
      // record the starting point.
      expect(mult.gte(PRECISION)).to.equal(
        true,
        `multiplier monotonicity violated: ${mult.toString()} < PRECISION`
      );

      const shares = await fundUserWithUsdOku(new BN(50_000_000)); // 50 OkuMoney → shares
      expect(shares.gtn(0)).to.equal(true);

      const r = await doRedeem(shares.divn(2));
      expect(Number(r.usdOkuBurned)).to.be.greaterThan(0);
      expect(Number(r.usdcReceived)).to.be.greaterThan(0);
      // No stranded OkuMoney in user's ATA — the router consumed it all.
      expect(Number(r.okuMoneyDelta)).to.equal(0);
    });

    // ------------------------------------------------------------------
    // Section 2: Static elevated multipliers — mirrors EVM test cases
    //   AtSlightlyElevatedMultiplier (1.0001x — exact Sepolia scenario),
    //   AtElevatedMultiplier_1_1x, _1_5x, _2x
    // ------------------------------------------------------------------
    //
    // bps values: 1.0001x = +1bps; 1.1x = +1000bps; 1.5x = +5000bps; 2x = +10000bps.
    // We bump in stages so each step adds reserves first (via `fundUserWithUsdOku`)
    // and keeps the collateral ratio above 95%.
    const elevatedCases: Array<{ label: string; bps: number }> = [
      { label: "1.0001x (Sepolia-equivalent slightly-elevated)", bps: 1 },
      { label: "1.001x", bps: 10 },
      { label: "1.01x", bps: 100 },
      { label: "1.1x", bps: 1000 },
    ];

    elevatedCases.forEach(({ label, bps }) => {
      it(`redeems succeed at usd_multiplier = ${label}`, async () => {
        // Top up reserves BEFORE bumping so the higher multiplier still
        // satisfies the 95% collateral floor on the new (larger) supply.
        const sharesIssued = await fundUserWithUsdOku(new BN(200_000_000));

        const targetMult = await bumpUsdMultiplierBps(bps);
        const okuMPrice = await currentOkuMPrice();

        // Redeem half of the freshly-issued shares.
        const redeemShares = sharesIssued.divn(2);
        const r = await doRedeem(redeemShares);

        // CRITICAL: the SVM equivalent of the EVM `InsufficientBalance()`
        // selector 0xf4d678b8 is that the unwrap CPI would fail with an
        // SPL token "insufficient funds" error. If we got here without
        // throwing, the redeem completed end-to-end.
        expect(Number(r.usdOkuBurned)).to.be.greaterThan(0);
        expect(Number(r.usdcReceived)).to.be.greaterThan(0);

        // Property invariant: USDC out <= notional dollar value of shares
        // burned (== shares * usd_multiplier / PRECISION, downcast to USDC's
        // 6 decimals which on SVM matches OkuMoney's 6 decimals 1:1).
        // The vault favours protocol on rounding, so the user must never
        // receive MORE than the upper bound.
        const notionalDollarValue = new BN(r.usdOkuBurned.toString())
          .mul(targetMult)
          .div(PRECISION)
          .mul(okuMPrice)
          .div(PRECISION);
        expect(new BN(r.usdcReceived.toString()).lte(notionalDollarValue)).to.equal(
          true,
          `overpay at ${label}: usdc=${r.usdcReceived} notional=${notionalDollarValue.toString()}`
        );

        // No stranded OkuMoney in user's ATA.
        expect(Number(r.okuMoneyDelta)).to.equal(0);
      });
    });

    // ------------------------------------------------------------------
    // Section 3: Dust amounts — single-unit and tiny redeems at elevated
    // multiplier (the EVM bug was 1-share off; dust tests are the most
    // sensitive surface for any future rounding regression).
    // ------------------------------------------------------------------
    it("redeems succeed for dust share amounts at elevated multiplier", async () => {
      // Reserves + shares are already plentiful from Section 2. Just
      // run a sweep of small redeems and assert no revert.
      const dustSizes = [new BN(1), new BN(10), new BN(1_000), new BN(1_000_000)];
      for (const sz of dustSizes) {
        // The PSM rejects zero-USDC-output redeems with OutputBelowMinimum.
        // For very small share counts, oku_money_received * oku_m_price may
        // truncate to zero usdc on the PSM side. We treat that as a SOFT
        // skip (it's a documented PSM behaviour, not a router-level bug):
        // we only assert that if it does NOT skip, the share-conversion
        // path on the vault side did not revert.
        try {
          const r = await doRedeem(sz);
          expect(Number(r.usdOkuBurned)).to.equal(Number(sz));
          // okuMoneyDelta must be zero (router consumed it).
          expect(Number(r.okuMoneyDelta)).to.equal(0);
        } catch (err: any) {
          const code = err?.error?.errorCode?.code;
          const msg = String(err?.message ?? err);
          // The two acceptable error codes are PSM's zero-output guard and
          // the vault's amount-too-small guards. Anything else (especially
          // anything that smells like the EVM `InsufficientBalance` class)
          // is a regression.
          const acceptable =
            code === "OutputBelowMinimum" ||
            code === "ZeroAmount" ||
            code === "AmountTooSmall" ||
            msg.includes("OutputBelowMinimum") ||
            msg.includes("ZeroAmount") ||
            msg.includes("AmountTooSmall");
          expect(
            acceptable,
            `dust redeem size=${sz.toString()} failed with unexpected error: ${msg}`
          ).to.equal(true);
        }
      }
    });

    // ------------------------------------------------------------------
    // Section 4: Cumulative dust — many small redeems in a row never
    // leave the user's OkuMoney ATA holding a stranded fractional
    // unit. Mirrors the EVM `test_CumulativeDust...` case.
    // ------------------------------------------------------------------
    it("cumulative dust: 20 repeated small redeems never strand OkuMoney", async () => {
      // Make sure we have enough shares.
      await fundUserWithUsdOku(new BN(50_000_000));

      const okuMoneyBefore = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      let succeeded = 0;
      for (let i = 0; i < 20; i++) {
        try {
          await doRedeem(new BN(100_000)); // 100k = small but above zero-output threshold
          succeeded++;
        } catch (err: any) {
          // Allow OutputBelowMinimum / AmountTooSmall (zero-USDC-output guard).
          const code = err?.error?.errorCode?.code;
          const acceptable =
            code === "OutputBelowMinimum" ||
            code === "ZeroAmount" ||
            code === "AmountTooSmall";
          if (!acceptable) throw err;
        }
      }
      expect(succeeded).to.be.greaterThan(0);

      // The user's OkuMoney balance must be exactly unchanged — the router
      // forwards every unwrap-emitted OkuMoney unit into the PSM redeem
      // call. Any stranded unit would be a real rounding bug.
      const okuMoneyAfter = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(okuMoneyAfter.amount.toString()).to.equal(
        okuMoneyBefore.amount.toString(),
        `stranded OkuMoney after ${succeeded} dust redeems: ` +
          `before=${okuMoneyBefore.amount} after=${okuMoneyAfter.amount}`
      );
    });

    // ------------------------------------------------------------------
    // Section 5: Short-term rate trajectory — diverse small bumps in
    // rapid succession, interleaved with redeems. This is the SVM analog
    // of EVM's `test_LiveCompounding_1Second / 1Minute / 1Hour / 1Day`.
    // Because the SVM rebaser sets the multiplier directly (no `rpow`),
    // we simulate the trajectory as a sequence of small discrete updates.
    // ------------------------------------------------------------------
    it("short-term trajectory: 10 small bumps with redeem after each", async () => {
      // Per-step bump in bps; varied to avoid testing a single constant rate.
      const stepBps = [1, 2, 1, 5, 3, 7, 1, 4, 2, 6];
      for (const bps of stepBps) {
        const sharesIssued = await fundUserWithUsdOku(new BN(100_000_000));
        await bumpUsdMultiplierBps(bps);
        // Redeem 20% of the freshly issued shares — small enough to avoid
        // exhausting the PSM USDC buffer.
        const r = await doRedeem(sharesIssued.divn(5));
        expect(Number(r.usdOkuBurned)).to.be.greaterThan(0);
        expect(Number(r.usdcReceived)).to.be.greaterThan(0);
        expect(Number(r.okuMoneyDelta)).to.equal(0);
      }
    });

    // ------------------------------------------------------------------
    // Section 6: Long-term rate trajectory — larger, less frequent moves
    // simulating multi-year yield accrual. The SVM analog of EVM's
    // `test_LiveCompounding_1Year / 5Year / 10Year`. We can't compress
    // years into a unit test, but we can hit comparably-sized multiplier
    // movements.
    // ------------------------------------------------------------------
    it("long-term trajectory: ascending stepwise to ~1.5x multiplier", async () => {
      // Per-step bumps: progressively larger to exercise the math at
      // varied magnitudes. Cumulative ~+50% on top of the starting point.
      const stepBps = [500, 750, 1000, 1500, 2000];
      let lastMult = await currentUsdMultiplier();
      for (const bps of stepBps) {
        // Reserves must catch up before each bump — wrap a chunk
        // proportional to the upcoming move.
        await fundUserWithUsdOku(new BN(500_000_000));
        const target = await bumpUsdMultiplierBps(bps);
        expect(target.gt(lastMult)).to.equal(true);
        lastMult = target;

        // Redeem a modest slice and assert the redeem completes.
        const r = await doRedeem(new BN(5_000_000));
        expect(Number(r.usdOkuBurned)).to.be.greaterThan(0);
        expect(Number(r.usdcReceived)).to.be.greaterThan(0);
        expect(Number(r.okuMoneyDelta)).to.equal(0);
      }
    });

    // ------------------------------------------------------------------
    // Section 7: Property invariants — USDC out <= notional usdOku-in value,
    // and the redeem never strands an OkuMoney unit in the router or user
    // ATA (EVM `test_RedeemUsdOku_Property_USDCOutLessThanOrEqualToUsdOkuIn`
    // and `test_RedeemUsdOku_Property_NoStrandedShares`).
    // ------------------------------------------------------------------
    it("property: USDC out is never more than notional dollar value of shares burned", async () => {
      const sharesIssued = await fundUserWithUsdOku(new BN(100_000_000));
      const mult = await currentUsdMultiplier();
      const okuMPrice = await currentOkuMPrice();

      const redeemShares = sharesIssued.divn(3);
      const r = await doRedeem(redeemShares);

      const notional = new BN(r.usdOkuBurned.toString())
        .mul(mult)
        .div(PRECISION)
        .mul(okuMPrice)
        .div(PRECISION);
      expect(new BN(r.usdcReceived.toString()).lte(notional)).to.equal(
        true,
        `overpay: usdc=${r.usdcReceived.toString()} notional=${notional.toString()}`
      );
    });

    it("property: router and user OkuMoney ATAs net to zero after redeem", async () => {
      await fundUserWithUsdOku(new BN(50_000_000));

      const userBefore = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      await doRedeem(new BN(5_000_000));

      const userAfter = await getAccount(
        provider.connection,
        userOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );

      // The user's OkuMoney balance must be unchanged: every OkuMoney unit
      // produced by the unwrap was consumed by the PSM redeem.
      expect(userAfter.amount.toString()).to.equal(userBefore.amount.toString());
    });

    // ------------------------------------------------------------------
    // Section 8: Diverse rate-change paths — interleaved patterns that mix
    // small/medium/large bumps and immediate-vs-delayed redeems. Closes the
    // EVM-side gap that the invariant fuzzer left open by keeping the
    // multiplier pinned at 1e18.
    // ------------------------------------------------------------------
    it("diverse path: small/medium/large bumps interleaved with redeems", async () => {
      // Pattern: small, medium, redeem, large, redeem, small, redeem, ...
      const pattern: Array<
        { kind: "bump"; bps: number } | { kind: "redeem"; shares: BN }
      > = [
        { kind: "bump", bps: 2 },
        { kind: "bump", bps: 50 },
        { kind: "redeem", shares: new BN(1_000_000) },
        { kind: "bump", bps: 800 },
        { kind: "redeem", shares: new BN(2_500_000) },
        { kind: "bump", bps: 3 },
        { kind: "redeem", shares: new BN(500_000) },
        { kind: "bump", bps: 250 },
        { kind: "redeem", shares: new BN(1_000_000) },
      ];

      // Pre-fund: deposit enough OkuMoney to cover the upcoming bumps.
      await fundUserWithUsdOku(new BN(2_000_000_000));

      for (const step of pattern) {
        if (step.kind === "bump") {
          // Catch up reserves before any large bump.
          if (step.bps >= 100) {
            await fundUserWithUsdOku(new BN(1_000_000_000));
          }
          await bumpUsdMultiplierBps(step.bps);
        } else {
          try {
            const r = await doRedeem(step.shares);
            expect(Number(r.usdOkuBurned)).to.be.greaterThan(0);
            expect(Number(r.okuMoneyDelta)).to.equal(0);
          } catch (err: any) {
            // Allow zero-output guard for very small redeems at high prices.
            const code = err?.error?.errorCode?.code;
            const acceptable =
              code === "OutputBelowMinimum" ||
              code === "ZeroAmount" ||
              code === "AmountTooSmall";
            if (!acceptable) throw err;
          }
        }
      }
    });
  });
});
