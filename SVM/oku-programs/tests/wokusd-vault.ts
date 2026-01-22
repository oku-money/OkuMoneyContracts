import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  getAccount,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeInterestBearingMintInstruction,
  mintTo,
} from "@solana/spl-token";
import { expect } from "chai";
import { WokusdVault } from "../target/types/wokusd_vault";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Use anchor's web3 to avoid version conflicts
const { Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const IDL = JSON.parse(readFileSync(join(__dirname, "../target/idl/wokusd_vault.json"), "utf-8"));
// Program ID from Anchor.toml
const PROGRAM_ID = new PublicKey("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

describe("wokusd-vault", () => {
  // Delay initialization until tests run
  let provider: anchor.AnchorProvider;
  let program: Program<WokusdVault>;
  let payer: Keypair;

  // Keypairs
  let admin: Keypair;
  const user = Keypair.generate();
  const user2 = Keypair.generate();

  // Mint keypairs
  const okusdMintKeypair = Keypair.generate();

  // PDAs
  let configPda: PublicKey;
  let configBump: number;

  // Token accounts
  let vaultOkusdAta: PublicKey;
  let userOkusdAta: PublicKey;
  let userWokusdAta: PublicKey;
  let user2OkusdAta: PublicKey;
  let user2WokusdAta: PublicKey;

  // Mints
  let okusdMint: PublicKey;
  let wokusdMint: PublicKey; // Created by vault

  const DECIMALS = 6;

  before(async () => {
    provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    // Anchor 0.29 API: new Program(idl, programId, provider)
    program = new Program<WokusdVault>(IDL as any, PROGRAM_ID, provider);
    payer = (provider.wallet as anchor.Wallet).payer;
    admin = payer;
    // Airdrop SOL to test accounts
    await Promise.all([
      provider.connection.requestAirdrop(user.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL),
      provider.connection.requestAirdrop(user2.publicKey, 10 * anchor.web3.LAMPORTS_PER_SOL),
    ]);

    // Wait for airdrops to confirm
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Derive PDAs
    [configPda, configBump] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_config")],
      program.programId
    );

    // Create OkuUSD mint (Token-2022 with Interest-Bearing extension)
    // This simulates OkuUSD created by the LitePSM or external process
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
      payer.publicKey, // rate authority (we'll control for tests)
      0, // initial rate
      TOKEN_2022_PROGRAM_ID
    );

    // For testing, we set ourselves as mint authority so we can mint OkuUSD to users
    const initMintIx = createInitializeMintInstruction(
      okusdMintKeypair.publicKey,
      DECIMALS,
      payer.publicKey, // mint authority = us for testing
      null,
      TOKEN_2022_PROGRAM_ID
    );

    const tx = new anchor.web3.Transaction().add(
      createAccountIx,
      initInterestBearingIx,
      initMintIx
    );

    await provider.sendAndConfirm(tx, [payer, okusdMintKeypair]);
    okusdMint = okusdMintKeypair.publicKey;

    // Derive vault OkuUSD ATA (will be created by initialize)
    vaultOkusdAta = getAssociatedTokenAddressSync(
      okusdMint,
      configPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    // Create user OkuUSD accounts
    userOkusdAta = getAssociatedTokenAddressSync(
      okusdMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    user2OkusdAta = getAssociatedTokenAddressSync(
      okusdMint,
      user2.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    // Create user OkuUSD accounts
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

    const createUser2OkusdTx = new anchor.web3.Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey,
        user2OkusdAta,
        user2.publicKey,
        okusdMint,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(createUser2OkusdTx, [payer]);

    // Mint OkuUSD to users for testing
    await mintTo(
      provider.connection,
      payer,
      okusdMint,
      userOkusdAta,
      payer,
      1_000_000_000_000, // 1M OkuUSD
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );

    await mintTo(
      provider.connection,
      payer,
      okusdMint,
      user2OkusdAta,
      payer,
      1_000_000_000_000, // 1M OkuUSD
      [],
      undefined,
      TOKEN_2022_PROGRAM_ID
    );
  });

  describe("initialize", () => {
    it("initializes the vault correctly", async () => {
      // Generate wOkuUSD mint keypair
      const wokusdMintKeypair = Keypair.generate();

      await program.methods
        .initialize()
        .accounts({
          admin: admin.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMintKeypair.publicKey,
          vaultOkusdAta: vaultOkusdAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([wokusdMintKeypair])
        .rpc();

      wokusdMint = wokusdMintKeypair.publicKey;

      // Verify config
      const config = await program.account.vaultConfig.fetch(configPda);
      expect(config.admin.toString()).to.equal(admin.publicKey.toString());
      expect(config.okusdMint.toString()).to.equal(okusdMint.toString());
      expect(config.wokusdMint.toString()).to.equal(wokusdMint.toString());
      expect(config.vaultOkusdAta.toString()).to.equal(vaultOkusdAta.toString());
      expect(config.totalShares.toNumber()).to.equal(0);
      expect(config.isPaused).to.be.false;

      // Derive user wOkuUSD ATAs
      userWokusdAta = getAssociatedTokenAddressSync(
        wokusdMint,
        user.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );

      user2WokusdAta = getAssociatedTokenAddressSync(
        wokusdMint,
        user2.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );
    });
  });

  describe("wrap", () => {
    it("wraps OkuUSD -> wOkuUSD (first deposit 1:1)", async () => {
      const wrapAmount = new BN(1_000_000_000); // 1000 OkuUSD

      const userOkusdBefore = await getAccount(provider.connection, userOkusdAta, undefined, TOKEN_2022_PROGRAM_ID);

      await program.methods
        .wrap(wrapAmount)
        .accounts({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusdAta: vaultOkusdAta,
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
      expect(Number(vaultOkusdAfter.amount)).to.equal(wrapAmount.toNumber());

      // Verify wOkuUSD minted to user (1:1 for first deposit)
      const userWokusdAfter = await getAccount(provider.connection, userWokusdAta, undefined, TOKEN_PROGRAM_ID);
      expect(Number(userWokusdAfter.amount)).to.equal(wrapAmount.toNumber());

      // Verify total shares updated
      const config = await program.account.vaultConfig.fetch(configPda);
      expect(config.totalShares.toNumber()).to.equal(wrapAmount.toNumber());
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
        .accounts({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusdAta: vaultOkusdAta,
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
      // Pause the vault
      await program.methods
        .setPaused(true)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      try {
        await program.methods
          .wrap(new BN(1_000_000))
          .accounts({
            user: user.publicKey,
            config: configPda,
            okusdMint: okusdMint,
            wokusdMint: wokusdMint,
            userOkusdAta: userOkusdAta,
            userWokusdAta: userWokusdAta,
            vaultOkusdAta: vaultOkusdAta,
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

      // Unpause for future tests
      await program.methods
        .setPaused(false)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();
    });

    it("fails to wrap zero amount", async () => {
      try {
        await program.methods
          .wrap(new BN(0))
          .accounts({
            user: user.publicKey,
            config: configPda,
            okusdMint: okusdMint,
            wokusdMint: wokusdMint,
            userOkusdAta: userOkusdAta,
            userWokusdAta: userWokusdAta,
            vaultOkusdAta: vaultOkusdAta,
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
        .accounts({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusdAta: vaultOkusdAta,
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

    it("allows unwrap when vault is paused", async () => {
      // Pause the vault
      await program.methods
        .setPaused(true)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
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
        .accounts({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusdAta: vaultOkusdAta,
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

      // Unpause for future tests
      await program.methods
        .setPaused(false)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();
    });

    it("fails to unwrap zero shares", async () => {
      try {
        await program.methods
          .unwrap(new BN(0))
          .accounts({
            user: user.publicKey,
            config: configPda,
            okusdMint: okusdMint,
            wokusdMint: wokusdMint,
            userOkusdAta: userOkusdAta,
            userWokusdAta: userWokusdAta,
            vaultOkusdAta: vaultOkusdAta,
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
          .accounts({
            user: user.publicKey,
            config: configPda,
            okusdMint: okusdMint,
            wokusdMint: wokusdMint,
            userOkusdAta: userOkusdAta,
            userWokusdAta: userWokusdAta,
            vaultOkusdAta: vaultOkusdAta,
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
        expect(err).to.exist;
      }
    });
  });

  describe("set_paused", () => {
    it("allows admin to pause and unpause", async () => {
      await program.methods
        .setPaused(true)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      let config = await program.account.vaultConfig.fetch(configPda);
      expect(config.isPaused).to.be.true;

      await program.methods
        .setPaused(false)
        .accounts({
          admin: admin.publicKey,
          config: configPda,
        })
        .rpc();

      config = await program.account.vaultConfig.fetch(configPda);
      expect(config.isPaused).to.be.false;
    });

    it("fails when non-admin tries to pause", async () => {
      try {
        await program.methods
          .setPaused(true)
          .accounts({
            admin: user.publicKey,
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
        .accounts({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusdAta: vaultOkusdAta,
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
        .accounts({
          user: user2.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: user2OkusdAta,
          userWokusdAta: user2WokusdAta,
          vaultOkusdAta: vaultOkusdAta,
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
        .accounts({
          user: user2.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: user2OkusdAta,
          userWokusdAta: user2WokusdAta,
          vaultOkusdAta: vaultOkusdAta,
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
        .accounts({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusdAta: vaultOkusdAta,
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
        .accounts({
          user: user.publicKey,
          config: configPda,
          okusdMint: okusdMint,
          wokusdMint: wokusdMint,
          userOkusdAta: userOkusdAta,
          userWokusdAta: userWokusdAta,
          vaultOkusdAta: vaultOkusdAta,
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
