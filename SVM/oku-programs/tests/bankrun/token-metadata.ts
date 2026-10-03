/**
 * OkuM mint Token-2022 metadata identity tests.
 *
 * Verifies the on-chain `TokenMetadata` name/symbol reflect the TRUE
 * OkuM ("OkuMoney") identity — matching the EVM `OkuMoney` (OkuM) token —
 * and that `update_token_metadata` can rewrite them in place under the
 * correct authority.
 *
 * Design context: the name/symbol here are the on-chain identity wallets
 * and explorers display for the mint and its transfers. The "$1-pegged
 * usdOku" figure is a *separate* ScaledUiAmount display value and is NOT
 * the on-chain symbol (covered by scaled-ui-amount.ts).
 */

import * as anchor from "@anchor-lang/core";
import { Program } from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getTokenMetadata } from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import { initializePsm, DECIMALS } from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  createMintViaBankrun,
  fundKeypairs,
  expectBankrunError,
} from "../shared/bankrun";

const { Keypair } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

// Canonical on-chain identity — must match the program's single source of
// truth (OKU_M_METADATA_* in programs/lite-psm/src/constants.rs) and the
// EVM OkuMoney token (EVM/test/shared/Constants.sol).
const EXPECTED_NAME = "OkuMoney";
const EXPECTED_SYMBOL = "OkuM";

describe("OkuM Token-2022 metadata identity", () => {
  let h: BankrunHarness;
  let provider: anchor.AnchorProvider;
  let program: Program<LitePsm>;
  let payer: Keypair;

  let configPda: PublicKey;
  let okuMMint: PublicKey;

  beforeEach(async () => {
    h = await startBankrun();
    provider = h.provider as unknown as anchor.AnchorProvider;
    program = h.program;
    payer = h.payer;

    const usdcMintKeypair = Keypair.generate();
    const usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      DECIMALS,
      usdcMintKeypair,
      TOKEN_PROGRAM_ID
    );

    const psmSetup = await initializePsm(h, program, payer, usdcMint);
    configPda = psmSetup.configPda;
    okuMMint = psmSetup.okuMMint;
  });

  it("initialize sets on-chain metadata name/symbol to OkuMoney/OkuM", async () => {
    const md = await getTokenMetadata(
      provider.connection,
      okuMMint,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    expect(md, "metadata present on mint").to.not.be.null;
    expect(md!.name).to.equal(EXPECTED_NAME);
    expect(md!.symbol).to.equal(EXPECTED_SYMBOL);
    // Update authority is the config PDA (so it can CPI-sign rename).
    expect(md!.updateAuthority?.toString()).to.equal(configPda.toString());
  });

  it("update_token_metadata (role_admin) re-asserts OkuMoney/OkuM in place", async () => {
    // Even starting from the canonical values, the instruction must
    // succeed and leave the on-chain identity as OkuMoney/OkuM.
    await program.methods
      .updateTokenMetadata()
      .accountsPartial({
        roleAdmin: payer.publicKey, // role_admin per initializePsm
        config: configPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();

    const md = await getTokenMetadata(
      provider.connection,
      okuMMint,
      "confirmed",
      TOKEN_2022_PROGRAM_ID
    );
    expect(md!.name).to.equal(EXPECTED_NAME);
    expect(md!.symbol).to.equal(EXPECTED_SYMBOL);
  });

  it("update_token_metadata rejects a non-role_admin signer", async () => {
    // Funded, so the rejection can only be about authority -- an unfunded
    // fresh keypair could fail for fee/rent reasons and a bare catch would
    // have accepted that as a pass.
    const attacker = Keypair.generate();
    await fundKeypairs(h, [attacker], 10 * anchor.web3.LAMPORTS_PER_SOL);
    await expectBankrunError(
      () =>
        program.methods
          .updateTokenMetadata()
          .accountsPartial({
            roleAdmin: attacker.publicKey,
            config: configPda,
            okuMMint,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([attacker])
          .rpc(),
      "Unauthorized",
    );
  });
});
