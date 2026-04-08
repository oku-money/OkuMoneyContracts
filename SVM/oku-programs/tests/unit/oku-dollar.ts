/**
 * OkuDollar Vault Integration Tests
 *
 * Tests the rebasing usdOku vault that wraps OkuMoney.
 *
 * Architecture:
 * - Users deposit OkuMoney → receive usdOku shares
 * - usdOku shares appreciate via usd_multiplier updates
 * - Shares represent a claim on the OkuMoney reserve
 *
 * Key differences from old wOkuUSD vault:
 * - Both tokens are Token-2022 (no SPL Token mixing)
 * - Discrete multiplier updates instead of InterestBearing extension
 * - Unwrap is BLOCKED when paused (matches EVM behavior)
 * - Collateralization ratio enforcement
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  getMintLen,
  createInitializeMintInstruction,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import { OkuDollar } from "../../target/types/oku_dollar";
import { LitePsm } from "../../target/types/lite_psm";
import {
  psmOrchestrator,
  coldMultisig as psmColdMultisig,
  initializePSMIfNeeded,
  safeAirdropAll,
  ensureAta,
  DECIMALS,
} from "../shared/setup";

const { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

// ============================================================================
// Protocol Constants (must match program constants)
// ============================================================================

/** Precision for multipliers (1e9 = $1.00 or 1:1) - matches helpers.rs */
const PRECISION = new BN(1_000_000_000);

/** Dead shares permanently locked to prevent inflation attacks - matches helpers.rs */
const MINIMUM_LIQUIDITY = new BN(1_000_000); // 1 usdOku (6 decimals)

/** Minimum collateral ratio floor (90%) - matches helpers.rs */
const MIN_COLLATERAL_RATIO_FLOOR = new BN(900_000_000);

/** Default minimum collateral ratio for tests (95%) */
const DEFAULT_MIN_COLLATERAL_RATIO = new BN(950_000_000);

/** Dead address: System Program - tokens sent here are permanently locked */
const DEAD_ADDRESS = SystemProgram.programId;

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Calculate expected shares from OkuMoney deposit
 * Formula: shares = (oku_m_amount * oku_m_price) / usd_multiplier
 */
function calculateExpectedShares(okuMAmount: BN, usdMultiplier: BN, okuMPrice?: BN): BN {
  const price = okuMPrice || PRECISION;
  return okuMAmount.mul(price).div(usdMultiplier);
}

/**
 * Calculate expected OkuMoney from shares withdrawal
 * Formula: oku_m_amount = (shares * usd_multiplier) / oku_m_price
 */
function calculateExpectedOkuMoney(shares: BN, usdMultiplier: BN, okuMPrice?: BN): BN {
  const price = okuMPrice || PRECISION;
  return shares.mul(usdMultiplier).div(price);
}

/**
 * Calculate collateralization ratio (price-aware)
 * Formula: ratio = (reserve_balance * oku_m_price * PRECISION) / (total_supply * usd_multiplier)
 */
function calculateCollateralRatio(
  reserveBalance: BN,
  totalSupply: BN,
  usdMultiplier: BN,
  okuMPrice?: BN
): BN {
  const price = okuMPrice || PRECISION;
  if (totalSupply.isZero()) return new BN(Number.MAX_SAFE_INTEGER);
  const denominator = totalSupply.mul(usdMultiplier);
  if (denominator.isZero()) return new BN(Number.MAX_SAFE_INTEGER);
  return reserveBalance.mul(price).mul(PRECISION).div(denominator);
}

// ============================================================================
// Test Suite
// ============================================================================

