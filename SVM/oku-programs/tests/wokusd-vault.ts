import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeInterestBearingMintInstruction,
  createMint,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import { WokusdVault } from "../target/types/wokusd_vault";
import { LitePsm } from "../target/types/lite_psm";
import {
  psmOrchestrator,
  initializePSMIfNeeded,
  safeAirdropAll,
  ensureAta,
  mintOkusdViaProgram,
  DECIMALS,
} from "./shared/setup";

// Use anchor's web3 to avoid version conflicts
const { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

describe("wokusd-vault", () => {
  let provider: anchor.AnchorProvider;
  let program: Program<WokusdVault>;
  let psmProgram: Program<LitePsm>;
  let payer: Keypair;

  // Granular Authority Keypairs (vault-specific RBAC)
  let admin: Keypair;
  const warmMultisig = Keypair.generate(); // VAULT_PAUSER
  const coldMultisig = Keypair.generate(); // VAULT_UNPAUSER

  // User keypairs
  const user = Keypair.generate();
  const user2 = Keypair.generate();

  // Mint keypairs (only used if we need to create mints for PSM)
  const usdcMintKeypair = Keypair.generate();
  const okusdMintKeypair = Keypair.generate();

  // PDAs
  let configPda: PublicKey;
  let configBump: number;
  let psmConfigPda: PublicKey;

  // Token accounts
  let vaultOkusdAta: PublicKey;
  let userOkusdAta: PublicKey;
  let userWokusdAta: PublicKey;
  let user2OkusdAta: PublicKey;
  let user2WokusdAta: PublicKey;
  let userUsdcAta: PublicKey;
  let user2UsdcAta: PublicKey;
  let psmVaultUsdcAta: PublicKey;

  // Mints
  let usdcMint: PublicKey;
  let okusdMint: PublicKey;
  let wokusdMint: PublicKey; // Created by vault

  before(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    program = anchor.workspace.WokusdVault as Program<WokusdVault>;
    psmProgram = anchor.workspace.LitePsm as Program<LitePsm>;
    payer = (provider.wallet as anchor.Wallet).payer;
    admin = payer;

    // Derive PSM config PDA
    [psmConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")], psmProgram.programId
    );

    // Check if PSM already initialized — reuse its mints if so
    let psmExists = false;
    try {
      const existingConfig = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      psmExists = true;
      usdcMint = existingConfig.usdcMint;
      okusdMint = existingConfig.okusdMint;
    } catch {
      // PSM not initialized — we'll create mints and initialize it
    }

    if (!psmExists) {
      // Create USDC mint (standard SPL token)
      usdcMint = await createMint(
        provider.connection, payer, payer.publicKey, null, DECIMALS,
        usdcMintKeypair, undefined, TOKEN_PROGRAM_ID
      );

      // Create OkuUSD mint (Token-2022 with Interest-Bearing extension)
      // PSM config PDA is mint/freeze authority (matches production setup)
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
        psmOrchestrator.publicKey, // rate authority (rebaser)
        0, // initial rate (0 bps)
        TOKEN_2022_PROGRAM_ID
      );

      const initMintIx = createInitializeMintInstruction(
        okusdMintKeypair.publicKey,
        DECIMALS,
        psmConfigPda, // mint authority = PSM config PDA
        psmConfigPda, // freeze authority = PSM config PDA
        TOKEN_2022_PROGRAM_ID
      );

      const tx = new anchor.web3.Transaction().add(
        createAccountIx, initInterestBearingIx, initMintIx
      );
      await provider.sendAndConfirm(tx, [payer, okusdMintKeypair]);
      okusdMint = okusdMintKeypair.publicKey;
    }

    // Initialize PSM (idempotent — returns cached result if already done)
    const psmSetup = await initializePSMIfNeeded(
      psmProgram as any, provider, payer, usdcMint, okusdMint
    );
    psmVaultUsdcAta = psmSetup.vaultUsdcAta;

    // Airdrop SOL to test accounts with proper confirmation
    await safeAirdropAll(
      provider.connection,
      [user, user2, warmMultisig, coldMultisig],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    // Derive vault config PDA
    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_config")],
      program.programId
    );

    // Derive vault OkuUSD ATA (will be created by vault initialize)
    vaultOkusdAta = getAssociatedTokenAddressSync(
      okusdMint, configPda, true, TOKEN_2022_PROGRAM_ID
    );

    // Create USDC ATAs for users and fund them (needed to mint OkuUSD via PSM)
    userUsdcAta = getAssociatedTokenAddressSync(usdcMint, user.publicKey, false, TOKEN_PROGRAM_ID);
    user2UsdcAta = getAssociatedTokenAddressSync(usdcMint, user2.publicKey, false, TOKEN_PROGRAM_ID);
    await ensureAta(provider.connection, payer, userUsdcAta, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await ensureAta(provider.connection, payer, user2UsdcAta, user2.publicKey, usdcMint, TOKEN_PROGRAM_ID);

    const OKUSD_PER_USER = 10_000_000_000; // 10,000 OkuUSD each (plenty for vault tests)
    await mintTo(provider.connection, payer, usdcMint, userUsdcAta, payer, OKUSD_PER_USER, [], undefined, TOKEN_PROGRAM_ID);
    await mintTo(provider.connection, payer, usdcMint, user2UsdcAta, payer, OKUSD_PER_USER, [], undefined, TOKEN_PROGRAM_ID);

    // Create OkuUSD ATAs for users
    userOkusdAta = getAssociatedTokenAddressSync(okusdMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
    user2OkusdAta = getAssociatedTokenAddressSync(okusdMint, user2.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await ensureAta(provider.connection, payer, userOkusdAta, user.publicKey, okusdMint, TOKEN_2022_PROGRAM_ID);
    await ensureAta(provider.connection, payer, user2OkusdAta, user2.publicKey, okusdMint, TOKEN_2022_PROGRAM_ID);

    // Mint OkuUSD to users via PSM (USDC -> OkuUSD at 1:1)
    await mintOkusdViaProgram(
      psmProgram as any, user, new BN(OKUSD_PER_USER), psmConfigPda,
      usdcMint, okusdMint, userUsdcAta, userOkusdAta, psmVaultUsdcAta
    );
    await mintOkusdViaProgram(
      psmProgram as any, user2, new BN(OKUSD_PER_USER), psmConfigPda,
      usdcMint, okusdMint, user2UsdcAta, user2OkusdAta, psmVaultUsdcAta
    );

    // Initialize vault if not already done (may have been initialized by router tests)
    let vaultAlreadyInitialized = false;
    try {
      const existingVault = await program.account.vaultConfig.fetch(configPda);
      vaultAlreadyInitialized = true;
      wokusdMint = existingVault.wokusdMint;

      // If vault was initialized by another test, update authorities to our test keypairs
      // so vault-specific RBAC tests work correctly
      try {
        await program.methods
          .setAuthority({ pauser: {} }, warmMultisig.publicKey)
          .accountsPartial({ roleAdmin: admin.publicKey, config: configPda })
          .rpc();
        await program.methods
          .setAuthority({ unpauser: {} }, coldMultisig.publicKey)
          .accountsPartial({ roleAdmin: admin.publicKey, config: configPda })
          .rpc();
      } catch {
        // Authorities may already be correct
      }
    } catch {
      // Not initialized yet
    }

    if (!vaultAlreadyInitialized) {
      const wokusdMintKeypair = Keypair.generate();
      await program.methods
        .initialize(warmMultisig.publicKey, coldMultisig.publicKey)
        .accountsPartial({
          roleAdmin: admin.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMintKeypair.publicKey,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([wokusdMintKeypair])
        .rpc();
      wokusdMint = wokusdMintKeypair.publicKey;
    }

    // Derive user wOkuUSD ATAs (depends on wokusdMint)
    userWokusdAta = getAssociatedTokenAddressSync(wokusdMint, user.publicKey, false, TOKEN_PROGRAM_ID);
    user2WokusdAta = getAssociatedTokenAddressSync(wokusdMint, user2.publicKey, false, TOKEN_PROGRAM_ID);
  });

  describe("initialize", () => {
    it("vault is initialized with correct config", async () => {
      const config = await program.account.vaultConfig.fetch(configPda);
      expect(config.roleAdmin.toString()).to.equal(admin.publicKey.toString());
      expect(config.pauser.toString()).to.equal(warmMultisig.publicKey.toString());
      expect(config.unpauser.toString()).to.equal(coldMultisig.publicKey.toString());
      expect(config.okusdMint.toString()).to.equal(okusdMint.toString());
      expect(config.wokusdMint.toString()).to.equal(wokusdMint.toString());
      expect(config.vaultOkusd.toString()).to.equal(vaultOkusdAta.toString());
      expect(config.isPaused).to.be.false;
    });
  });

  describe("wrap", () => {
    it("wraps OkuUSD -> wOkuUSD (correct share calculation)", async () => {
      const wrapAmount = new BN(1_000_000_000); // 1000 OkuUSD

      const configBefore = await program.account.vaultConfig.fetch(configPda);
      const vaultOkusdBefore = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const userOkusdBefore = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      // User's wOkuUSD ATA may not exist yet (created by init_if_needed on first wrap)
      let userWokusdAmountBefore = BigInt(0);
      try {
        const acct = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
        userWokusdAmountBefore = acct.amount;
      } catch {
        // ATA doesn't exist yet — will be created by wrap
      }

      // Calculate expected shares
      const expectedShares = configBefore.totalShares.toNumber() === 0
        ? wrapAmount.toNumber()  // First deposit: 1:1
        : Math.floor(wrapAmount.toNumber() * configBefore.totalShares.toNumber() / Number(vaultOkusdBefore.amount));

      await program.methods
        .wrap(wrapAmount)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Verify OkuUSD transferred from user to vault
      const userOkusdAfter = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const vaultOkusdAfter = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      expect(Number(userOkusdBefore.amount) - Number(userOkusdAfter.amount)).to.equal(wrapAmount.toNumber());
      expect(Number(vaultOkusdAfter.amount) - Number(vaultOkusdBefore.amount)).to.equal(wrapAmount.toNumber());

      // Verify wOkuUSD shares minted correctly
      const userWokusdAfter = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      const sharesMinted = Number(userWokusdAfter.amount) - Number(userWokusdAmountBefore);
      expect(sharesMinted).to.equal(expectedShares);

      // Verify total shares updated
      const configAfter = await program.account.vaultConfig.fetch(configPda);
      expect(configAfter.totalShares.toNumber() - configBefore.totalShares.toNumber()).to.equal(expectedShares);
    });

    it("wraps OkuUSD -> wOkuUSD (subsequent deposit maintains ratio)", async () => {
      const wrapAmount = new BN(500_000_000); // 500 OkuUSD

      const configBefore = await program.account.vaultConfig.fetch(configPda);
      const vaultOkusdBefore = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const userWokusdBefore = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);

      // Calculate expected shares: shares = okusd_amount * total_shares / vault_balance
      const expectedShares = wrapAmount.toNumber() * configBefore.totalShares.toNumber() / Number(vaultOkusdBefore.amount);

      await program.methods
        .wrap(wrapAmount)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Verify wOkuUSD minted matches expected
      const userWokusdAfter = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      const sharesMinted = Number(userWokusdAfter.amount) - Number(userWokusdBefore.amount);
      expect(sharesMinted).to.equal(expectedShares);
    });

    it("fails to wrap when paused", async () => {
      // Pause the vault (uses warmMultisig)
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
          .wrap(new BN(1_000_000))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            okusdMint: okusdMint,
            wokusdMint: wokusdMint,
            userOkusdAta: userOkusdAta,
            userWokusdAta: userWokusdAta,
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
        expect(err.error.errorCode.code).to.equal("Paused");
      }

      // Unpause for future tests (uses coldMultisig)
      await program.methods
        .unpause()
        .accountsPartial({
          unpauser: coldMultisig.publicKey,
          config: configPda,
        })
        .signers([coldMultisig])
        .rpc();
    });

    it("fails to wrap zero amount", async () => {
      try {
        await program.methods
          .wrap(new BN(0))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            okusdMint: okusdMint,
            wokusdMint: wokusdMint,
            userOkusdAta: userOkusdAta,
            userWokusdAta: userWokusdAta,
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
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });
  });

  describe("unwrap", () => {
    it("unwraps wOkuUSD -> OkuUSD", async () => {
      const unwrapShares = new BN(300_000_000); // 300 shares

      const configBefore = await program.account.vaultConfig.fetch(configPda);
      const vaultOkusdBefore = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const userOkusdBefore = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const userWokusdBefore = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);

      // Calculate expected OkuUSD: okusd = shares * vault_balance / total_shares
      const expectedOkusd = unwrapShares.toNumber() * Number(vaultOkusdBefore.amount) / configBefore.totalShares.toNumber();

      await program.methods
        .unwrap(unwrapShares)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Verify wOkuUSD burned from user
      const userWokusdAfter = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      expect(Number(userWokusdBefore.amount) - Number(userWokusdAfter.amount)).to.equal(unwrapShares.toNumber());

      // Verify OkuUSD transferred to user
      const userOkusdAfter = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(userOkusdAfter.amount) - Number(userOkusdBefore.amount)).to.equal(expectedOkusd);

      // Verify vault balance decreased
      const vaultOkusdAfter = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(vaultOkusdBefore.amount) - Number(vaultOkusdAfter.amount)).to.equal(expectedOkusd);

      // Verify total shares decreased
      const configAfter = await program.account.vaultConfig.fetch(configPda);
      expect(configBefore.totalShares.toNumber() - configAfter.totalShares.toNumber()).to.equal(unwrapShares.toNumber());
    });

    it("CRITICAL: allows unwrap when vault is paused (users must always be able to exit)", async () => {
      // Pause the vault (uses warmMultisig)
      await program.methods
        .pause()
        .accountsPartial({
          pauser: warmMultisig.publicKey,
          config: configPda,
        })
        .signers([warmMultisig])
        .rpc();

      // Verify vault is paused
      let config = await program.account.vaultConfig.fetch(configPda);
      expect(config.isPaused).to.be.true;

      const unwrapShares = new BN(100_000_000); // 100 shares

      const configBefore = await program.account.vaultConfig.fetch(configPda);
      const vaultOkusdBefore = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const userOkusdBefore = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const userWokusdBefore = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);

      // Calculate expected OkuUSD: okusd = shares * vault_balance / total_shares
      const expectedOkusd = unwrapShares.toNumber() * Number(vaultOkusdBefore.amount) / configBefore.totalShares.toNumber();

      // Unwrap should succeed even when paused
      await program.methods
        .unwrap(unwrapShares)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Verify wOkuUSD burned from user
      const userWokusdAfter = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      expect(Number(userWokusdBefore.amount) - Number(userWokusdAfter.amount)).to.equal(unwrapShares.toNumber());

      // Verify OkuUSD transferred to user
      const userOkusdAfter = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(userOkusdAfter.amount) - Number(userOkusdBefore.amount)).to.equal(expectedOkusd);

      // Unpause for future tests (uses coldMultisig)
      await program.methods
        .unpause()
        .accountsPartial({
          unpauser: coldMultisig.publicKey,
          config: configPda,
        })
        .signers([coldMultisig])
        .rpc();
    });

    it("fails to unwrap zero shares", async () => {
      try {
        await program.methods
          .unwrap(new BN(0))
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            okusdMint: okusdMint,
            wokusdMint: wokusdMint,
            userOkusdAta: userOkusdAta,
            userWokusdAta: userWokusdAta,
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
        expect(err.error.errorCode.code).to.equal("ZeroAmount");
      }
    });

    it("fails to unwrap more shares than owned", async () => {
      const userWokusd = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      const excessiveShares = new BN(Number(userWokusd.amount) + 1_000_000_000);

      try {
        await program.methods
          .unwrap(excessiveShares)
          .accountsPartial({
            user: user.publicKey,
            config: configPda,
            okusdMint: okusdMint,
            wokusdMint: wokusdMint,
            userOkusdAta: userOkusdAta,
            userWokusdAta: userWokusdAta,
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
        // Should fail due to insufficient balance (SPL token error or our custom error)
        const errorCode = err.error?.errorCode?.code || err.message || "";
        expect(errorCode).to.satisfy((code: string) =>
          code === "InsufficientShares" || code.includes("insufficient") || code.includes("Error")
        );
      }
    });
  });

  describe("RBAC: Pause/Unpause Role Separation", () => {
    it("vault_pauser (warm multisig) can pause", async () => {
      await program.methods
        .pause()
        .accountsPartial({
          pauser: warmMultisig.publicKey,
          config: configPda,
        })
        .signers([warmMultisig])
        .rpc();

      const config = await program.account.vaultConfig.fetch(configPda);
      expect(config.isPaused).to.be.true;
    });

    it("vault_unpauser (cold multisig) can unpause", async () => {
      await program.methods
        .unpause()
        .accountsPartial({
          unpauser: coldMultisig.publicKey,
          config: configPda,
        })
        .signers([coldMultisig])
        .rpc();

      const config = await program.account.vaultConfig.fetch(configPda);
      expect(config.isPaused).to.be.false;
    });

    it("vault_pauser CANNOT unpause (prevents griefing)", async () => {
      // First pause with warmMultisig
      await program.methods
        .pause()
        .accountsPartial({
          pauser: warmMultisig.publicKey,
          config: configPda,
        })
        .signers([warmMultisig])
        .rpc();

      // Now try to unpause with warmMultisig - should fail
      try {
        await program.methods
          .unpause()
          .accountsPartial({
            unpauser: warmMultisig.publicKey, // Wrong authority
            config: configPda,
          })
          .signers([warmMultisig])
          .rpc();
        expect.fail("Should have failed - pauser should not be able to unpause");
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

    it("vault_unpauser CANNOT pause (role separation)", async () => {
      try {
        await program.methods
          .pause()
          .accountsPartial({
            pauser: coldMultisig.publicKey, // Wrong authority
            config: configPda,
          })
          .signers([coldMultisig])
          .rpc();
        expect.fail("Should have failed - unpauser should not be able to pause");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });

    it("non-authority user cannot pause", async () => {
      try {
        await program.methods
          .pause()
          .accountsPartial({
            pauser: user.publicKey, // Wrong authority
            config: configPda,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });

    it("non-authority user cannot unpause", async () => {
      // First pause properly
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
            unpauser: user.publicKey, // Wrong authority
            config: configPda,
          })
          .signers([user])
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
  });

  describe("exchange rate", () => {
    it("maintains proper exchange rate after multiple operations", async () => {
      // Get initial state
      const configInitial = await program.account.vaultConfig.fetch(configPda);
      const vaultInitial = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      // Calculate initial exchange rate
      const initialRate = Number(vaultInitial.amount) / configInitial.totalShares.toNumber();

      // Wrap more OkuUSD
      const wrapAmount = new BN(100_000_000); // 100 OkuUSD
      await program.methods
        .wrap(wrapAmount)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Get new state
      const configAfter = await program.account.vaultConfig.fetch(configPda);
      const vaultAfter = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      // Calculate new exchange rate
      const newRate = Number(vaultAfter.amount) / configAfter.totalShares.toNumber();

      // Exchange rate should remain the same (1:1 in this case)
      expect(Math.abs(newRate - initialRate)).to.be.lessThan(0.000001);
    });
  });

  describe("second user operations", () => {
    it("allows second user to wrap and receive proportional shares", async () => {
      const wrapAmount = new BN(200_000_000); // 200 OkuUSD

      const configBefore = await program.account.vaultConfig.fetch(configPda);
      const vaultBefore = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      // Calculate expected shares
      const expectedShares = wrapAmount.toNumber() * configBefore.totalShares.toNumber() / Number(vaultBefore.amount);

      await program.methods
        .wrap(wrapAmount)
        .accountsPartial({
          user: user2.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: user2OkusdAta,
          userWokusdAta: user2WokusdAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      // Verify shares received
      const user2Wokusd = await getAccount(provider.connection, user2WokusdAta, undefined, TOKEN_PROGRAM_ID);
      expect(Number(user2Wokusd.amount)).to.equal(expectedShares);
    });

    it("allows second user to unwrap", async () => {
      const user2Wokusd = await getAccount(provider.connection, user2WokusdAta, undefined, TOKEN_PROGRAM_ID);
      const unwrapShares = new BN(Math.floor(Number(user2Wokusd.amount) / 2)); // Unwrap half

      const configBefore = await program.account.vaultConfig.fetch(configPda);
      const vaultBefore = await getAccount(provider.connection, vaultOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      const user2OkusdBefore = await getAccount(provider.connection, user2OkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      // Calculate expected OkuUSD
      const expectedOkusd = unwrapShares.toNumber() * Number(vaultBefore.amount) / configBefore.totalShares.toNumber();

      await program.methods
        .unwrap(unwrapShares)
        .accountsPartial({
          user: user2.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: user2OkusdAta,
          userWokusdAta: user2WokusdAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user2])
        .rpc();

      // Verify OkuUSD received
      const user2OkusdAfter = await getAccount(provider.connection, user2OkusdAta, undefined, TOKEN_2022_PROGRAM_ID);
      expect(Number(user2OkusdAfter.amount) - Number(user2OkusdBefore.amount)).to.equal(expectedOkusd);
    });
  });

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

      const config = await program.account.vaultConfig.fetch(configPda);
      expect(config.pauser.toString()).to.equal(newPauser.publicKey.toString());

      // Restore original pauser
      await program.methods
        .setAuthority({ pauser: {} }, warmMultisig.publicKey)
        .accountsPartial({
          roleAdmin: admin.publicKey,
          config: configPda,
        })
        .rpc();
    });

    it("role_admin can update unpauser", async () => {
      const newUnpauser = Keypair.generate();

      await program.methods
        .setAuthority({ unpauser: {} }, newUnpauser.publicKey)
        .accountsPartial({
          roleAdmin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      const config = await program.account.vaultConfig.fetch(configPda);
      expect(config.unpauser.toString()).to.equal(newUnpauser.publicKey.toString());

      // Restore original unpauser
      await program.methods
        .setAuthority({ unpauser: {} }, coldMultisig.publicKey)
        .accountsPartial({
          roleAdmin: admin.publicKey,
          config: configPda,
        })
        .rpc();
    });

    it("non-role_admin rejected", async () => {
      try {
        await program.methods
          .setAuthority({ pauser: {} }, Keypair.generate().publicKey)
          .accountsPartial({
            roleAdmin: user.publicKey, // Not admin
            config: configPda,
          })
          .signers([user])
          .rpc();
        expect.fail("Should have failed");
      } catch (err: any) {
        expect(err.error.errorCode.code).to.equal("Unauthorized");
      }
    });
  });

  describe("round-trip accuracy", () => {
    it("maintains accuracy on wrap -> unwrap round trip", async () => {
      // Get initial OkuUSD balance
      const userOkusdInitial = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      // Wrap 1000 OkuUSD
      const wrapAmount = new BN(1_000_000); // 1 OkuUSD

      // Get shares before wrap
      const userWokusdBefore = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);

      await program.methods
        .wrap(wrapAmount)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Get shares received
      const userWokusdAfter = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      const sharesReceived = new BN(Number(userWokusdAfter.amount) - Number(userWokusdBefore.amount));

      // Unwrap all shares received
      await program.methods
        .unwrap(sharesReceived)
        .accountsPartial({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusd: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user])
        .rpc();

      // Get final OkuUSD balance
      const userOkusdFinal = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      // Should get back at least the original amount minus 1 unit for rounding
      const difference = Number(userOkusdInitial.amount) - Number(userOkusdFinal.amount);
      expect(difference).to.be.lessThanOrEqual(1);
    });
  });
});
