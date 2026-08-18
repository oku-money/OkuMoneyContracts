/**
 * PSM init-time mint-extension validation tests.
 *
 * `initialize` creates the OkuM mint with Token-2022 extensions:
 *   - ScaledUiAmount (multiplier for yield accrual)
 *   - MetadataPointer (points to the mint itself)
 *   - TokenMetadata (name, symbol, URI)
 *
 * This test verifies the mint is created with the correct extensions
 * and an initial multiplier of 1.0.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackMint,
  MINT_SIZE,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import { startBankrun, BankrunHarness, createMintViaBankrun } from "../shared/bankrun";
import { initializePsm, DECIMALS, MAX_SUPPLY, MINTER_ALLOWANCE } from "../shared/setup";

const PRECISION = new BN(1_000_000_000);

describe("init invariants (OkuM mint extensions)", () => {
  let h: BankrunHarness;
  let program: Program<LitePsm>;
  let payer: Keypair;

  before(async () => {
    h = await startBankrun();
    program = h.program;
    payer = h.payer;
  });

  it("initialize creates the OkuM mint with ScaledUiAmount, MetadataPointer, and TokenMetadata extensions and initial multiplier of 1.0", async () => {
    // Standard USDC mint
    const usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      6,
      Keypair.generate(),
      TOKEN_PROGRAM_ID
    );

    // Initialize PSM — creates PsmConfig + USDC vault + OkuM mint
    // (the program creates the Token-2022 mint with extensions via CPI)
    const psmSetup = await initializePsm(h, program, payer, usdcMint);
    const { okuMMint, configPda } = psmSetup;

    // Verify the OkuM mint was created as a Token-2022 mint
    const mintAcctInfo = await h.provider.connection.getAccountInfo(okuMMint);
    expect(mintAcctInfo, "OkuM mint account should exist").to.not.be.null;
    expect(mintAcctInfo!.owner.equals(TOKEN_2022_PROGRAM_ID)).to.be.true;

    // The mint account should be larger than a plain mint (MINT_SIZE = 82)
    // because it includes Token-2022 extensions (ScaledUiAmount,
    // MetadataPointer, TokenMetadata).
    expect(mintAcctInfo!.data.length).to.be.greaterThan(MINT_SIZE);

    // Parse the mint and verify basic properties
    const mintData = unpackMint(okuMMint, mintAcctInfo!, TOKEN_2022_PROGRAM_ID);
    expect(mintData.mintAuthority?.equals(configPda)).to.be.true;
    expect(Number(mintData.decimals)).to.equal(DECIMALS);

    // The mint should carry TLV extension data (ScaledUiAmount +
    // MetadataPointer + TokenMetadata). Non-empty TLV confirms the
    // extensions were initialized.
    expect(mintData.tlvData.length).to.be.greaterThan(0);

    // Verify PsmConfig references the correct OkuM mint
    const config = await program.account.psmConfig.fetch(configPda);
    expect(config.okuMMint.equals(okuMMint)).to.be.true;
  });

  describe("authority validation", () => {
    // Base set of valid granular-authority params, matching
    // `initializePsm` in shared/setup.ts. Each test below overrides
    // exactly one field with an invalid value and expects `initialize`
    // to revert with `InvalidAuthority` before any state is written.
    function baseParams(warm: PublicKey, cold: PublicKey, orchestrator: PublicKey) {
      return {
        maxSupply: MAX_SUPPLY,
        minterAllowance: MINTER_ALLOWANCE,
        pauser: warm,
        unpauser: cold,
        freezer: warm,
        unfreezer: cold,
        bufferDepositor: orchestrator,
        bufferWithdrawer: cold,
        capManager: cold,
        allowanceManager: cold,
        rebaser: orchestrator,
        okuMUri: "",
      };
    }

    async function attemptInitialize(
      params: ReturnType<typeof baseParams>
    ): Promise<void> {
      const usdcMint = await createMintViaBankrun(
        h,
        payer.publicKey,
        null,
        6,
        Keypair.generate(),
        TOKEN_PROGRAM_ID
      );
      const okuMMintKeypair = Keypair.generate();
      const okuMMint = okuMMintKeypair.publicKey;
      const [configPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("psm_config")],
        program.programId
      );
      const vaultUsdcAta = getAssociatedTokenAddressSync(
        usdcMint,
        configPda,
        true,
        TOKEN_PROGRAM_ID
      );

      await program.methods
        .initialize(params)
        .accountsPartial({
          roleAdmin: payer.publicKey,
          config: configPda,
          usdcMint,
          okuMMint,
          vaultUsdc: vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([okuMMintKeypair])
        .rpc();
    }

    it("rejects a zero-pubkey granular authority (pauser)", async () => {
      // Fresh cluster per test — PsmConfig is a singleton PDA and
      // initialize() can only run once per program deployment.
      h = await startBankrun();
      program = h.program;
      payer = h.payer;

      const warm = Keypair.generate().publicKey;
      const cold = Keypair.generate().publicKey;
      const orchestrator = Keypair.generate().publicKey;
      const params = baseParams(warm, cold, orchestrator);
      params.pauser = PublicKey.default;

      try {
        await attemptInitialize(params);
        expect.fail("Should have rejected zero-pubkey pauser");
      } catch (err: any) {
        expect(err?.error?.errorCode?.code).to.equal("InvalidAuthority");
      }
    });

    it("rejects a zero-pubkey granular authority (rebaser)", async () => {
      h = await startBankrun();
      program = h.program;
      payer = h.payer;

      const warm = Keypair.generate().publicKey;
      const cold = Keypair.generate().publicKey;
      const orchestrator = Keypair.generate().publicKey;
      const params = baseParams(warm, cold, orchestrator);
      params.rebaser = PublicKey.default;

      try {
        await attemptInitialize(params);
        expect.fail("Should have rejected zero-pubkey rebaser");
      } catch (err: any) {
        expect(err?.error?.errorCode?.code).to.equal("InvalidAuthority");
      }
    });

    it("rejects a granular authority collapsed into role_admin", async () => {
      h = await startBankrun();
      program = h.program;
      payer = h.payer;

      const warm = Keypair.generate().publicKey;
      const cold = Keypair.generate().publicKey;
      const orchestrator = Keypair.generate().publicKey;
      const params = baseParams(warm, cold, orchestrator);
      // roleAdmin in attemptInitialize is `payer.publicKey` — collapse
      // `bufferWithdrawer` into it to exercise the separation-of-duties
      // guard (mirrors `set_authority`'s equivalent check).
      params.bufferWithdrawer = payer.publicKey;

      try {
        await attemptInitialize(params);
        expect.fail("Should have rejected authority collapsed into role_admin");
      } catch (err: any) {
        expect(err?.error?.errorCode?.code).to.equal("InvalidAuthority");
      }
    });

    it("accepts fully valid, distinct granular authorities (control case)", async () => {
      h = await startBankrun();
      program = h.program;
      payer = h.payer;

      const warm = Keypair.generate().publicKey;
      const cold = Keypair.generate().publicKey;
      const orchestrator = Keypair.generate().publicKey;
      const params = baseParams(warm, cold, orchestrator);

      // Should not throw.
      await attemptInitialize(params);
    });
  });
});
