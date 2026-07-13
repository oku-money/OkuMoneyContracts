/**
 * Direct-Mint Integration Tests
 *
 * Tests the permissioned OkuMoney mint path that does NOT require USDC
 * collateral on-chain. Matches EVM's `OkuMoney.mint(to, amount)` called
 * by a non-PSM `OKUM_MINTER` role holder.
 *
 * Covers:
 *   - `mint_oku_m_direct` — permissioned direct OkuM mint to recipient
 *   - `mint_usd_oku_direct` — permissioned mint + CPI wrap to usdOku
 *   - `set_direct_minter_allowance` — admin allowance management
 *   - `wrap_to` — oku-dollar wrap with separate receiver
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
import { OkuDollar } from "../../target/types/oku_dollar";
import { LitePsm } from "../../target/types/lite_psm";
import {
  psmOrchestrator,
  coldMultisig,
  initializePsm,
  DECIMALS,
  MAX_SUPPLY,
  mintOkuMoneyViaProgram,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  getProgram,
  warpSlots,
  expectBankrunError,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const PRECISION = new BN(1_000_000_000);
const MINIMUM_LIQUIDITY = new BN(1_000_000);
const DEFAULT_MIN_COLLATERAL_RATIO = new BN(950_000_000);

describe("direct-mint", () => {
  let h: BankrunHarness;
  let psmProgram: Program<LitePsm>;
  let vaultProgram: Program<OkuDollar>;
  let payer: Keypair;

  // Authorities
  const directMinter = Keypair.generate();
  const recipient = Keypair.generate();

  // Vault authorities
  const vaultPauser = Keypair.generate();
  const vaultUnpauser = Keypair.generate();
  const usdRebaser = Keypair.generate();
  const reserveManager = Keypair.generate();

  // Mints
  const okuMoneyMintKeypair = Keypair.generate();
  let okuMoneyMint: PublicKey;
  let usdcMint: PublicKey;

  // PDAs
  let psmConfigPda: PublicKey;
  let vaultConfigPda: PublicKey;
  let usdOkuMint: PublicKey;
  let reserveVault: PublicKey;
  let deadSharesAta: PublicKey;

  // ATAs
  let recipientOkuMoneyAta: PublicKey;
  let recipientUsdOkuAta: PublicKey;
  let vaultOkuMoneyAta: PublicKey;

  const DIRECT_MINTER_ALLOWANCE = new BN(50_000_000_000); // 50k with 6 decimals

  before(async () => {
    h = await startBankrun();
    payer = h.payer;
    psmProgram = h.program;
    vaultProgram = getProgram<OkuDollar>(h, "oku_dollar");

    // Derive PSM config PDA
    [psmConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config_v4")],
      psmProgram.programId
    );

    // Create mints
    okuMoneyMint = await createMintViaBankrun(
      h,
      psmConfigPda,
      psmConfigPda,
      DECIMALS,
      okuMoneyMintKeypair,
      TOKEN_2022_PROGRAM_ID
    );
    const usdcMintKeypair = Keypair.generate();
    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      payer.publicKey,
      DECIMALS,
      usdcMintKeypair,
      TOKEN_PROGRAM_ID
    );

    // Initialize PSM
    const psmSetup = await initializePsm(
      h,
      psmProgram,
      payer,
      usdcMint,
      okuMoneyMint
    );
    vaultOkuMoneyAta = psmSetup.vaultOkuMoneyAta;

    // Fund keypairs
    await fundKeypairs(
      h,
      [
        directMinter,
        recipient,
        vaultPauser,
        vaultUnpauser,
        usdRebaser,
        reserveManager,
      ],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    // Grant DirectMinter role to our test keypair
    await psmProgram.methods
      .setAuthority({ directMinter: {} }, directMinter.publicKey)
      .accountsPartial({
        roleAdmin: payer.publicKey,
        config: psmConfigPda,
      })
      .rpc();

    // Set direct minter allowance
    await psmProgram.methods
      .setDirectMinterAllowance(DIRECT_MINTER_ALLOWANCE)
      .accountsPartial({
        allowanceManager: coldMultisig.publicKey,
        config: psmConfigPda,
      })
      .signers([coldMultisig])
      .rpc();

    // Derive vault PDAs
    [vaultConfigPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("oku_dollar_config_v2")],
      vaultProgram.programId
    );
    [usdOkuMint] = PublicKey.findProgramAddressSync(
      [Buffer.from("usd_oku_mint_v2")],
      vaultProgram.programId
    );
    reserveVault = getAssociatedTokenAddressSync(
      okuMoneyMint,
      vaultConfigPda,
      true,
      TOKEN_2022_PROGRAM_ID
    );
    deadSharesAta = getAssociatedTokenAddressSync(
      usdOkuMint,
      SystemProgram.programId,
      true,
      TOKEN_2022_PROGRAM_ID
    );

    // Initialize OkuDollar vault
    await vaultProgram.methods
      .initialize(
        vaultPauser.publicKey,
        vaultUnpauser.publicKey,
        usdRebaser.publicKey,
        reserveManager.publicKey,
        DEFAULT_MIN_COLLATERAL_RATIO
      )
      .accountsPartial({
        roleAdmin: payer.publicKey,
        config: vaultConfigPda,
        okuMoneyMint,
        usdOkuMint,
        reserveVault,
        psmConfig: psmConfigPda,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    // Derive recipient ATAs
    recipientOkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    recipientUsdOkuAta = getAssociatedTokenAddressSync(
      usdOkuMint,
      recipient.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    // Create dead shares ATA (needed for first usdOku deposit).
    // Owner is System Program — tokens sent here are permanently locked.
    await ensureAtaViaBankrun(
      h,
      SystemProgram.programId,
      usdOkuMint,
      TOKEN_2022_PROGRAM_ID
    );
  });

  // ==========================================================================
  // set_direct_minter_allowance
  // ==========================================================================

  describe("set_direct_minter_allowance", () => {
    it("sets the allowance correctly", async () => {
      const config = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      expect(config.directMinterAllowance.toString()).to.equal(
        DIRECT_MINTER_ALLOWANCE.toString()
      );
    });

    it("overwrites the allowance on subsequent calls", async () => {
      const newAllowance = new BN(99_000_000);
      await psmProgram.methods
        .setDirectMinterAllowance(newAllowance)
        .accountsPartial({
          allowanceManager: coldMultisig.publicKey,
          config: psmConfigPda,
        })
        .signers([coldMultisig])
        .rpc();

      const config = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      expect(config.directMinterAllowance.toString()).to.equal(
        newAllowance.toString()
      );

      // Restore original allowance
      await psmProgram.methods
        .setDirectMinterAllowance(DIRECT_MINTER_ALLOWANCE)
        .accountsPartial({
          allowanceManager: coldMultisig.publicKey,
          config: psmConfigPda,
        })
        .signers([coldMultisig])
        .rpc();
    });

    it("rejects non-allowanceManager signer", async () => {
      await expectBankrunError(
        () =>
          psmProgram.methods
            .setDirectMinterAllowance(new BN(1))
            .accountsPartial({
              allowanceManager: directMinter.publicKey,
              config: psmConfigPda,
            })
            .signers([directMinter])
            .rpc(),
        "Unauthorized"
      );
    });
  });

  // ==========================================================================
  // mint_oku_m_direct
  // ==========================================================================

  describe("mint_oku_m_direct", () => {
    const MINT_AMOUNT = new BN(5_000_000); // 5 OkuMoney

    it("mints OkuMoney to recipient without USDC", async () => {
      const configBefore = await psmProgram.account.psmConfig.fetch(
        psmConfigPda
      );
      const allowanceBefore = configBefore.directMinterAllowance;

      await psmProgram.methods
        .mintOkuMDirect(MINT_AMOUNT)
        .accountsPartial({
          directMinter: directMinter.publicKey,
          config: psmConfigPda,
          okuMoneyMint,
          recipient: recipient.publicKey,
          recipientOkuMoneyAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([directMinter])
        .rpc();

      // Verify recipient received OkuMoney
      const recipientAccount = await getAccount(
        h.provider.connection,
        recipientOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(recipientAccount.amount)).to.be.gte(MINT_AMOUNT.toNumber());

      // Verify allowance was decremented
      const configAfter = await psmProgram.account.psmConfig.fetch(
        psmConfigPda
      );
      expect(configAfter.directMinterAllowance.toString()).to.equal(
        allowanceBefore.sub(MINT_AMOUNT).toString()
      );
    });

    it("rejects zero amount", async () => {
      await expectBankrunError(
        () =>
          psmProgram.methods
            .mintOkuMDirect(new BN(0))
            .accountsPartial({
              directMinter: directMinter.publicKey,
              config: psmConfigPda,
              okuMoneyMint,
              recipient: recipient.publicKey,
              recipientOkuMoneyAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([directMinter])
            .rpc(),
        "ZeroAmount"
      );
    });

    it("rejects when paused", async () => {
      // Pause
      const { warmMultisig } = await import("../shared/setup");
      await psmProgram.methods
        .pause()
        .accountsPartial({
          pauser: warmMultisig.publicKey,
          config: psmConfigPda,
        })
        .signers([warmMultisig])
        .rpc();

      await expectBankrunError(
        () =>
          psmProgram.methods
            .mintOkuMDirect(MINT_AMOUNT)
            .accountsPartial({
              directMinter: directMinter.publicKey,
              config: psmConfigPda,
              okuMoneyMint,
              recipient: recipient.publicKey,
              recipientOkuMoneyAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([directMinter])
            .rpc(),
        "Paused"
      );

      // Unpause
      await psmProgram.methods
        .unpause()
        .accountsPartial({
          unpauser: coldMultisig.publicKey,
          config: psmConfigPda,
        })
        .signers([coldMultisig])
        .rpc();
    });

    it("rejects exceeding allowance", async () => {
      // Set a small allowance
      await psmProgram.methods
        .setDirectMinterAllowance(new BN(1))
        .accountsPartial({
          allowanceManager: coldMultisig.publicKey,
          config: psmConfigPda,
        })
        .signers([coldMultisig])
        .rpc();

      await expectBankrunError(
        () =>
          psmProgram.methods
            .mintOkuMDirect(MINT_AMOUNT)
            .accountsPartial({
              directMinter: directMinter.publicKey,
              config: psmConfigPda,
              okuMoneyMint,
              recipient: recipient.publicKey,
              recipientOkuMoneyAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([directMinter])
            .rpc(),
        "AllowanceExceeded"
      );

      // Restore allowance
      await psmProgram.methods
        .setDirectMinterAllowance(DIRECT_MINTER_ALLOWANCE)
        .accountsPartial({
          allowanceManager: coldMultisig.publicKey,
          config: psmConfigPda,
        })
        .signers([coldMultisig])
        .rpc();
    });

    it("rejects wrong signer (not direct_minter)", async () => {
      const imposter = Keypair.generate();
      await fundKeypairs(h, [imposter], 2 * anchor.web3.LAMPORTS_PER_SOL);

      await expectBankrunError(
        () =>
          psmProgram.methods
            .mintOkuMDirect(MINT_AMOUNT)
            .accountsPartial({
              directMinter: imposter.publicKey,
              config: psmConfigPda,
              okuMoneyMint,
              recipient: recipient.publicKey,
              recipientOkuMoneyAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([imposter])
            .rpc(),
        // has_one constraint violation
        "Unauthorized"
      );
    });
  });

  // ==========================================================================
  // wrap_to (oku-dollar)
  // ==========================================================================

  describe("wrap_to", () => {
    it("wraps OkuMoney with a separate receiver", async () => {
      // First mint some OkuMoney to directMinter via USDC path
      const wrapUser = Keypair.generate();
      const wrapReceiver = Keypair.generate();
      await fundKeypairs(
        h,
        [wrapUser, wrapReceiver],
        5 * anchor.web3.LAMPORTS_PER_SOL
      );

      // Give wrapUser some OkuMoney via direct mint
      const wrapUserOkuMoneyAta = getAssociatedTokenAddressSync(
        okuMoneyMint,
        wrapUser.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      const wrapAmount = new BN(10_000_000); // 10 OkuMoney

      await psmProgram.methods
        .mintOkuMDirect(wrapAmount)
        .accountsPartial({
          directMinter: directMinter.publicKey,
          config: psmConfigPda,
          okuMoneyMint,
          recipient: wrapUser.publicKey,
          recipientOkuMoneyAta: wrapUserOkuMoneyAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([directMinter])
        .rpc();

      // Now wrap_to: wrapUser wraps OkuMoney, wrapReceiver gets usdOku
      const receiverUsdOkuAta = getAssociatedTokenAddressSync(
        usdOkuMint,
        wrapReceiver.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      // Check if this is the first deposit (total_supply == 0).
      // If so, we need to pass the dead_shares_ata.
      const { unpackMint } = await import("@solana/spl-token");
      const mintAcct = await h.provider.connection.getAccountInfo(usdOkuMint);
      const mintInfo = unpackMint(usdOkuMint, mintAcct, TOKEN_2022_PROGRAM_ID);
      const isFirstDeposit = mintInfo.supply === BigInt(0);

      await vaultProgram.methods
        .wrapTo(wrapAmount, new BN(0))
        .accountsPartial({
          payer: wrapUser.publicKey,
          caller: wrapUser.publicKey,
          receiver: wrapReceiver.publicKey,
          config: vaultConfigPda,
          okuMoneyMint,
          usdOkuMint,
          callerOkuMoneyAta: wrapUserOkuMoneyAta,
          receiverUsdOkuAta: receiverUsdOkuAta,
          reserveVault,
          psmConfig: psmConfigPda,
          deadSharesAta: isFirstDeposit ? deadSharesAta : null,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([wrapUser])
        .rpc();

      // Verify receiver got usdOku shares
      const receiverAccount = await getAccount(
        h.provider.connection,
        receiverUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(receiverAccount.amount)).to.be.gt(0);

      // Verify wrapUser's OkuMoney was consumed
      const userOkuMoneyAfter = await getAccount(
        h.provider.connection,
        wrapUserOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(userOkuMoneyAfter.amount)).to.equal(0);
    });
  });

  // ==========================================================================
  // mint_usd_oku_direct
  // ==========================================================================

  describe("mint_usd_oku_direct", () => {
    const MINT_WRAP_AMOUNT = new BN(5_000_000); // 5 OkuMoney -> usdOku

    it("mints OkuMoney and wraps into usdOku in a single instruction", async () => {
      const mintRecipient = Keypair.generate();
      await fundKeypairs(h, [mintRecipient], 2 * anchor.web3.LAMPORTS_PER_SOL);

      const mintRecipientUsdOkuAta = getAssociatedTokenAddressSync(
        usdOkuMint,
        mintRecipient.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      // Record vault_oku_money balance before (should be 0 for queue)
      const vaultOkuMoneyBefore = await getAccount(
        h.provider.connection,
        vaultOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const vaultBalanceBefore = Number(vaultOkuMoneyBefore.amount);

      await psmProgram.methods
        .mintUsdOkuDirect(MINT_WRAP_AMOUNT, new BN(0))
        .accountsPartial({
          directMinter: directMinter.publicKey,
          config: psmConfigPda,
          okuMoneyMint,
          vaultOkuMoney: vaultOkuMoneyAta,
          recipient: mintRecipient.publicKey,
          okuDollarConfig: vaultConfigPda,
          usdOkuMint,
          recipientUsdOkuAta: mintRecipientUsdOkuAta,
          okuDollarReserveVault: reserveVault,
          deadSharesAta: null,
          okuDollarProgram: vaultProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([directMinter])
        .rpc();

      // Verify recipient got usdOku shares
      const recipientUsdOku = await getAccount(
        h.provider.connection,
        mintRecipientUsdOkuAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(recipientUsdOku.amount)).to.be.gt(0);

      // Verify vault_oku_money balance is unchanged (net zero: minted then transferred out)
      const vaultOkuMoneyAfter = await getAccount(
        h.provider.connection,
        vaultOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(vaultOkuMoneyAfter.amount)).to.equal(vaultBalanceBefore);

      // Verify OkuMoney is in the oku-dollar reserve vault
      const reserveVaultAccount = await getAccount(
        h.provider.connection,
        reserveVault,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(reserveVaultAccount.amount)).to.be.gte(
        MINT_WRAP_AMOUNT.toNumber()
      );
    });

    it("rejects when paused", async () => {
      const { warmMultisig } = await import("../shared/setup");
      await psmProgram.methods
        .pause()
        .accountsPartial({
          pauser: warmMultisig.publicKey,
          config: psmConfigPda,
        })
        .signers([warmMultisig])
        .rpc();

      const tempRecipient = Keypair.generate();
      await fundKeypairs(h, [tempRecipient], 2 * anchor.web3.LAMPORTS_PER_SOL);
      const tempUsdOkuAta = getAssociatedTokenAddressSync(
        usdOkuMint,
        tempRecipient.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );

      await expectBankrunError(
        () =>
          psmProgram.methods
            .mintUsdOkuDirect(MINT_WRAP_AMOUNT, new BN(0))
            .accountsPartial({
              directMinter: directMinter.publicKey,
              config: psmConfigPda,
              okuMoneyMint,
              vaultOkuMoney: vaultOkuMoneyAta,
              recipient: tempRecipient.publicKey,
              okuDollarConfig: vaultConfigPda,
              usdOkuMint,
              recipientUsdOkuAta: tempUsdOkuAta,
              okuDollarReserveVault: reserveVault,
              deadSharesAta: null,
              okuDollarProgram: vaultProgram.programId,
              token2022Program: TOKEN_2022_PROGRAM_ID,
              associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            })
            .signers([directMinter])
            .rpc(),
        "Paused"
      );

      // Unpause
      await psmProgram.methods
        .unpause()
        .accountsPartial({
          unpauser: coldMultisig.publicKey,
          config: psmConfigPda,
        })
        .signers([coldMultisig])
        .rpc();
    });
  });
});
