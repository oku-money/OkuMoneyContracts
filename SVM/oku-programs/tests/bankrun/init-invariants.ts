/**
 * Phase 10: PSM init-time invariant tests.
 *
 * `initialize` enforces a no-TransferHook invariant on the OkuMoney mint
 * (see `programs/lite-psm/src/instructions/init.rs`). The legacy
 * production deploy creates the mint with `InterestBearingConfig` only,
 * which is fine. But a misconfigured deploy that adds `TransferHook`
 * would silently break the PSM's re-entrancy assumptions; this test
 * proves the program now refuses such mints at init.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  ExtensionType,
  getMintLen,
  createInitializeMintInstruction,
  createInitializeTransferHookInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram, Transaction, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import { startBankrun, BankrunHarness, createMintViaBankrun } from "../shared/bankrun";


describe("init invariants (TransferHook reject)", () => {
  let h: BankrunHarness;
  let program: Program<LitePsm>;
  let payer: Keypair;

  before(async () => {
    h = await startBankrun();
    program = h.program;
    payer = h.payer;
  });

  it("initialize rejects an OkuMoney mint that has the TransferHook extension", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("psm_config")],
      program.programId
    );

    // Standard USDC mint — fine.
    const usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      6,
      Keypair.generate(),
      TOKEN_PROGRAM_ID
    );

    // OkuMoney mint WITH TransferHook + standard init. We must include the
    // hook-config init instruction BEFORE the `InitializeMint` to satisfy
    // Token-2022's ordering rules. Pass an arbitrary placeholder pubkey as
    // the hook program — the lite-psm init must reject regardless.
    const okuMoneyKp = Keypair.generate();
    const hookProgramId = Keypair.generate().publicKey;
    const space = getMintLen([ExtensionType.TransferHook]);
    const rent = await h.context.banksClient.getRent();
    const lamports = rent.minimumBalance(BigInt(space));

    const tx = new Transaction();
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: okuMoneyKp.publicKey,
        space,
        lamports: Number(lamports),
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeTransferHookInstruction(
        okuMoneyKp.publicKey,
        payer.publicKey,
        hookProgramId,
        TOKEN_2022_PROGRAM_ID
      ),
      createInitializeMintInstruction(
        okuMoneyKp.publicKey,
        6,
        configPda,
        configPda,
        TOKEN_2022_PROGRAM_ID
      )
    );
    await h.provider.sendAndConfirm!(tx, [okuMoneyKp]);

    // Now attempt initialize — the new invariant must reject with
    // TransferHookNotAllowed.
    const vaultUsdc = getAssociatedTokenAddressSync(
      usdcMint,
      configPda,
      true,
      TOKEN_PROGRAM_ID
    );
    const PYTH_LEGACY = new PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");

    let threw = false;
    try {
      await program.methods
        .initialize(
          new BN(1_000_000_000),
          new BN(1_000_000_000),
          payer.publicKey,
          payer.publicKey,
          payer.publicKey,
          payer.publicKey,
          payer.publicKey,
          payer.publicKey,
          payer.publicKey,
          payer.publicKey,
          payer.publicKey,
          payer.publicKey,
          payer.publicKey,
          PYTH_LEGACY
        )
        .accountsPartial({
          roleAdmin: payer.publicKey,
          config: configPda,
          usdcMint,
          okuMoneyMint: okuMoneyKp.publicKey,
          vaultUsdc,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .rpc();
    } catch (err: any) {
      threw = true;
      const haystack = [
        String(err?.error?.errorCode?.code ?? ""),
        String(err?.message ?? ""),
        ...(err?.logs ?? []),
      ].join(" ");
      expect(haystack).to.include("TransferHookNotAllowed");
    }
    expect(threw, "initialize must reject a mint with TransferHook").to.equal(true);
  });
});
