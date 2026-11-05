/**
 * Regression for Cyfrin audit finding #1: permissionless fee-free
 * `mint_oku_m` / `redeem_oku_m` cycling must not drain the PSM's
 * `minter_allowance`. A redeem restores the allowance up to
 * `minter_allowance_limit` (set by `set_minter_allowance` / `initialize`), so
 * the allowance bounds net outstanding PSM issuance, not gross mint volume.
 */
import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getMint,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import { PRECISION } from "@okumoney/yield-tooling";
import { coldMultisig, initializePsm, DECIMALS, MINTER_ALLOWANCE } from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  computeCanonicalMultiplier,
  expectBankrunError,
} from "../shared/bankrun";

const { Keypair, SystemProgram } = anchor.web3;

describe("psm allowance cycling (audit #1)", () => {
  let h: BankrunHarness;
  let program: Program<LitePsm>;
  const attacker = Keypair.generate();
  const victim = Keypair.generate();
  const usdcMintKeypair = Keypair.generate();

  let configPda: anchor.web3.PublicKey;
  let usdcMint: anchor.web3.PublicKey;
  let okuMMint: anchor.web3.PublicKey;
  let vaultUsdcAta: anchor.web3.PublicKey;
  let attackerUsdcAta: anchor.web3.PublicKey;
  let attackerOkuMAta: anchor.web3.PublicKey;
  let victimUsdcAta: anchor.web3.PublicKey;
  let victimOkuMAta: anchor.web3.PublicKey;

  const capital = 10_000_000n;
  const cycles = 6n;
  let perCycle: bigint;

  before(async () => {
    h = await startBankrun();
    program = h.program;

    usdcMint = await createMintViaBankrun(
      h,
      h.payer.publicKey,
      null,
      DECIMALS,
      usdcMintKeypair,
      TOKEN_PROGRAM_ID
    );
    await fundKeypairs(h, [attacker, victim], 10 * anchor.web3.LAMPORTS_PER_SOL);

    const setup = await initializePsm(h, program, h.payer, usdcMint);
    configPda = setup.configPda;
    okuMMint = setup.okuMMint;
    vaultUsdcAta = setup.vaultUsdcAta;

    attackerUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      attacker.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    attackerOkuMAta = getAssociatedTokenAddressSync(
      okuMMint,
      attacker.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    victimUsdcAta = getAssociatedTokenAddressSync(
      usdcMint,
      victim.publicKey,
      false,
      TOKEN_PROGRAM_ID
    );
    victimOkuMAta = getAssociatedTokenAddressSync(
      okuMMint,
      victim.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );

    await ensureAtaViaBankrun(h, attacker.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await ensureAtaViaBankrun(h, victim.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, attackerUsdcAta, h.payer, 1_000_000_000, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, victimUsdcAta, h.payer, 1_000_000_000, TOKEN_PROGRAM_ID);

    const m = await computeCanonicalMultiplier(h, program, configPda);
    perCycle = (capital * PRECISION) / m;
  });

  const accountsFor = (
    user: anchor.web3.PublicKey,
    usdcAta: anchor.web3.PublicKey,
    okuMAta: anchor.web3.PublicKey
  ) => ({
    user,
    config: configPda,
    usdcMint,
    okuMMint,
    userUsdcAta: usdcAta,
    userOkuMAta: okuMAta,
    vaultUsdc: vaultUsdcAta,
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  const setAllowance = (amount: bigint) =>
    program.methods
      .setMinterAllowance(new BN(amount.toString()))
      .accountsPartial({ allowanceManager: coldMultisig.publicKey, config: configPda })
      .signers([coldMultisig])
      .rpc();

  const fetchConfig = () => program.account.psmConfig.fetch(configPda);

  const victimMint = (amount: bigint) =>
    program.methods
      .mintOkuM(new BN(amount.toString()))
      .accountsPartial(accountsFor(victim.publicKey, victimUsdcAta, victimOkuMAta))
      .signers([victim])
      .rpc();

  const victimBalance = async () =>
    (await getAccount(h.provider.connection, victimOkuMAta, undefined, TOKEN_2022_PROGRAM_ID))
      .amount;

  it("initialize sets minter_allowance_limit to the initial allowance", async () => {
    const config = await fetchConfig();
    expect(config.minterAllowanceLimit.toString()).to.equal(MINTER_ALLOWANCE.toString());
    expect(config.minterAllowance.toString()).to.equal(MINTER_ALLOWANCE.toString());
  });

  it("set_minter_allowance sets both allowance and limit", async () => {
    await setAllowance(perCycle * cycles);
    const config = await fetchConfig();
    expect(config.minterAllowance.toString()).to.equal((perCycle * cycles).toString());
    expect(config.minterAllowanceLimit.toString()).to.equal((perCycle * cycles).toString());
  });

  it("the audit PoC loop no longer drains the allowance", async () => {
    const configured = perCycle * cycles;
    await setAllowance(configured);
    const accts = accountsFor(attacker.publicKey, attackerUsdcAta, attackerOkuMAta);

    // 3x the cycles that drained the allowance before the fix, three pairs per tx.
    for (let t = 0; t < 6; t++) {
      const ixs: anchor.web3.TransactionInstruction[] = [];
      for (let i = 0; i < 3; i++) {
        ixs.push(
          await program.methods
            .mintOkuM(new BN(capital.toString()))
            .accountsPartial(accts)
            .instruction()
        );
        ixs.push(
          await program.methods
            .redeemOkuM(new BN(perCycle.toString()), new BN(0))
            .accountsPartial(accts)
            .instruction()
        );
      }
      const tx = new anchor.web3.Transaction().add(
        anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 }),
        ...ixs
      );
      await h.provider.sendAndConfirm!(tx, [attacker]);
    }

    const config = await fetchConfig();
    expect(config.minterAllowance.toString()).to.equal(configured.toString());

    const supply = (
      await getMint(h.provider.connection, okuMMint, undefined, TOKEN_2022_PROGRAM_ID)
    ).supply;
    expect(supply).to.equal(0n);

    await victimMint(1_000_000n);
    expect((await victimBalance()) > 0n).to.equal(true);
  });

  it("net outstanding issuance is still bounded; a redeem frees allowance", async () => {
    // The victim still holds OkuM from the previous test (minted under an older
    // limit), so the final redeem below burns more than this limit's consumption.
    await setAllowance(perCycle);

    await victimMint(capital);
    expect((await fetchConfig()).minterAllowance.toString()).to.equal("0");
    await expectBankrunError(() => victimMint(1_000_000n), "AllowanceExceeded");

    // Redeem half: the allowance comes back by exactly the burned amount.
    const half = perCycle / 2n;
    await program.methods
      .redeemOkuM(new BN(half.toString()), new BN(0))
      .accountsPartial(accountsFor(victim.publicKey, victimUsdcAta, victimOkuMAta))
      .signers([victim])
      .rpc();
    expect((await fetchConfig()).minterAllowance.toString()).to.equal(half.toString());

    // Redeeming more than was minted under this limit never lifts it above the limit.
    const rest = await victimBalance();
    expect(rest > perCycle - half).to.equal(true);
    await program.methods
      .redeemOkuM(new BN(rest.toString()), new BN(0))
      .accountsPartial(accountsFor(victim.publicKey, victimUsdcAta, victimOkuMAta))
      .signers([victim])
      .rpc();
    expect((await fetchConfig()).minterAllowance.toString()).to.equal(perCycle.toString());
  });

  it("a configured zero allowance is not revived by redemptions", async () => {
    await setAllowance(perCycle * cycles);
    await victimMint(capital);
    await setAllowance(0n);

    await program.methods
      .redeemOkuM(new BN((await victimBalance()).toString()), new BN(0))
      .accountsPartial(accountsFor(victim.publicKey, victimUsdcAta, victimOkuMAta))
      .signers([victim])
      .rpc();

    const config = await fetchConfig();
    expect(config.minterAllowance.toString()).to.equal("0");
    expect(config.minterAllowanceLimit.toString()).to.equal("0");
    await expectBankrunError(() => victimMint(1_000_000n), "AllowanceExceeded");
  });
});
