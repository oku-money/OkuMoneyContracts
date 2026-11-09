/**
 * Pins how Token-2022 account freezing interacts with delegates (SVM counterpart of
 * Cyfrin audit finding #5, which is about the EVM blacklist). No program change: this
 * is SPL behaviour, documented in SVM/README.md. Against the real Token-2022 program:
 *   - freezing a DELEGATE's own token account does not stop it spending a delegation
 *     held on a clean grantor's account (freeze is per token account);
 *   - a FROZEN grantor account can neither `revoke` nor `approve`, and the delegation
 *     is live again after thaw (SPL's analogue of the EVM revive-on-unblacklist);
 *   - a frozen grantor account blocks the delegate's spend while frozen.
 */
import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
  createApproveInstruction,
  createRevokeInstruction,
  createTransferCheckedInstruction,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import {
  coldMultisig,
  warmMultisig,
  initializePsm,
  DECIMALS,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  tryProcess,
} from "../shared/bankrun";

const { Keypair, SystemProgram } = anchor.web3;

describe("account freeze vs delegates (Token-2022)", () => {
  let h: BankrunHarness;
  let program: Program<LitePsm>;
  const grantor = Keypair.generate();
  const delegate = Keypair.generate();
  const third = Keypair.generate();
  const usdcMintKeypair = Keypair.generate();

  let configPda: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let okuMMint: anchor.web3.PublicKey;
  let vaultUsdcAta: anchor.web3.PublicKey;
  let grantorUsdcAta: anchor.web3.PublicKey;
  const ata = (owner: anchor.web3.PublicKey) =>
    getAssociatedTokenAddressSync(okuMMint, owner, false, TOKEN_2022_PROGRAM_ID);

  const ALLOWANCE = 1_000_000_000n;
  const DELEGATED = 50_000_000n;

  before(async () => {
    h = await startBankrun();
    program = h.program;
    usdcMint = await createMintViaBankrun(h, h.payer.publicKey, null, DECIMALS, usdcMintKeypair, TOKEN_PROGRAM_ID);
    await fundKeypairs(h, [grantor, delegate, third], 10 * anchor.web3.LAMPORTS_PER_SOL);

    const setup = await initializePsm(h, program, h.payer, usdcMint, new BN(ALLOWANCE.toString()));
    configPda = setup.configPda;
    okuMMint = setup.okuMMint;
    vaultUsdcAta = setup.vaultUsdcAta;

    grantorUsdcAta = getAssociatedTokenAddressSync(usdcMint, grantor.publicKey, false, TOKEN_PROGRAM_ID);
    await ensureAtaViaBankrun(h, grantor.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, grantorUsdcAta, h.payer, 1_000_000_000, TOKEN_PROGRAM_ID);
    for (const k of [grantor, delegate, third]) {
      await ensureAtaViaBankrun(h, k.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);
    }

    // The grantor holds OkuM, minted through the PSM.
    await program.methods
      .mintOkuM(new BN(100_000_000))
      .accountsPartial({
        user: grantor.publicKey,
        config: configPda,
        usdcMint,
        okuMMint,
        userUsdcAta: grantorUsdcAta,
        userOkuMAta: ata(grantor.publicKey),
        vaultUsdc: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([grantor])
      .rpc();
  });

  const freeze = (owner: anchor.web3.PublicKey) =>
    program.methods
      .freezeAccount()
      .accountsPartial({
        freezer: warmMultisig.publicKey,
        config: configPda,
        okuMMint,
        targetOkuMAta: ata(owner),
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([warmMultisig])
      .rpc();
  const thaw = (owner: anchor.web3.PublicKey) =>
    program.methods
      .thawAccount()
      .accountsPartial({
        unfreezer: coldMultisig.publicKey,
        config: configPda,
        okuMMint,
        targetOkuMAta: ata(owner),
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([coldMultisig])
      .rpc();

  const approve = (amount: bigint) =>
    tryProcess(
      h,
      [createApproveInstruction(ata(grantor.publicKey), delegate.publicKey, grantor.publicKey, amount, [], TOKEN_2022_PROGRAM_ID)],
      [grantor]
    );
  const revoke = () =>
    tryProcess(
      h,
      [createRevokeInstruction(ata(grantor.publicKey), grantor.publicKey, [], TOKEN_2022_PROGRAM_ID)],
      [grantor]
    );
  /** The delegate moves the grantor's OkuM to `third`. */
  const delegateSpend = (amount: bigint) =>
    tryProcess(
      h,
      [
        createTransferCheckedInstruction(
          ata(grantor.publicKey),
          okuMMint,
          ata(third.publicKey),
          delegate.publicKey,
          amount,
          DECIMALS,
          [],
          TOKEN_2022_PROGRAM_ID
        ),
      ],
      [delegate]
    );
  /** Token-2022 `AccountFrozen` (TokenError 17). */
  const FROZEN = "0x11";
  const delegation = async () => {
    const a = await getAccount(h.provider.connection, ata(grantor.publicKey), undefined, TOKEN_2022_PROGRAM_ID);
    return { delegate: a.delegate?.toBase58() ?? null, amount: a.delegatedAmount, frozen: a.isFrozen };
  };

  it("grantor delegates to D", async () => {
    const res = await approve(DELEGATED);
    expect(res.result, "approve").to.equal(null);
    expect(await delegation()).to.deep.include({ delegate: delegate.publicKey.toBase58(), amount: DELEGATED });
  });

  it("freezing the DELEGATE's own account does not stop it spending the delegation", async () => {
    await freeze(delegate.publicKey);
    const dAcct = await getAccount(h.provider.connection, ata(delegate.publicKey), undefined, TOKEN_2022_PROGRAM_ID);
    expect(dAcct.isFrozen).to.equal(true);

    const res = await delegateSpend(1_000_000n);
    expect(res.result, "delegate spend from a clean grantor account").to.equal(null);
    const got = await getAccount(h.provider.connection, ata(third.publicKey), undefined, TOKEN_2022_PROGRAM_ID);
    expect(got.amount > 0n).to.equal(true);

    await thaw(delegate.publicKey);
  });

  it("a FROZEN grantor account cannot revoke or approve, and the delegate cannot spend from it", async () => {
    await freeze(grantor.publicKey);
    expect((await revoke()).result, "revoke while frozen").to.contain(FROZEN);
    expect((await approve(0n)).result, "approve(0) while frozen").to.contain(FROZEN);
    expect((await delegateSpend(1_000_000n)).result, "spend from a frozen account").to.contain(FROZEN);
    expect((await delegation()).delegate, "delegation survives the freeze").to.equal(delegate.publicKey.toBase58());
  });

  it("after thaw the old delegation is live again; the grantor can then revoke it", async () => {
    await thaw(grantor.publicKey);
    expect((await delegation()).frozen).to.equal(false);

    expect((await delegateSpend(1_000_000n)).result, "revived delegation").to.equal(null);

    expect((await revoke()).result, "revoke after thaw").to.equal(null);
    expect((await delegateSpend(1_000_000n)).result, "spend after revoke").to.not.equal(null);
  });
});
