/**
 * Phase 10 / Cycle 4: PSM init-time mint-extension invariant test.
 *
 * `initialize` enforces a Token-2022 extension allow-list on the
 * OkuMoney mint (see `programs/lite-psm/src/helpers/mint_extensions.rs`).
 * Cycle 4 widened the original TransferHook-only check into a positive
 * allow-list; the production deploy uses InterestBearingConfig only,
 * which is allowed. This test fires a TransferHook-bearing mint at
 * `initialize` and expects the `IncompatibleMintExtension` error.
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
import { Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import { startBankrun, BankrunHarness, createMintViaBankrun } from "../shared/bankrun";


describe("init invariants (Token-2022 extension whitelist)", () => {
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
      [Buffer.from("psm_config_v3")],
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

    // Now attempt initialize — the allow-list invariant must reject the
    // TransferHook extension with IncompatibleMintExtension.
    const vaultUsdc = getAssociatedTokenAddressSync(
      usdcMint,
      configPda,
      true,
      TOKEN_PROGRAM_ID
    );
    const PYTH_LEGACY = new PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");

    let threw = false;
    try {
      // Cycle 4 (PSM-17): `initialize` now takes a single
      // `InitializeParams` struct in place of the prior positional
      // pubkey args.
      await program.methods
        .initialize({
          maxSupply: new BN(1_000_000_000),
          minterAllowance: new BN(1_000_000_000),
          pauser: payer.publicKey,
          unpauser: payer.publicKey,
          freezer: payer.publicKey,
          unfreezer: payer.publicKey,
          queueProcessor: payer.publicKey,
          bufferDepositor: payer.publicKey,
          bufferWithdrawer: payer.publicKey,
          oracleManager: payer.publicKey,
          capManager: payer.publicKey,
          allowanceManager: payer.publicKey,
          rebaser: payer.publicKey,
          oracleRelayPythProgramOwner: PYTH_LEGACY,
        })
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
        })
        .rpc();
    } catch (err: any) {
      threw = true;
      const haystack = [
        String(err?.error?.errorCode?.code ?? ""),
        String(err?.message ?? ""),
        ...(err?.logs ?? []),
      ].join(" ");
      // Cycle 4: the allow-list check returns IncompatibleMintExtension
      // for any non-whitelisted extension (TransferHook included). The
      // legacy TransferHookNotAllowed error variant was removed as dead
      // code in the audit-prep cleanup pass.
      expect(haystack).to.include("IncompatibleMintExtension");
    }
    expect(threw, "initialize must reject a mint with TransferHook").to.equal(true);
  });
});
