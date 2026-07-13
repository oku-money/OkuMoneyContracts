/**
 * Direct-Burn Integration Tests
 *
 * Tests the permissioned OkuMoney burn path that does NOT trigger a USDC
 * payout. Matches EVM's `OkuMoney.burn(amount)` called by a non-PSM
 * `OKUM_BURNER` role holder. Enables SVM->EVM bridging where the
 * KMS-backed orchestrator burns on the source chain.
 *
 * Covers:
 *   - `burn_oku_m_direct` — permissioned direct OkuM burn from burner's ATA
 *   - `set_direct_burner_allowance` — admin allowance management
 *   - `migrate_psm_config_v2` — PsmConfig realloc (594 -> 634 bytes)
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
import { LitePsm } from "../../target/types/lite_psm";
import {
  coldMultisig,
  warmMultisig,
  initializePsm,
  DECIMALS,
  mintOkuMoneyViaProgram,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  expectBankrunError,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

describe("direct-burn", () => {
  let h: BankrunHarness;
  let psmProgram: Program<LitePsm>;
  let payer: Keypair;

  // Authorities
  const directBurner = Keypair.generate();
  const directMinter = Keypair.generate();

  // Mints
  const okuMoneyMintKeypair = Keypair.generate();
  let okuMoneyMint: PublicKey;
  let usdcMint: PublicKey;

  // PDAs
  let psmConfigPda: PublicKey;

  // ATAs
  let burnerOkuMoneyAta: PublicKey;

  const DIRECT_BURNER_ALLOWANCE = new BN(50_000_000_000); // 50k with 6 decimals
  const DIRECT_MINTER_ALLOWANCE = new BN(50_000_000_000); // 50k with 6 decimals

  before(async () => {
    h = await startBankrun();
    payer = h.payer;
    psmProgram = h.program;

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
    await initializePsm(h, psmProgram, payer, usdcMint, okuMoneyMint);

    // Fund keypairs
    await fundKeypairs(
      h,
      [directBurner, directMinter],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    // Grant DirectBurner role
    await psmProgram.methods
      .setAuthority({ directBurner: {} }, directBurner.publicKey)
      .accountsPartial({
        roleAdmin: payer.publicKey,
        config: psmConfigPda,
      })
      .rpc();

    // Set direct burner allowance
    await psmProgram.methods
      .setDirectBurnerAllowance(DIRECT_BURNER_ALLOWANCE)
      .accountsPartial({
        allowanceManager: coldMultisig.publicKey,
        config: psmConfigPda,
      })
      .signers([coldMultisig])
      .rpc();

    // Grant DirectMinter role (to mint tokens that we'll burn)
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

    // Derive burner's OkuMoney ATA
    burnerOkuMoneyAta = getAssociatedTokenAddressSync(
      okuMoneyMint,
      directBurner.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    // Mint some OkuMoney to the burner so it has tokens to burn
    const mintAmount = new BN(30_000_000_000); // 30k OkuMoney
    await psmProgram.methods
      .mintOkuMDirect(mintAmount)
      .accountsPartial({
        directMinter: directMinter.publicKey,
        config: psmConfigPda,
        okuMoneyMint,
        recipient: directBurner.publicKey,
        recipientOkuMoneyAta: burnerOkuMoneyAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([directMinter])
      .rpc();
  });

  // ==========================================================================
  // set_direct_burner_allowance
  // ==========================================================================

  describe("set_direct_burner_allowance", () => {
    it("sets the allowance correctly", async () => {
      const config = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      expect(config.directBurnerAllowance.toString()).to.equal(
        DIRECT_BURNER_ALLOWANCE.toString()
      );
    });

    it("overwrites the allowance on subsequent calls", async () => {
      const newAllowance = new BN(99_000_000);
      await psmProgram.methods
        .setDirectBurnerAllowance(newAllowance)
        .accountsPartial({
          allowanceManager: coldMultisig.publicKey,
          config: psmConfigPda,
        })
        .signers([coldMultisig])
        .rpc();

      const config = await psmProgram.account.psmConfig.fetch(psmConfigPda);
      expect(config.directBurnerAllowance.toString()).to.equal(
        newAllowance.toString()
      );

      // Restore original allowance
      await psmProgram.methods
        .setDirectBurnerAllowance(DIRECT_BURNER_ALLOWANCE)
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
            .setDirectBurnerAllowance(new BN(1))
            .accountsPartial({
              allowanceManager: directBurner.publicKey,
              config: psmConfigPda,
            })
            .signers([directBurner])
            .rpc(),
        "Unauthorized"
      );
    });
  });

  // ==========================================================================
  // burn_oku_m_direct
  // ==========================================================================

  describe("burn_oku_m_direct", () => {
    const BURN_AMOUNT = new BN(5_000_000); // 5 OkuMoney

    it("burns OkuMoney from burner's ATA without USDC payout", async () => {
      // Record state before
      const configBefore = await psmProgram.account.psmConfig.fetch(
        psmConfigPda
      );
      const allowanceBefore = configBefore.directBurnerAllowance;
      const burnerAccountBefore = await getAccount(
        h.provider.connection,
        burnerOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      const balanceBefore = Number(burnerAccountBefore.amount);

      await psmProgram.methods
        .burnOkuMDirect(BURN_AMOUNT)
        .accountsPartial({
          directBurner: directBurner.publicKey,
          config: psmConfigPda,
          okuMoneyMint,
          burnerOkuMoneyAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([directBurner])
        .rpc();

      // Verify burner's balance decreased
      const burnerAccountAfter = await getAccount(
        h.provider.connection,
        burnerOkuMoneyAta,
        undefined,
        TOKEN_2022_PROGRAM_ID
      );
      expect(Number(burnerAccountAfter.amount)).to.equal(
        balanceBefore - BURN_AMOUNT.toNumber()
      );

      // Verify allowance was decremented
      const configAfter = await psmProgram.account.psmConfig.fetch(
        psmConfigPda
      );
      expect(configAfter.directBurnerAllowance.toString()).to.equal(
        allowanceBefore.sub(BURN_AMOUNT).toString()
      );
    });

    it("reduces total supply after burn", async () => {
      const { unpackMint } = await import("@solana/spl-token");

      // Get supply before
      const mintBefore = await h.provider.connection.getAccountInfo(
        okuMoneyMint
      );
      const supplyBefore = unpackMint(
        okuMoneyMint,
        mintBefore,
        TOKEN_2022_PROGRAM_ID
      ).supply;

      await psmProgram.methods
        .burnOkuMDirect(BURN_AMOUNT)
        .accountsPartial({
          directBurner: directBurner.publicKey,
          config: psmConfigPda,
          okuMoneyMint,
          burnerOkuMoneyAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([directBurner])
        .rpc();

      // Get supply after
      const mintAfter = await h.provider.connection.getAccountInfo(
        okuMoneyMint
      );
      const supplyAfter = unpackMint(
        okuMoneyMint,
        mintAfter,
        TOKEN_2022_PROGRAM_ID
      ).supply;

      expect(Number(supplyAfter)).to.equal(
        Number(supplyBefore) - BURN_AMOUNT.toNumber()
      );
    });

    it("rejects zero amount", async () => {
      await expectBankrunError(
        () =>
          psmProgram.methods
            .burnOkuMDirect(new BN(0))
            .accountsPartial({
              directBurner: directBurner.publicKey,
              config: psmConfigPda,
              okuMoneyMint,
              burnerOkuMoneyAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .signers([directBurner])
            .rpc(),
        "ZeroAmount"
      );
    });

    it("rejects when paused", async () => {
      // Pause
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
            .burnOkuMDirect(BURN_AMOUNT)
            .accountsPartial({
              directBurner: directBurner.publicKey,
              config: psmConfigPda,
              okuMoneyMint,
              burnerOkuMoneyAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .signers([directBurner])
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
        .setDirectBurnerAllowance(new BN(1))
        .accountsPartial({
          allowanceManager: coldMultisig.publicKey,
          config: psmConfigPda,
        })
        .signers([coldMultisig])
        .rpc();

      await expectBankrunError(
        () =>
          psmProgram.methods
            .burnOkuMDirect(BURN_AMOUNT)
            .accountsPartial({
              directBurner: directBurner.publicKey,
              config: psmConfigPda,
              okuMoneyMint,
              burnerOkuMoneyAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .signers([directBurner])
            .rpc(),
        "AllowanceExceeded"
      );

      // Restore allowance
      await psmProgram.methods
        .setDirectBurnerAllowance(DIRECT_BURNER_ALLOWANCE)
        .accountsPartial({
          allowanceManager: coldMultisig.publicKey,
          config: psmConfigPda,
        })
        .signers([coldMultisig])
        .rpc();
    });

    it("rejects wrong signer (not direct_burner)", async () => {
      const imposter = Keypair.generate();
      await fundKeypairs(h, [imposter], 5 * anchor.web3.LAMPORTS_PER_SOL);

      // Create and fund imposter's ATA so account validation passes
      const imposterAta = await ensureAtaViaBankrun(
        h,
        imposter.publicKey,
        okuMoneyMint,
        TOKEN_2022_PROGRAM_ID
      );

      await expectBankrunError(
        () =>
          psmProgram.methods
            .burnOkuMDirect(BURN_AMOUNT)
            .accountsPartial({
              directBurner: imposter.publicKey,
              config: psmConfigPda,
              okuMoneyMint,
              burnerOkuMoneyAta: imposterAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .signers([imposter])
            .rpc(),
        // has_one constraint violation
        "Unauthorized"
      );
    });

    it("rejects when burner has insufficient token balance", async () => {
      // Create a fresh burner who has no tokens but IS the authorized burner
      const poorBurner = Keypair.generate();
      await fundKeypairs(h, [poorBurner], 5 * anchor.web3.LAMPORTS_PER_SOL);

      // Set poor burner as the direct_burner role
      await psmProgram.methods
        .setAuthority({ directBurner: {} }, poorBurner.publicKey)
        .accountsPartial({
          roleAdmin: payer.publicKey,
          config: psmConfigPda,
        })
        .rpc();

      // Create an empty ATA for the poor burner
      const poorBurnerAta = await ensureAtaViaBankrun(
        h,
        poorBurner.publicKey,
        okuMoneyMint,
        TOKEN_2022_PROGRAM_ID
      );

      await expectBankrunError(
        () =>
          psmProgram.methods
            .burnOkuMDirect(BURN_AMOUNT)
            .accountsPartial({
              directBurner: poorBurner.publicKey,
              config: psmConfigPda,
              okuMoneyMint,
              burnerOkuMoneyAta: poorBurnerAta,
              token2022Program: TOKEN_2022_PROGRAM_ID,
            })
            .signers([poorBurner])
            .rpc(),
        // Token-2022 will reject the burn with insufficient funds
        "insufficient"
      );

      // Restore original burner
      await psmProgram.methods
        .setAuthority({ directBurner: {} }, directBurner.publicKey)
        .accountsPartial({
          roleAdmin: payer.publicKey,
          config: psmConfigPda,
        })
        .rpc();
    });
  });
});