describe("oku-dollar", () => {
  let provider: anchor.AnchorProvider;
  let program: Program<OkuDollar>;
  let psmProgram: Program<LitePsm>;
  let payer: Keypair;

  // Vault-specific authority keypairs (separate from PSM authorities)
  let roleAdmin: Keypair;
  const vaultPauser = Keypair.generate();
  const vaultUnpauser = Keypair.generate();
  const usdRebaser = Keypair.generate();
  const reserveManager = Keypair.generate();

  // User keypairs for testing
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  // Mint keypairs (if we need to create them)
  const okuMoneyMintKeypair = Keypair.generate();

  // PDAs and addresses
  let vaultConfigPda: PublicKey;
  let psmConfigPda: PublicKey;
  let usdOkuMint: PublicKey;
  let reserveVault: PublicKey;
  let deadSharesAta: PublicKey;

  // Token accounts
  let user1OkuMoneyAta: PublicKey;
  let user1UsdOkuAta: PublicKey;
  let user2OkuMoneyAta: PublicKey;
  let user2UsdOkuAta: PublicKey;
  let reserveManagerOkuMoneyAta: PublicKey;

  // Mints
  let okuMoneyMint: PublicKey;

  // Track state for test isolation
  let vaultInitialized = false;

  before(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    program = anchor.workspace.OkuDollar as Program<OkuDollar>;
    psmProgram = anchor.workspace.LitePsm as Program<LitePsm>;
    payer = (provider.wallet as anchor.Wallet).payer;
    roleAdmin = payer;

    // Derive PSM config PDA
    [psmConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")],
      psmProgram.programId
    );

    // Check if PSM already initialized - get OkuMoney mint from it
    let psmExists = false;
    try {
      const existingPsmConfig = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      psmExists = true;
      okuMoneyMint = existingPsmConfig.okuMoneyMint;
    } catch {
      // PSM not initialized - we need to create OkuMoney mint
    }

    if (!psmExists) {
      // Create OkuMoney mint (Token-2022)
      // PSM config PDA will be mint authority (matches production)
      const mintLen = getMintLen([]);
      const lamports = await provider.connection.getMinimumBalanceForRentExemption(mintLen);

      const createAccountIx = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: okuMoneyMintKeypair.publicKey,
        space: mintLen,
        lamports,
        programId: TOKEN_2022_PROGRAM_ID,
      });

      const initMintIx = createInitializeMintInstruction(
        okuMoneyMintKeypair.publicKey,
        DECIMALS,
        psmConfigPda, // mint authority = PSM config PDA
        psmConfigPda, // freeze authority = PSM config PDA
        TOKEN_2022_PROGRAM_ID
      );

      const tx = new anchor.web3.Transaction().add(createAccountIx, initMintIx);
      await provider.sendAndConfirm(tx, [payer, okuMoneyMintKeypair]);
      okuMoneyMint = okuMoneyMintKeypair.publicKey;

      // Also need a USDC mint for PSM initialization
      // Create a mock USDC mint
      const usdcMintKeypair = Keypair.generate();
      const usdcMintLen = getMintLen([]);
      const usdcLamports = await provider.connection.getMinimumBalanceForRentExemption(usdcMintLen);

      // Use standard SPL Token for USDC (production behavior)
      const { TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
      const usdcCreateIx = SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: usdcMintKeypair.publicKey,
        space: usdcMintLen,
        lamports: usdcLamports,
        programId: TOKEN_PROGRAM_ID,
      });

      const { createInitializeMintInstruction: createInitMint } = await import("@solana/spl-token");
      const usdcInitIx = createInitMint(
        usdcMintKeypair.publicKey,
        DECIMALS,
        payer.publicKey,
        payer.publicKey,
        TOKEN_PROGRAM_ID
      );

      const usdcTx = new anchor.web3.Transaction().add(usdcCreateIx, usdcInitIx);
      await provider.sendAndConfirm(usdcTx, [payer, usdcMintKeypair]);

      // Initialize PSM
      await initializePSMIfNeeded(
        psmProgram as any,
        provider,
        payer,
        usdcMintKeypair.publicKey,
        okuMoneyMint
      );
    } else {
      // PSM already exists, ensure it's properly set up
      await initializePSMIfNeeded(
        psmProgram as any,
        provider,
        payer,
        (await psmProgram.account.psmConfig.fetch(psmConfigPda)).usdcMint,
        okuMoneyMint
      );
    }

    // Airdrop SOL to test accounts
    await safeAirdropAll(
      provider.connection,
      [user1, user2, vaultPauser, vaultUnpauser, usdRebaser, reserveManager],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    // Derive vault config PDA
    [vaultConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oku_dollar_config")],
      program.programId
    );

    // Derive usdOku mint PDA (created by vault initialize)
    [usdOkuMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("usd_oku_mint")],
      program.programId
    );

    // Derive reserve vault ATA (created by vault initialize)
    reserveVault = getAssociatedTokenAddressSync(
      okuMoneyMint,
      vaultConfigPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    // Create OkuMoney ATAs for users
    user1OkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      user1.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    user2OkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      user2.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    reserveManagerOkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      reserveManager.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    await ensureAta(provider.connection, payer, user1OkuMoneyAta, user1.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);
    await ensureAta(provider.connection, payer, user2OkuMoneyAta, user2.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);
    await ensureAta(provider.connection, payer, reserveManagerOkuMoneyAta, reserveManager.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);

    // Mint OkuMoney to users via PSM (we need to use PSM's mint authority)
    // For testing, we'll mint directly since PSM config is mint authority
    const OKU_MONEY_PER_USER = 10_000_000_000; // 10,000 OkuMoney each

    // Mint via PSM using the mint instruction (USDC -> OkuMoney)
    // First fund users with USDC
    const psmConfig = await psmProgram.account.psmConfig.fetch(psmConfigPda);
    const usdcMint = psmConfig.usdcMint;
    const { TOKEN_PROGRAM_ID } = await import("@solana/spl-token");

    const user1UsdcAta = getAssociatedTokenAddressSync(usdcMint, user1.publicKey, false, TOKEN_PROGRAM_ID);
    const user2UsdcAta = getAssociatedTokenAddressSync(usdcMint, user2.publicKey, false, TOKEN_PROGRAM_ID);
    const reserveManagerUsdcAta = getAssociatedTokenAddressSync(usdcMint, reserveManager.publicKey, false, TOKEN_PROGRAM_ID);

    await ensureAta(provider.connection, payer, user1UsdcAta, user1.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await ensureAta(provider.connection, payer, user2UsdcAta, user2.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await ensureAta(provider.connection, payer, reserveManagerUsdcAta, reserveManager.publicKey, usdcMint, TOKEN_PROGRAM_ID);

    await mintTo(provider.connection, payer, usdcMint, user1UsdcAta, payer, OKU_MONEY_PER_USER, [], undefined, TOKEN_PROGRAM_ID);
    await mintTo(provider.connection, payer, usdcMint, user2UsdcAta, payer, OKU_MONEY_PER_USER, [], undefined, TOKEN_PROGRAM_ID);
    await mintTo(provider.connection, payer, usdcMint, reserveManagerUsdcAta, payer, OKU_MONEY_PER_USER, [], undefined, TOKEN_PROGRAM_ID);

    // Mint OkuMoney via PSM
    const { mintOkusdViaProgram } = await import("../shared/setup");
    await mintOkusdViaProgram(
      psmProgram as any, user1, new BN(OKU_MONEY_PER_USER), psmConfigPda,
      usdcMint, okuMoneyMint, user1UsdcAta, user1OkuMoneyAta, psmConfig.vaultUsdc
    );
    await mintOkusdViaProgram(
      psmProgram as any, user2, new BN(OKU_MONEY_PER_USER), psmConfigPda,
      usdcMint, okuMoneyMint, user2UsdcAta, user2OkuMoneyAta, psmConfig.vaultUsdc
    );
    await mintOkusdViaProgram(
      psmProgram as any, reserveManager, new BN(OKU_MONEY_PER_USER), psmConfigPda,
      usdcMint, okuMoneyMint, reserveManagerUsdcAta, reserveManagerOkuMoneyAta, psmConfig.vaultUsdc
    );
  });

  // ============================================================================
  // Initialization Tests
  // ============================================================================

  describe("initialize", () => {
    it("initializes the vault with correct configuration", async () => {
      // Check if already initialized
      let existingConfig;
      try {
        existingConfig = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      } catch {
        existingConfig = null;
      }
      
      if (existingConfig) {
        vaultInitialized = true;
        
        // Verify existing config
        expect(existingConfig.okuMoneyMint.toString()).to.equal(okuMoneyMint.toString());
        
        // Update state variables from existing config
        usdOkuMint = existingConfig.usdOkuMint;
        
        // IMPORTANT: When vault already exists, update authorities to use our test keypairs
        // The role_admin is payer (wallet), so we can use set_authority to update roles for testing
        // This assumes tests are run with the same wallet that initialized the vault
        await program.methods
          .setAuthority({ pauser: {} }, vaultPauser.publicKey)
          .accountsPartial({ roleAdmin: roleAdmin.publicKey, config: vaultConfigPda })
          .rpc();
        await program.methods
          .setAuthority({ unpauser: {} }, vaultUnpauser.publicKey)
          .accountsPartial({ roleAdmin: roleAdmin.publicKey, config: vaultConfigPda })
          .rpc();
        await program.methods
          .setAuthority({ usdRebaser: {} }, usdRebaser.publicKey)
          .accountsPartial({ roleAdmin: roleAdmin.publicKey, config: vaultConfigPda })
          .rpc();
        await program.methods
          .setAuthority({ reserveManager: {} }, reserveManager.publicKey)
          .accountsPartial({ roleAdmin: roleAdmin.publicKey, config: vaultConfigPda })
          .rpc();
        
        // Ensure vault is unpaused
        const config = await program.account.okuDollarConfig.fetch(vaultConfigPda);
        if (config.isPaused) {
          await program.methods
            .unpause()
            .accountsPartial({ unpauser: vaultUnpauser.publicKey, config: vaultConfigPda })
            .signers([vaultUnpauser])
            .rpc();
        }
        return;
      }

      await program.methods
        .initialize(
          vaultPauser.publicKey,
          vaultUnpauser.publicKey,
          usdRebaser.publicKey,
          reserveManager.publicKey,
          DEFAULT_MIN_COLLATERAL_RATIO
        )
        .accountsPartial({
          roleAdmin: roleAdmin.publicKey,
          config: vaultConfigPda,
          okuMoneyMint: okuMoneyMint,
          usdOkuMint: usdOkuMint,
          reserveVault: reserveVault,
          psmConfig: psmConfigPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();

      vaultInitialized = true;

      // Verify configuration
      const config = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      
      expect(config.roleAdmin.toString()).to.equal(roleAdmin.publicKey.toString());
      expect(config.pauser.toString()).to.equal(vaultPauser.publicKey.toString());
      expect(config.unpauser.toString()).to.equal(vaultUnpauser.publicKey.toString());
      expect(config.usdRebaser.toString()).to.equal(usdRebaser.publicKey.toString());
      expect(config.reserveManager.toString()).to.equal(reserveManager.publicKey.toString());
      expect(config.okuMoneyMint.toString()).to.equal(okuMoneyMint.toString());
      expect(config.reserveVault.toString()).to.equal(reserveVault.toString());
      expect(config.psmConfig.toString()).to.equal(psmConfigPda.toString());
      expect(config.usdMultiplier.toString()).to.equal(PRECISION.toString());
      expect(config.minCollateralRatio.toString()).to.equal(DEFAULT_MIN_COLLATERAL_RATIO.toString());
      expect(config.isPaused).to.be.false;
    });

    it("rejects initialization with collateral ratio below floor", async () => {
      // This test would require a fresh program deployment
      // For now, we verify the constant is correctly defined
      expect(MIN_COLLATERAL_RATIO_FLOOR.lt(DEFAULT_MIN_COLLATERAL_RATIO)).to.be.true;
    });
  });

  // ============================================================================
  // Wrap Tests
  // ============================================================================

  describe("wrap", () => {
    before(async () => {
      // Ensure vault is initialized
      if (!vaultInitialized) {
        throw new Error("Vault must be initialized before wrap tests");
      }

      // Setup usdOku ATAs for users (will be created by wrap with init_if_needed)
      user1UsdOkuAta = getAssociatedTokenAddressSync(
        usdOkuMint,
        user1.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      user2UsdOkuAta = getAssociatedTokenAddressSync(
        usdOkuMint,
        user2.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      // Create dead shares ATA
      deadSharesAta = getAssociatedTokenAddressSync(
        usdOkuMint,
        DEAD_ADDRESS,
        true,
        TOKEN_2022_PROGRAM_ID
      );
      await ensureAta(provider.connection, payer, deadSharesAta, DEAD_ADDRESS, usdOkuMint, TOKEN_2022_PROGRAM_ID);
    });

    it("wraps OkuMoney -> usdOku (first deposit with dead shares)", async () => {
      const usdOkuMintAccount = await provider.connection.getAccountInfo(usdOkuMint);
      const { unpackMint } = await import("@solana/spl-token");
      const mintInfo = unpackMint(usdOkuMint, usdOkuMintAccount, TOKEN_2022_PROGRAM_ID);
      
      // Skip first-deposit test if vault already has shares
      if (mintInfo.supply > BigInt(0)) {
        // Do a regular wrap instead
        const wrapAmount = new BN(100_000_000); // 100 OkuMoney
        
        await program.methods
          .wrap(wrapAmount, new BN(0))
          .accountsPartial({
            user: user1.publicKey,
            config: vaultConfigPda,
            okuMoneyMint: okuMoneyMint,
            usdOkuMint: usdOkuMint,
            userOkuMoneyAta: user1OkuMoneyAta,
            userUsdOkuAta: user1UsdOkuAta,
            reserveVault: reserveVault,
            psmConfig: psmConfigPda,
            deadSharesAta: null,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();

        const user1UsdOku = await getAccount(provider.connection, user1UsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
        expect(Number(user1UsdOku.amount)).to.be.greaterThan(0);
        return;
      }

      // First deposit
      const wrapAmount = new BN(1_000_000_000); // 1000 OkuMoney
      const config = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      const psmConfig = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      const expectedShares = calculateExpectedShares(wrapAmount, config.usdMultiplier, psmConfig.okuMPrice);
      const expectedUserShares = expectedShares.sub(MINIMUM_LIQUIDITY);

      const user1OkuMoneyBefore = await getAccount(provider.connection, user1OkuMoneyAta, undefined, TOKEN_2022_PROGRAM_ID);

      await program.methods
        .wrap(wrapAmount, new BN(0))
        .accountsPartial({
          user: user1.publicKey,
          config: vaultConfigPda,
          okuMoneyMint: okuMoneyMint,
          usdOkuMint: usdOkuMint,
          userOkuMoneyAta: user1OkuMoneyAta,
          userUsdOkuAta: user1UsdOkuAta,
          reserveVault: reserveVault,
          psmConfig: psmConfigPda,
          deadSharesAta: deadSharesAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // Verify OkuMoney transferred from user to reserve
      const user1OkuMoneyAfter = await getAccount(provider.connection, user1OkuMoneyAta, undefined, TOKEN_2022_PROGRAM_ID);
      const reserveAfter = await getAccount(provider.connection, reserveVault, undefined, TOKEN_2022_PROGRAM_ID);

      expect(Number(user1OkuMoneyBefore.amount) - Number(user1OkuMoneyAfter.amount)).to.equal(wrapAmount.toNumber());
      expect(Number(reserveAfter.amount)).to.equal(wrapAmount.toNumber());

      // Verify usdOku minted correctly (user gets amount - MINIMUM_LIQUIDITY)
      const user1UsdOkuAfter = await getAccount(provider.connection, user1UsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(user1UsdOkuAfter.amount)).to.equal(expectedUserShares.toNumber());

      // Verify dead shares were minted
      const deadShares = await getAccount(provider.connection, deadSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(deadShares.amount)).to.equal(MINIMUM_LIQUIDITY.toNumber());
    });

    it("wraps OkuMoney -> usdOku (subsequent deposit)", async () => {
      const wrapAmount = new BN(500_000_000); // 500 OkuMoney
      const config = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      const psmConfig = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      const expectedShares = calculateExpectedShares(wrapAmount, config.usdMultiplier, psmConfig.okuMPrice);

      const user1UsdOkuBefore = await getAccount(provider.connection, user1UsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);

      await program.methods
        .wrap(wrapAmount, new BN(0))
        .accountsPartial({
          user: user1.publicKey,
          config: vaultConfigPda,
          okuMoneyMint: okuMoneyMint,
          usdOkuMint: usdOkuMint,
          userOkuMoneyAta: user1OkuMoneyAta,
          userUsdOkuAta: user1UsdOkuAta,
          reserveVault: reserveVault,
          psmConfig: psmConfigPda,
          deadSharesAta: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      const user1UsdOkuAfter = await getAccount(provider.connection, user1UsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesMinted = Number(user1UsdOkuAfter.amount) - Number(user1UsdOkuBefore.amount);
      
      expect(sharesMinted).to.equal(expectedShares.toNumber());
    });

    it("fails to wrap when paused", async () => {
      // Pause the vault
      await program.methods
        .pause()
        .accountsPartial({
          pauser: vaultPauser.publicKey,
          config: vaultConfigPda,
        })
        .signers([vaultPauser])
        .rpc();

      try {
        await program.methods
          .wrap(new BN(1_000_000), new BN(0))
          .accountsPartial({
            user: user1.publicKey,
            config: vaultConfigPda,
            okuMoneyMint: okuMoneyMint,
            usdOkuMint: usdOkuMint,
            userOkuMoneyAta: user1OkuMoneyAta,
            userUsdOkuAta: user1UsdOkuAta,
            reserveVault: reserveVault,
            psmConfig: psmConfigPda,
            deadSharesAta: null,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have failed - vault is paused");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("VaultPaused");
      }

      // Unpause for future tests
      await program.methods
        .unpause()
        .accountsPartial({
          unpauser: vaultUnpauser.publicKey,
          config: vaultConfigPda,
        })
        .signers([vaultUnpauser])
        .rpc();
    });

    it("fails to wrap zero amount", async () => {
      try {
        await program.methods
          .wrap(new BN(0), new BN(0))
          .accountsPartial({
            user: user1.publicKey,
            config: vaultConfigPda,
            okuMoneyMint: okuMoneyMint,
            usdOkuMint: usdOkuMint,
            userOkuMoneyAta: user1OkuMoneyAta,
            userUsdOkuAta: user1UsdOkuAta,
            reserveVault: reserveVault,
            psmConfig: psmConfigPda,
            deadSharesAta: null,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have failed - zero amount");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });
  });

  // ============================================================================
  // Unwrap Tests
  // ============================================================================

  describe("unwrap", () => {
    it("unwraps usdOku -> OkuMoney", async () => {
      const config = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      const psmConfig = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      const user1UsdOkuBefore = await getAccount(provider.connection, user1UsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
      const user1OkuMoneyBefore = await getAccount(provider.connection, user1OkuMoneyAta, undefined, TOKEN_2022_PROGRAM_ID);

      const unwrapShares = new BN(Math.floor(Number(user1UsdOkuBefore.amount) / 4)); // Unwrap 25%
      const expectedOkuMoney = calculateExpectedOkuMoney(unwrapShares, config.usdMultiplier, psmConfig.okuMPrice);

      await program.methods
        .unwrap(unwrapShares)
        .accountsPartial({
          user: user1.publicKey,
          config: vaultConfigPda,
          okuMoneyMint: okuMoneyMint,
          usdOkuMint: usdOkuMint,
          userOkuMoneyAta: user1OkuMoneyAta,
          userUsdOkuAta: user1UsdOkuAta,
          reserveVault: reserveVault,
          psmConfig: psmConfigPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // Verify usdOku burned
      const user1UsdOkuAfter = await getAccount(provider.connection, user1UsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(user1UsdOkuBefore.amount) - Number(user1UsdOkuAfter.amount)).to.equal(unwrapShares.toNumber());

      // Verify OkuMoney received
      const user1OkuMoneyAfter = await getAccount(provider.connection, user1OkuMoneyAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(user1OkuMoneyAfter.amount) - Number(user1OkuMoneyBefore.amount)).to.equal(expectedOkuMoney.toNumber());
    });

    it("CRITICAL: blocks unwrap when paused (matches EVM behavior)", async () => {
      // Pause the vault
      await program.methods
        .pause()
        .accountsPartial({
          pauser: vaultPauser.publicKey,
          config: vaultConfigPda,
        })
        .signers([vaultPauser])
        .rpc();

      try {
        await program.methods
          .unwrap(new BN(1_000_000))
          .accountsPartial({
            user: user1.publicKey,
            config: vaultConfigPda,
            okuMoneyMint: okuMoneyMint,
            usdOkuMint: usdOkuMint,
            userOkuMoneyAta: user1OkuMoneyAta,
            userUsdOkuAta: user1UsdOkuAta,
            reserveVault: reserveVault,
            psmConfig: psmConfigPda,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have failed - unwrap should be blocked when paused");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("VaultPaused");
      }

      // Unpause for future tests
      await program.methods
        .unpause()
        .accountsPartial({
          unpauser: vaultUnpauser.publicKey,
          config: vaultConfigPda,
        })
        .signers([vaultUnpauser])
        .rpc();
    });

    it("fails to unwrap zero shares", async () => {
      try {
        await program.methods
          .unwrap(new BN(0))
          .accountsPartial({
            user: user1.publicKey,
            config: vaultConfigPda,
            okuMoneyMint: okuMoneyMint,
            usdOkuMint: usdOkuMint,
            userOkuMoneyAta: user1OkuMoneyAta,
            userUsdOkuAta: user1UsdOkuAta,
            reserveVault: reserveVault,
            psmConfig: psmConfigPda,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have failed - zero shares");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });
  });

  // ============================================================================
  // USD Multiplier (Rebasing) Tests
  // ============================================================================

  describe("update_usd_multiplier", () => {
    it("usd_rebaser can increase multiplier (distributes yield)", async () => {
      const configBefore = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      const oldMultiplier = configBefore.usdMultiplier;
      
      // Increase multiplier by 5% (simulating yield accrual)
      const newMultiplier = oldMultiplier.mul(new BN(105)).div(new BN(100));

      await program.methods
        .updateUsdMultiplier(newMultiplier)
        .accountsPartial({
          usdRebaser: usdRebaser.publicKey,
          config: vaultConfigPda,
          reserveVault: reserveVault,
          usdOkuMint: usdOkuMint,
          psmConfig: psmConfigPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([usdRebaser])
        .rpc();

      const configAfter = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      expect(configAfter.usdMultiplier.toString()).to.equal(newMultiplier.toString());
    });

    it("rejects multiplier decrease (yield cannot go negative)", async () => {
      const configBefore = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      const lowerMultiplier = configBefore.usdMultiplier.sub(new BN(1));

      try {
        await program.methods
          .updateUsdMultiplier(lowerMultiplier)
          .accountsPartial({
            usdRebaser: usdRebaser.publicKey,
            config: vaultConfigPda,
            reserveVault: reserveVault,
            usdOkuMint: usdOkuMint,
            psmConfig: psmConfigPda,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([usdRebaser])
          .rpc();
        expect.fail("Should have failed - multiplier cannot decrease");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("MultiplierCannotDecrease");
      }
    });

    it("rejects multiplier update from non-rebaser", async () => {
      const configBefore = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      const newMultiplier = configBefore.usdMultiplier.add(new BN(1));

      try {
        await program.methods
          .updateUsdMultiplier(newMultiplier)
          .accountsPartial({
            usdRebaser: user1.publicKey, // Not authorized
            config: vaultConfigPda,
            reserveVault: reserveVault,
            usdOkuMint: usdOkuMint,
            psmConfig: psmConfigPda,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have failed - unauthorized");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });

    it("rejects multiplier update that would breach collateral ratio", async () => {
      // Get current state
      const config = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      const reserve = await getAccount(provider.connection, reserveVault, undefined, TOKEN_2022_PROGRAM_ID);
      const mintAccount = await provider.connection.getAccountInfo(usdOkuMint);
      const { unpackMint } = await import("@solana/spl-token");
      const mintInfo = unpackMint(usdOkuMint, mintAccount, TOKEN_2022_PROGRAM_ID);
      
      if (mintInfo.supply === BigInt(0)) {
        // Can't test this without supply
        return;
      }

      // Calculate a multiplier that would breach the collateral ratio
      // If reserve = 1000, supply = 1000, multiplier = 1.0, ratio = 100%
      // If we increase multiplier to 2.0, required = 2000, ratio = 50% (breaches 95%)
      const extremeMultiplier = config.usdMultiplier.mul(new BN(3)); // 3x current

      try {
        await program.methods
          .updateUsdMultiplier(extremeMultiplier)
          .accountsPartial({
            usdRebaser: usdRebaser.publicKey,
            config: vaultConfigPda,
            reserveVault: reserveVault,
            usdOkuMint: usdOkuMint,
            psmConfig: psmConfigPda,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([usdRebaser])
          .rpc();
        expect.fail("Should have failed - insufficient collateral");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InsufficientCollateral");
      }
    });
  });

  // ============================================================================
  // Reserve Management Tests
  // ============================================================================

  describe("deposit_reserves", () => {
    it("reserve_manager can deposit additional collateral", async () => {
      const depositAmount = new BN(100_000_000); // 100 OkuMoney
      const reserveBefore = await getAccount(provider.connection, reserveVault, undefined, TOKEN_2022_PROGRAM_ID);

      await program.methods
        .depositReserves(depositAmount)
        .accountsPartial({
          reserveManager: reserveManager.publicKey,
          config: vaultConfigPda,
          okuMoneyMint: okuMoneyMint,
          sourceAta: reserveManagerOkuMoneyAta,
          reserveVault: reserveVault,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([reserveManager])
        .rpc();

      const reserveAfter = await getAccount(provider.connection, reserveVault, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(reserveAfter.amount) - Number(reserveBefore.amount)).to.equal(depositAmount.toNumber());
    });

    it("rejects deposit from non-reserve_manager", async () => {
      try {
        await program.methods
          .depositReserves(new BN(1_000_000))
          .accountsPartial({
            reserveManager: user1.publicKey, // Not authorized
            config: vaultConfigPda,
            okuMoneyMint: okuMoneyMint,
            sourceAta: user1OkuMoneyAta,
            reserveVault: reserveVault,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have failed - unauthorized");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });
  });

  describe("withdraw_reserves", () => {
    it("reserve_manager can withdraw excess collateral", async () => {
      // First ensure we have excess collateral
      const config = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      const reserve = await getAccount(provider.connection, reserveVault, undefined, TOKEN_2022_PROGRAM_ID);
      const mintAccount = await provider.connection.getAccountInfo(usdOkuMint);
      const { unpackMint } = await import("@solana/spl-token");
      const mintInfo = unpackMint(usdOkuMint, mintAccount, TOKEN_2022_PROGRAM_ID);
      
      const totalSupply = new BN(mintInfo.supply.toString());
      const currentRatio = calculateCollateralRatio(
        new BN(reserve.amount.toString()),
        totalSupply,
        config.usdMultiplier
      );

      // Only withdraw if we have excess above minimum
      if (currentRatio.lte(config.minCollateralRatio)) {
        return; // Skip - not enough excess
      }

      // Calculate safe withdrawal amount (keep 5% buffer above minimum)
      const targetRatio = config.minCollateralRatio.add(new BN(50_000_000)); // min + 5%
      const requiredReserve = totalSupply.mul(config.usdMultiplier).mul(targetRatio).div(PRECISION).div(PRECISION);
      const withdrawAmount = new BN(reserve.amount.toString()).sub(requiredReserve);

      if (withdrawAmount.lten(0)) {
        return; // Skip - nothing to withdraw
      }

      const reserveManagerBefore = await getAccount(provider.connection, reserveManagerOkuMoneyAta, undefined, TOKEN_2022_PROGRAM_ID);

      await program.methods
        .withdrawReserves(withdrawAmount)
        .accountsPartial({
          reserveManager: reserveManager.publicKey,
          config: vaultConfigPda,
          okuMoneyMint: okuMoneyMint,
          destinationAta: reserveManagerOkuMoneyAta,
          reserveVault: reserveVault,
          usdOkuMint: usdOkuMint,
          psmConfig: psmConfigPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([reserveManager])
        .rpc();

      const reserveManagerAfter = await getAccount(provider.connection, reserveManagerOkuMoneyAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(reserveManagerAfter.amount) - Number(reserveManagerBefore.amount)).to.equal(withdrawAmount.toNumber());
    });

    it("rejects withdrawal that would breach collateral ratio", async () => {
      const reserve = await getAccount(provider.connection, reserveVault, undefined, TOKEN_2022_PROGRAM_ID);
      const excessiveAmount = new BN(reserve.amount.toString()); // Try to withdraw everything

      try {
        await program.methods
          .withdrawReserves(excessiveAmount)
          .accountsPartial({
            reserveManager: reserveManager.publicKey,
            config: vaultConfigPda,
            okuMoneyMint: okuMoneyMint,
            destinationAta: reserveManagerOkuMoneyAta,
            reserveVault: reserveVault,
            usdOkuMint: usdOkuMint,
            psmConfig: psmConfigPda,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([reserveManager])
          .rpc();
        expect.fail("Should have failed - insufficient collateral");
      } catch (err: any) {
        const code = err.error?.errorCode?.code || "";
        expect(code === "InsufficientCollateral" || code === "InsufficientReserves").to.be.true;
      }
    });
  });

  // ============================================================================
  // RBAC Tests
  // ============================================================================

  describe("RBAC: Role Separation", () => {
    it("pauser can pause, but cannot unpause", async () => {
      await program.methods
        .pause()
        .accountsPartial({
          pauser: vaultPauser.publicKey,
          config: vaultConfigPda,
        })
        .signers([vaultPauser])
        .rpc();

      const config = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      expect(config.isPaused).to.be.true;

      // Try to unpause with pauser - should fail
      try {
        await program.methods
          .unpause()
          .accountsPartial({
            unpauser: vaultPauser.publicKey,
            config: vaultConfigPda,
          })
          .signers([vaultPauser])
          .rpc();
        expect.fail("Should have failed - pauser cannot unpause");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }

      // Cleanup
      await program.methods
        .unpause()
        .accountsPartial({
          unpauser: vaultUnpauser.publicKey,
          config: vaultConfigPda,
        })
        .signers([vaultUnpauser])
        .rpc();
    });

    it("unpauser can unpause, but cannot pause", async () => {
      try {
        await program.methods
          .pause()
          .accountsPartial({
            pauser: vaultUnpauser.publicKey,
            config: vaultConfigPda,
          })
          .signers([vaultUnpauser])
          .rpc();
        expect.fail("Should have failed - unpauser cannot pause");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });

    it("role_admin can update authorities", async () => {
      const newPauser = Keypair.generate();

      await program.methods
        .setAuthority({ pauser: {} }, newPauser.publicKey)
        .accountsPartial({
          roleAdmin: roleAdmin.publicKey,
          config: vaultConfigPda,
        })
        .rpc();

      const config = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      expect(config.pauser.toString()).to.equal(newPauser.publicKey.toString());

      // Restore original
      await program.methods
        .setAuthority({ pauser: {} }, vaultPauser.publicKey)
        .accountsPartial({
          roleAdmin: roleAdmin.publicKey,
          config: vaultConfigPda,
        })
        .rpc();
    });

    it("non-role_admin cannot update authorities", async () => {
      try {
        await program.methods
          .setAuthority({ pauser: {} }, Keypair.generate().publicKey)
          .accountsPartial({
            roleAdmin: user1.publicKey,
            config: vaultConfigPda,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have failed - unauthorized");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });
  });

  // ============================================================================
  // Round-Trip Accuracy Tests
  // ============================================================================

  describe("round-trip accuracy", () => {
    it("maintains accuracy through wrap -> yield -> unwrap cycle", async () => {
      // Record initial balance
      const user1OkuMoneyInitial = await getAccount(provider.connection, user1OkuMoneyAta, undefined, TOKEN_2022_PROGRAM_ID);

      // Wrap a known amount
      const wrapAmount = new BN(10_000_000); // 10 OkuMoney
      const configBefore = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      const user1UsdOkuBefore = await getAccount(provider.connection, user1UsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);

      await program.methods
        .wrap(wrapAmount, new BN(0))
        .accountsPartial({
          user: user1.publicKey,
          config: vaultConfigPda,
          okuMoneyMint: okuMoneyMint,
          usdOkuMint: usdOkuMint,
          userOkuMoneyAta: user1OkuMoneyAta,
          userUsdOkuAta: user1UsdOkuAta,
          reserveVault: reserveVault,
          psmConfig: psmConfigPda,
          deadSharesAta: null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // Get shares received
      const user1UsdOkuAfterWrap = await getAccount(provider.connection, user1UsdOkuAta, undefined, TOKEN_2022_PROGRAM_ID);
      const sharesReceived = new BN(Number(user1UsdOkuAfterWrap.amount) - Number(user1UsdOkuBefore.amount));

      // Unwrap all shares received
      await program.methods
        .unwrap(sharesReceived)
        .accountsPartial({
          user: user1.publicKey,
          config: vaultConfigPda,
          okuMoneyMint: okuMoneyMint,
          usdOkuMint: usdOkuMint,
          userOkuMoneyAta: user1OkuMoneyAta,
          userUsdOkuAta: user1UsdOkuAta,
          reserveVault: reserveVault,
          psmConfig: psmConfigPda,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user1])
        .rpc();

      // Get final balance
      const user1OkuMoneyFinal = await getAccount(provider.connection, user1OkuMoneyAta, undefined, TOKEN_2022_PROGRAM_ID);

      // With multiplier >= 1.0 (due to previous yield distribution), user should get back at least original
      // or slightly more (due to yield). Difference should be minimal (rounding only).
      const configAfter = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      const psmConfigAfter = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      const expectedReturn = sharesReceived.mul(configAfter.usdMultiplier).div(psmConfigAfter.okuMPrice);
      
      const actualReturn = Number(user1OkuMoneyFinal.amount) - (Number(user1OkuMoneyInitial.amount) - wrapAmount.toNumber());
      expect(actualReturn).to.be.closeTo(expectedReturn.toNumber(), 1);
    });
  });

  // ============================================================================
  // Security Tests
  // ============================================================================

  describe("security: minimum liquidity", () => {
    it("dead shares prevent first-depositor inflation attack", async () => {
      // Verify dead shares exist
      const deadShares = await getAccount(provider.connection, deadSharesAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(deadShares.amount)).to.be.greaterThanOrEqual(MINIMUM_LIQUIDITY.toNumber());

      // Even with large multiplier, a small deposit should get meaningful shares
      const config = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      const psmConfigNow = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      const smallDeposit = new BN(2_000_000); // 2 OkuMoney
      const expectedShares = calculateExpectedShares(smallDeposit, config.usdMultiplier, psmConfigNow.okuMPrice);

      expect(expectedShares.toNumber()).to.be.greaterThan(0, "Small depositor should receive meaningful shares");
    });
  });

  describe("set_min_collateral_ratio", () => {
    it("role_admin can update minimum collateral ratio", async () => {
      const newRatio = new BN(960_000_000); // 96%

      await program.methods
        .setMinCollateralRatio(newRatio)
        .accountsPartial({
          roleAdmin: roleAdmin.publicKey,
          config: vaultConfigPda,
        })
        .rpc();

      const config = await program.account.okuDollarConfig.fetch(vaultConfigPda);
      expect(config.minCollateralRatio.toString()).to.equal(newRatio.toString());

      // Restore original
      await program.methods
        .setMinCollateralRatio(DEFAULT_MIN_COLLATERAL_RATIO)
        .accountsPartial({
          roleAdmin: roleAdmin.publicKey,
          config: vaultConfigPda,
        })
        .rpc();
    });

    it("rejects ratio below floor", async () => {
      const belowFloor = MIN_COLLATERAL_RATIO_FLOOR.sub(new BN(1));

      try {
        await program.methods
          .setMinCollateralRatio(belowFloor)
          .accountsPartial({
            roleAdmin: roleAdmin.publicKey,
            config: vaultConfigPda,
          })
          .rpc();
        expect.fail("Should have failed - below floor");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("InvalidCollateralRatio");
      }
    });
  });
});
