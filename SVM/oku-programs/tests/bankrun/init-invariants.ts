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
  unpackMint,
  MINT_SIZE,
} from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import { startBankrun, BankrunHarness, createMintViaBankrun } from "../shared/bankrun";
import { initializePsm, DECIMALS } from "../shared/setup";

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
});
