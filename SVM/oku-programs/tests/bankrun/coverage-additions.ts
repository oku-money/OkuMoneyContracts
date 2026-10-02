/**
 * Additional PSM edge-case coverage.
 *
 * Covered:
 *   - zero-supply distribute_yield reverts with ZeroAmount
 *   - PSM double-init negative test
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  unpackMint,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import {
  computeMultiplier,
  scheduleFromConfig,
  ratePerSecondForApy,
} from "@okumoney/yield-tooling";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  mintOkuMViaProgram,
  DECIMALS,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  warpBy,
  warpSlots,
  expectBankrunError,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

// ---------------------------------------------------------------------------
// PSM yield + init edge cases
// ---------------------------------------------------------------------------

describe("PSM coverage additions", () => {
  let h: BankrunHarness;
  let psm: Program<LitePsm>;
  let payer: Keypair;
  let usdcMint: PublicKey;
  let okuMMint: PublicKey;
  let configPda: PublicKey;
  let vaultUsdcAta: PublicKey;

  const orchestrator = psmOrchestrator;
  const user = Keypair.generate();

  before(async () => {
    h = await startBankrun();
    payer = h.payer;
    anchor.setProvider(h.provider as unknown as anchor.AnchorProvider);
    psm = h.program as unknown as Program<LitePsm>;

    usdcMint = await createMintViaBankrun(
      h, payer.publicKey, null, DECIMALS, Keypair.generate(), TOKEN_PROGRAM_ID
    );

    const setup = await initializePsm(h, psm, payer, usdcMint);
    configPda = setup.configPda;
    okuMMint = setup.okuMMint;
    vaultUsdcAta = setup.vaultUsdcAta;

    await fundKeypairs(h, [user], 10 * anchor.web3.LAMPORTS_PER_SOL);
  });

  // The old `distribute_yield reverts ZeroAmount when okuM supply == 0` test
  // was deleted with the instruction it covered. Under streaming accrual the
  // operator publishes a RATE, and a rate is well-defined at zero supply —
  // nothing is divided by the supply, so there is no degenerate case to guard.
  // That is the point of the model: the multiplier has no supply term, which
  // is exactly what makes it identical across chains.
  //
  // The replacement property — that a schedule can be published and accrues
  // correctly against an empty mint — is asserted here.
  it("a rate schedule is valid at zero supply, and prices a later mint higher", async () => {
    // The previous version evaluated `computeMultiplier` -- the test's OWN TS
    // mirror -- at two timestamps and asserted it was monotone. The program
    // contributed nothing to either value, `computeMultiplier` takes no supply
    // argument so "no supply term" was true by its signature, and the test
    // never checked that supply was actually zero. It asserted a property of
    // the test harness.
    //
    // The mirror is legitimate for PREDICTING an on-chain result (it is
    // differentially tested against the Solidity and Rust implementations).
    // It is not a substitute for one.
    const supplyBefore = (await unpackMint(
      okuMMint,
      (await h.provider.connection.getAccountInfo(okuMMint))!,
      TOKEN_2022_PROGRAM_ID
    )).supply;
    expect(supplyBefore.toString(), "fixture: mint must actually be empty").to.equal("0");

    const clock = await h.context.banksClient.getClock();
    const now = Number(clock.unixTimestamp);

    await psm.methods
      .setOkumYieldRate(new BN(ratePerSecondForApy(0.05).toString()), new BN(now + 30 * 86_400))
      .accountsPartial({ rebaser: orchestrator.publicKey, config: configPda })
      .signers([orchestrator])
      .rpc();

    const cfg: any = await psm.account.psmConfig.fetch(configPda);
    expect(cfg.okumRatePerSecond.toString()).to.equal(ratePerSecondForApy(0.05).toString());
    expect(Number(cfg.okumRateEnd)).to.equal(now + 30 * 86_400);

    // Mint once now and once a day later. The schedule was published against an
    // EMPTY mint, so if the multiplier had any supply term the second mint
    // could not price higher than the first.
    const userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    const userOkuMAta = getAssociatedTokenAddressSync(okuMMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await ensureAtaViaBankrun(h, user.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, vaultUsdcAta, payer, 10_000_000, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 2_000_000, TOKEN_PROGRAM_ID);

    const before1 = (await getAccount(h.provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID)).amount;
    await mintOkuMViaProgram(psm, user, new BN(1_000_000), configPda, usdcMint, okuMMint, userUsdcAta, userOkuMAta, vaultUsdcAta);
    const got1 = (await getAccount(h.provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID)).amount - before1;

    await warpBy(h, 86_400);
    await warpSlots(h, 1);

    const before2 = (await getAccount(h.provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID)).amount;
    await mintOkuMViaProgram(psm, user, new BN(1_000_000), configPda, usdcMint, okuMMint, userUsdcAta, userOkuMAta, vaultUsdcAta);
    const got2 = (await getAccount(h.provider.connection, userOkuMAta, undefined, TOKEN_2022_PROGRAM_ID)).amount - before2;

    // A day of accrual makes each okuM worth more, so the same USDC buys FEWER
    // of them. Asserted on-chain, against the program.
    expect(got2 < got1, `day-1 mint (${got2}) must buy fewer okuM than day-0 (${got1})`).to.be.true;

    // And the TS mirror predicts the on-chain result, which is the mirror's
    // actual job.
    const cfgNow: any = await psm.account.psmConfig.fetch(configPda);
    const nowTs = Number((await h.context.banksClient.getClock()).unixTimestamp);
    const mPredicted = computeMultiplier(scheduleFromConfig(cfgNow), BigInt(nowTs));
    expect(got2.toString()).to.equal(((1_000_000n * 10n ** 18n) / mPredicted).toString());
  });

  it("lite-psm initialize fails when the config PDA already exists", async () => {
    // The previous version omitted the required `okuMUri` param and passed an
    // existing mint with no signer, so it threw during CLIENT-SIDE Borsh
    // serialization and never reached the program -- then accepted that with
    // `expect(err).to.exist`. A test named for a program-level guard that never
    // invokes the program.
    //
    // Re-initialising needs a fresh okuM mint keypair (the instruction creates
    // it), so the ONLY thing that can fail is the config PDA already being in
    // use -- which is the guard under test.
    const freshOkuMKp = Keypair.generate();
    await expectBankrunError(
      () =>
        psm.methods
          .initialize({
            maxSupply: MAX_SUPPLY,
            minterAllowance: MINTER_ALLOWANCE,
            okuMUri: "https://oku.money/okum.json",
            pauser: warmMultisig.publicKey,
            unpauser: coldMultisig.publicKey,
            freezer: warmMultisig.publicKey,
            unfreezer: coldMultisig.publicKey,
            bufferDepositor: orchestrator.publicKey,
            bufferWithdrawer: coldMultisig.publicKey,
            capManager: coldMultisig.publicKey,
            allowanceManager: coldMultisig.publicKey,
            rebaser: orchestrator.publicKey,
          } as never)
          .accountsPartial({
            roleAdmin: payer.publicKey,
            config: configPda,
            usdcMint,
            okuMMint: freshOkuMKp.publicKey,
            vaultUsdc: vaultUsdcAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([freshOkuMKp])
          .rpc(),
      "already in use"
    );
  });
});
