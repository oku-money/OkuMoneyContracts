/**
 * Direct-Mint Integration Tests
 *
 * Tests the permissioned usdOku mint path that does NOT require USDC
 * collateral on-chain. Matches EVM's `UsdOku.mint(to, amount)` called
 * by a non-PSM `OKUM_MINTER` role holder.
 *
 * Covers:
 *   - `mint_usd_oku_direct` — permissioned direct usdOku mint to recipient
 *   - `set_direct_minter_allowance` — admin allowance management
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
  initializePsm,
  DECIMALS,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  expectBankrunError,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

describe("direct-mint", () => {
  let h: BankrunHarness;
  let psmProgram: Program<LitePsm>;
  let payer: Keypair;

  // Authorities
  const directMinter = Keypair.generate();
  const recipient = Keypair.generate();

  // Mints
  let usdOkuMint: PublicKey;
  let usdcMint: PublicKey;

  // PDAs
  let psmConfigPda: PublicKey;

  // ATAs
  let recipientUsdOkuAta: PublicKey;

  const DIRECT_MINTER_ALLOWANCE = new BN(50_000_000_000); // 50k with 6 decimals

  before(async () => {
    h = await startBankrun();
    payer = h.payer;
    psmProgram = h.program;

    // Create USDC mint
    const usdcMintKeypair = Keypair.generate();
    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      payer.publicKey,
      DECIMALS,
      usdcMintKeypair,
      TOKEN_PROGRAM_ID
    );

    // Initialize PSM (creates usdOku mint internally)
    const psmSetup = await initializePsm(h, psmProgram, payer, usdcMint);
    psmConfigPda = psmSetup.configPda;
    usdOkuMint = psmSetup.usdOkuMint;

    // Fund keypairs
    await fundKeypairs(
      h,
      [directMinter, recipient],
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

    // Derive recipient ATA
    recipientUsdOkuAta = getAssociatedTokenAddressSync(
      usdOkuMint,
      recipient.publicKey,
      false,
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
  // mint_usd_oku_direct
  // ==========================================================================

  describe("mint_usd_oku_direct", () => {
    const MINT_AMOUNT = new BN(5_000_000); // 5 usdOku

    it("mints usdOku to recipient without USDC", async () => {
      const configBefore = await psmProgram.account.psmConfig.fetch(
        psmConfigPda
      );
      const allowanceBefore = configBefore.directMinterAllowance;

      await psmProgram.methods
        .mintUsdOkuDirect(MINT_AMOUNT)
        .accountsPartial({
          directMinter: directMinter.publicKey,
          config: psmConfigPda,
          usdOkuMint,
          recipient: recipient.publicKey,
          recipientUsdOkuAta,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([directMinter])
        .rpc();

      // Verify recipient received usdOku
      const recipientAccount = await getAccount(
        h.provider.connection,
        recipientUsdOkuAta,
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
            .mintUsdOkuDirect(new BN(0))
            .accountsPartial({
              directMinter: directMinter.publicKey,
              config: psmConfigPda,
              usdOkuMint,
              recipient: recipient.publicKey,
              recipientUsdOkuAta,
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
            .mintUsdOkuDirect(MINT_AMOUNT)
            .accountsPartial({
              directMinter: directMinter.publicKey,
              config: psmConfigPda,
              usdOkuMint,
              recipient: recipient.publicKey,
              recipientUsdOkuAta,
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
            .mintUsdOkuDirect(MINT_AMOUNT)
            .accountsPartial({
              directMinter: directMinter.publicKey,
              config: psmConfigPda,
              usdOkuMint,
              recipient: recipient.publicKey,
              recipientUsdOkuAta,
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
            .mintUsdOkuDirect(MINT_AMOUNT)
            .accountsPartial({
              directMinter: imposter.publicKey,
              config: psmConfigPda,
              usdOkuMint,
              recipient: recipient.publicKey,
              recipientUsdOkuAta,
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
});
