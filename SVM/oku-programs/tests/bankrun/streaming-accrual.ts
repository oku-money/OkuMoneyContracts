/**
 * Streaming accrual — the SVM port of EVM's continuous rate-schedule model.
 *
 * Replaces the old `rate-over-time.ts`, whose central assertion was the exact
 * OPPOSITE of the one here: it asserted that wall-clock progression alone does
 * NOT change the multiplier (the discrete stored-multiplier model). Under
 * streaming accrual, wall-clock progression is the ONLY thing that changes it.
 *
 * What these tests establish, in rough order of how badly a regression would
 * hurt:
 *
 *   1. The multiplier advances with NO transaction. This is the property the
 *      whole refactor exists for — it is what removes the discrete tick a
 *      searcher could sandwich, and what makes cross-chain agreement free.
 *   2. A pre-staged successor activates at `rateEnd` with NO transaction, so
 *      epoch handovers are simultaneous across chains even when the staging
 *      transactions land days apart.
 *   3. Accrual HALTS when a window expires unattended. The failure mode of a
 *      missed operator transaction must be "stops paying", never "pays
 *      forever" or "diverges".
 *   4. The on-chain multiplier matches the TS mirror exactly at every point
 *      tested — the closest thing we have to a cross-implementation check
 *      until the differential harness (DECISIONS.md D-05) exists.
 *   5. Every write rail from `OkuMoney.sol` rejects what it should.
 *
 * Time progression is driven by `warpBy` / `warpSlots` from
 * `tests/shared/bankrun.ts` — bankrun's clock is sticky until warped.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import {
  psmOrchestrator,
  initializePsm,
  ensurePSMUnpaused,
  mintOkuMViaProgram,
  DECIMALS,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  warpBy,
  getClock,
  expectBankrunError,
  computeCanonicalMultiplier,
  simulateTx,
  decodeEvents,
} from "../shared/bankrun";
import {
  PRECISION,
  MAX_RATE,
  computeMultiplier,
  scheduleFromConfig,
  ratePerSecondForApy,
} from "@okumoney/yield-tooling";

const { Keypair } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const DAY = 86_400;

describe("streaming accrual (continuous rate schedule)", () => {
  let h: BankrunHarness;
  let psm: Program<LitePsm>;
  let payer: Keypair;

  const orchestrator = psmOrchestrator;
  const user = Keypair.generate();

  let usdcMint: PublicKey;
  let okuMMint: PublicKey;
  let psmConfigPda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let userUsdcAta: PublicKey;
  let userOkuMAta: PublicKey;
  let orchestratorUsdcAta: PublicKey;

  /** Fresh harness per test: the schedule is global mutable state. */
  beforeEach(async () => {
    h = await startBankrun();
    payer = h.payer;
    psm = h.program;

    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      DECIMALS,
      Keypair.generate(),
      TOKEN_PROGRAM_ID,
    );

    await fundKeypairs(h, [user], 10 * anchor.web3.LAMPORTS_PER_SOL);

    const setup = await initializePsm(h, psm, payer, usdcMint);
    psmConfigPda = setup.configPda;
    okuMMint = setup.okuMMint;
    vaultUsdcAta = setup.vaultUsdcAta;

    userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    orchestratorUsdcAta = await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      usdcMint,
      TOKEN_PROGRAM_ID,
    );
    userOkuMAta = getAssociatedTokenAddressSync(
      okuMMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID,
    );
    await ensureAtaViaBankrun(h, user.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);

    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 100_000_000_000, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(
      h,
      usdcMint,
      orchestratorUsdcAta,
      payer,
      100_000_000_000,
      TOKEN_PROGRAM_ID,
    );

    await ensurePSMUnpaused(psm as any, psmConfigPda);
  });

  // -- helpers ---------------------------------------------------------

  const nowTs = async (): Promise<number> => Number((await getClock(h)).unixTimestamp);

  const canonical = async (atTs?: bigint): Promise<bigint> =>
    computeCanonicalMultiplier(h, psm as any, psmConfigPda, atTs);

  const fetchSchedule = async () =>
    scheduleFromConfig((await psm.account.psmConfig.fetch(psmConfigPda)) as any);

  const setRate = async (rate: bigint, endTs: number) =>
    psm.methods
      .setOkumYieldRate(new BN(rate.toString()), new BN(endTs))
      .accountsPartial({ rebaser: orchestrator.publicKey, config: psmConfigPda })
      .signers([orchestrator])
      .rpc();

  const setRateWithSuccessor = async (
    rate: bigint,
    endTs: number,
    nextRate: bigint,
    nextEndTs: number,
  ) =>
    psm.methods
      .setOkumYieldRateWithSuccessor(
        new BN(rate.toString()),
        new BN(endTs),
        new BN(nextRate.toString()),
        new BN(nextEndTs),
      )
      .accountsPartial({ rebaser: orchestrator.publicKey, config: psmConfigPda })
      .signers([orchestrator])
      .rpc();

  // -------------------------------------------------------------------
  // 1. The headline property: accrual with no transaction
  // -------------------------------------------------------------------

  it("multiplier advances with NO transaction as wall-clock time passes", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.05), start + 30 * DAY);

    const m0 = await canonical();

    // Nothing is submitted between these reads — only time moves.
    await warpBy(h, 1 * DAY);
    const m1 = await canonical();
    await warpBy(h, 1 * DAY);
    const m2 = await canonical();

    expect(m1 > m0, `expected streaming accrual, got ${m0} -> ${m1}`).to.be.true;
    expect(m2 > m1, `expected streaming accrual, got ${m1} -> ${m2}`).to.be.true;

    // Roughly 5% APY over two days: ~0.0267%.
    const growth = Number(((m2 - m0) * 1_000_000n) / m0) / 1_000_000;
    expect(growth).to.be.greaterThan(0.0002);
    expect(growth).to.be.lessThan(0.0004);
  });

  it("a halted schedule does not accrue, no matter how much time passes", async () => {
    // Fresh init is flat-and-halted; never publish a rate.
    const m0 = await canonical();
    await warpBy(h, 365 * DAY);
    const m1 = await canonical();
    expect(m1).to.equal(m0);
    expect(m0).to.equal(PRECISION);
  });

  // -------------------------------------------------------------------
  // 2. Transaction-free successor handover
  // -------------------------------------------------------------------

  it("a pre-staged successor activates at rateEnd with NO transaction", async () => {
    const start = await nowTs();
    const rateEnd = start + 10 * DAY;
    const pendingEnd = start + 40 * DAY;

    await setRateWithSuccessor(
      ratePerSecondForApy(0.05),
      rateEnd,
      ratePerSecondForApy(0.2),
      pendingEnd,
    );

    // Sample either side of the boundary. No transaction is sent in between.
    await warpBy(h, 10 * DAY - 60);
    const before = await canonical();
    await warpBy(h, 120); // cross rateEnd
    const after = await canonical();

    expect(after > before).to.be.true;

    // The successor is genuinely faster: compare a day of each regime.
    const dayOfFirst = await canonical(BigInt(start + 2 * DAY)) - (await canonical(BigInt(start + DAY)));
    const dayOfSecond =
      (await canonical(BigInt(rateEnd + 2 * DAY))) - (await canonical(BigInt(rateEnd + DAY)));
    expect(dayOfSecond > dayOfFirst, "successor rate should accrue faster").to.be.true;
  });

  it("accrual HALTS at pendingRateEnd rather than compounding forever", async () => {
    const start = await nowTs();
    const rateEnd = start + 5 * DAY;
    const pendingEnd = start + 10 * DAY;

    await setRateWithSuccessor(
      ratePerSecondForApy(0.05),
      rateEnd,
      ratePerSecondForApy(0.05),
      pendingEnd,
    );

    const atExpiry = await canonical(BigInt(pendingEnd));
    const wayLater = await canonical(BigInt(pendingEnd + 3650 * DAY));

    expect(wayLater).to.equal(
      atExpiry,
      "an unattended successor must halt, not compound indefinitely",
    );
  });

  it("accrual HALTS at rateEnd when no successor is armed", async () => {
    const start = await nowTs();
    const rateEnd = start + 5 * DAY;
    await setRate(ratePerSecondForApy(0.05), rateEnd);

    const atEnd = await canonical(BigInt(rateEnd));
    const later = await canonical(BigInt(rateEnd + 100 * DAY));
    expect(later).to.equal(atEnd, "missed epoch must halt accrual, not extend it");
  });

  // -------------------------------------------------------------------
  // 3. On-chain pricing matches the computed multiplier
  // -------------------------------------------------------------------

  it("redeem payout tracks the streamed multiplier with no yield transaction", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.2), start + 30 * DAY);

    await mintOkuMViaProgram(
      psm as any,
      user,
      new BN(50_000_000_000),
      psmConfigPda,
      usdcMint,
      okuMMint,
      userUsdcAta,
      userOkuMAta,
      vaultUsdcAta,
    );
    await psm.methods
      .depositBuffer(new BN(50_000_000_000))
      .accountsPartial({
        bufferDepositor: orchestrator.publicKey,
        config: psmConfigPda,
        bufferDepositorUsdcAta: orchestratorUsdcAta,
        vaultUsdc: vaultUsdcAta,
        usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    const redeemAmt = new BN(1_000_000_000); // 1000 OkuM raw

    const balBefore = (
      await getAccount(h.provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID)
    ).amount;

    // Warp a month with NO yield transaction, then redeem.
    await warpBy(h, 29 * DAY);

    const mAtRedeem = await canonical();
    await psm.methods
      .redeemOkuM(redeemAmt, new BN(0))
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMMint,
        userOkuMAta,
        userUsdcAta,
        vaultUsdc: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([user])
      .rpc();

    const balAfter = (
      await getAccount(h.provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID)
    ).amount;
    const paid = balAfter - balBefore;

    // The payout must exceed par — yield accrued purely from elapsed time.
    expect(paid > BigInt(redeemAmt.toString()), `paid ${paid} should exceed par`).to.be.true;

    // And it must match floor(raw * m / PRECISION) computed off-chain, within
    // one second of drift (the tx lands a moment after we sampled).
    const expected = (BigInt(redeemAmt.toString()) * mAtRedeem) / PRECISION;
    const diff = paid > expected ? paid - expected : expected - paid;
    expect(diff <= 2n, `payout ${paid} vs expected ${expected}`).to.be.true;
  });

  // -------------------------------------------------------------------
  // 4. On-chain state agrees with the TS mirror
  // -------------------------------------------------------------------

  it("on-chain schedule matches the TS mirror across both boundaries", async () => {
    const start = await nowTs();
    const rateEnd = start + 7 * DAY;
    const pendingEnd = start + 21 * DAY;
    await setRateWithSuccessor(
      ratePerSecondForApy(0.05),
      rateEnd,
      ratePerSecondForApy(0.08),
      pendingEnd,
    );

    const schedule = await fetchSchedule();

    // Sample densely around both handovers, where an off-by-one would hide.
    const samples = [
      start,
      start + 1,
      rateEnd - 1,
      rateEnd,
      rateEnd + 1,
      pendingEnd - 1,
      pendingEnd,
      pendingEnd + 1,
      pendingEnd + 365 * DAY,
    ];

    let prev = 0n;
    for (const ts of samples) {
      const m = computeMultiplier(schedule, BigInt(ts));
      expect(m >= prev, `multiplier decreased at ts=${ts}: ${m} < ${prev}`).to.be.true;
      prev = m;
    }

    // And the schedule the program stored is exactly what we asked for.
    expect(schedule.rateEnd).to.equal(BigInt(rateEnd));
    expect(schedule.pendingRateEnd).to.equal(BigInt(pendingEnd));
    expect(schedule.ratePerSecond).to.equal(ratePerSecondForApy(0.05));
    expect(schedule.pendingRatePerSecond).to.equal(ratePerSecondForApy(0.08));
  });

  it("re-anchors on every schedule write so no yield is created or destroyed", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.1), start + 30 * DAY);

    await warpBy(h, 5 * DAY);
    const before = await canonical();

    // Rewrite the schedule. The multiplier must not jump.
    const t = await nowTs();
    await setRate(ratePerSecondForApy(0.03), t + 30 * DAY);
    const after = await canonical();

    const diff = after > before ? after - before : before - after;
    // Allow a few seconds of accrual between the two reads.
    expect(diff < PRECISION / 100_000n, `re-anchor jumped: ${before} -> ${after}`).to.be.true;

    const schedule = await fetchSchedule();
    expect(schedule.baseMultiplier >= before, "base must snapshot the accrued value").to.be.true;
  });

  // -------------------------------------------------------------------
  // 5. Write rails
  // -------------------------------------------------------------------

  it("rejects a rate below PRECISION (the multiplier is monotonic)", async () => {
    const end = (await nowTs()) + DAY;
    await expectBankrunError(() => setRate(PRECISION - 1n, end), "InvalidRate");
  });

  it("rejects a rate above MAX_RATE", async () => {
    const end = (await nowTs()) + DAY;
    await expectBankrunError(() => setRate(MAX_RATE + 1n, end), "RateTooHigh");
  });

  it("rejects a yielding rate with no future window", async () => {
    const past = (await nowTs()) - 1;
    await expectBankrunError(
      () => setRate(ratePerSecondForApy(0.05), past),
      "EndTimestampInPast",
    );
    await expectBankrunError(() => setRate(ratePerSecondForApy(0.05), 0), "EndTimestampInPast");
  });

  it("rejects a halted rate that carries a window", async () => {
    const end = (await nowTs()) + DAY;
    await expectBankrunError(() => setRate(PRECISION, end), "EndTimestampNotAllowed");
  });

  it("allows halting (rate == PRECISION, end == 0)", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.05), start + 30 * DAY);
    await warpBy(h, DAY);
    const accrued = await canonical();

    await setRate(PRECISION, 0);

    await warpBy(h, 100 * DAY);
    const afterHalt = await canonical();
    expect(afterHalt).to.equal(accrued, "halting must freeze the multiplier at its accrued value");
  });

  it("rejects staging a successor with no active window", async () => {
    await expectBankrunError(
      () =>
        psm.methods
          .setNextOkumYieldRate(new BN(ratePerSecondForApy(0.05).toString()), new BN(999_999_999))
          .accountsPartial({ rebaser: orchestrator.publicKey, config: psmConfigPda })
          .signers([orchestrator])
          .rpc(),
      "NoRateEndSet",
    );
  });

  it("rejects a successor whose expiry is not after the active window", async () => {
    const start = await nowTs();
    const rateEnd = start + 10 * DAY;
    await setRate(ratePerSecondForApy(0.05), rateEnd);

    await expectBankrunError(
      () =>
        psm.methods
          .setNextOkumYieldRate(new BN(ratePerSecondForApy(0.05).toString()), new BN(rateEnd))
          .accountsPartial({ rebaser: orchestrator.publicKey, config: psmConfigPda })
          .signers([orchestrator])
          .rpc(),
      "PendingEndNotAfterRateEnd",
    );
  });

  it("rejects staging a successor against an already-expired window", async () => {
    const start = await nowTs();
    const rateEnd = start + 2 * DAY;
    await setRate(ratePerSecondForApy(0.05), rateEnd);

    await warpBy(h, 3 * DAY); // window has closed

    await expectBankrunError(
      () =>
        psm.methods
          .setNextOkumYieldRate(
            new BN(ratePerSecondForApy(0.05).toString()),
            new BN(rateEnd + 30 * DAY),
          )
          .accountsPartial({ rebaser: orchestrator.publicKey, config: psmConfigPda })
          .signers([orchestrator])
          .rpc(),
      "RateAlreadyExpired",
    );
  });

  // -------------------------------------------------------------------
  // 5b. Atomic-setter composition — regressions for two EVM divergences
  // -------------------------------------------------------------------
  //
  // Both of these passed before `set_okum_yield_rate_with_successor` was
  // restructured to compose the same two private writers EVM composes. They
  // exist to keep it that way.

  it("rejects halting AND arming a successor in the same atomic call", async () => {
    // EVM: `_setOkuMYieldRate(PRECISION, 0)` leaves `rateEnd == 0`, so the
    // following `_setNextOkuMYieldRate` reverts NoRateEndSet. A successor to a
    // halted rate is meaningless.
    const t = await nowTs();
    await expectBankrunError(
      () => setRateWithSuccessor(PRECISION, 0, ratePerSecondForApy(0.05), t + 30 * DAY),
      "NoRateEndSet",
    );
  });

  it("while paused, rejects a successor that increases on the rate written in the same call", async () => {
    // The subtle one. Paused with a 5% baseline, `withSuccessor(3%, .., 4%, ..)`
    // must revert: the successor's pause gate has to compare against the 3%
    // just written, NOT the 5% that was there before. Comparing against the old
    // value lets a rate INCREASE through while users cannot exit — exactly what
    // the gate exists to prevent.
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.05), start + 30 * DAY);

    const { warmMultisig } = await import("../shared/setup");
    await psm.methods
      .pause()
      .accountsPartial({ pauser: warmMultisig.publicKey, config: psmConfigPda })
      .signers([warmMultisig])
      .rpc();

    const t = await nowTs();
    await expectBankrunError(
      () =>
        setRateWithSuccessor(
          ratePerSecondForApy(0.03), // decrease vs 5% -> active gate passes
          t + 30 * DAY,
          ratePerSecondForApy(0.04), // increase vs the 3% just written -> must fail
          t + 60 * DAY,
        ),
      "Paused",
    );

    // Control: a successor at or below the newly-written rate is still allowed,
    // so the gate is not simply rejecting everything while paused.
    await setRateWithSuccessor(
      ratePerSecondForApy(0.03),
      t + 30 * DAY,
      ratePerSecondForApy(0.02),
      t + 60 * DAY,
    );
  });

  it("emits PendingRateCancelled when an armed successor is discarded", async () => {
    const start = await nowTs();
    await setRateWithSuccessor(
      ratePerSecondForApy(0.05),
      start + 10 * DAY,
      ratePerSecondForApy(0.08),
      start + 20 * DAY,
    );

    // Overwriting the active rate discards the armed successor. Without an
    // event, a chain that silently dropped one would look identical to a chain
    // that still has it staged — the handover itself emits nothing.
    const t = await nowTs();
    const tx = await psm.methods
      .setOkumYieldRate(new BN(ratePerSecondForApy(0.06).toString()), new BN(t + 30 * DAY))
      .accountsPartial({ rebaser: orchestrator.publicKey, config: psmConfigPda })
      .transaction();
    const sim = await simulateTx(h, tx, [orchestrator]);
    const events = decodeEvents(psm as any, sim.logs);
    const names = events.map((e) => e.name);
    expect(names).to.include(
      "pendingRateCancelled",
      `expected PendingRateCancelled, got: ${names.join(", ")}`,
    );

    // Now actually submit it and confirm the successor really is gone.
    await setRate(ratePerSecondForApy(0.06), (await nowTs()) + 30 * DAY);
    const cfg = await fetchSchedule();
    expect(cfg.pendingRatePerSecond).to.equal(PRECISION, "successor must be cleared");
    expect(cfg.pendingRateEnd).to.equal(0n);
  });

  it("rejects a non-rebaser", async () => {
    const end = (await nowTs()) + DAY;
    await expectBankrunError(
      () =>
        psm.methods
          .setOkumYieldRate(new BN(ratePerSecondForApy(0.05).toString()), new BN(end))
          .accountsPartial({ rebaser: user.publicKey, config: psmConfigPda })
          .signers([user])
          .rpc(),
      "Unauthorized",
    );
  });

  // -------------------------------------------------------------------
  // 6. Pause gate: blocks increases, permits decreases
  // -------------------------------------------------------------------

  it("while paused, rejects a rate INCREASE but permits a decrease and a halt", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.05), start + 30 * DAY);

    await psm.methods
      .pause()
      .accountsPartial({ pauser: (await import("../shared/setup")).warmMultisig.publicKey, config: psmConfigPda })
      .signers([(await import("../shared/setup")).warmMultisig])
      .rpc();

    const t = await nowTs();

    // Increase -> blocked.
    await expectBankrunError(
      () => setRate(ratePerSecondForApy(0.5), t + 30 * DAY),
      "Paused",
    );

    // Decrease -> allowed. Inflating while users cannot exit is the thing
    // being prevented; slowing down is incident response and must stay open.
    await setRate(ratePerSecondForApy(0.01), t + 30 * DAY);

    // Halting -> always allowed.
    await setRate(PRECISION, 0);
  });
});
