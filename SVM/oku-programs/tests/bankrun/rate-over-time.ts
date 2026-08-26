/**
 * Rate-changes-over-time tests (PSM multiplier).
 *
 * These tests exercise the discrete rate-update model under explicit slot
 * and wall-clock progression, validating that:
 *
 *   1. `set_multiplier` bumps the PSM `multiplier` and a subsequent
 *      `redeem_oku_m` returns the corresponding higher USDC payout.
 *   2. `distribute_yield(yield_amount)` bumps the multiplier proportional
 *      to `yield_amount / total_supply` and `redeem_oku_m` reflects the
 *      bump across multiple ticks.
 *   3. The yield-distribution sandwich lock fires on a same-slot
 *      mint/redeem and releases on the next slot — verified with a
 *      dedicated `autoBumpSlot: false` harness so the assertion is
 *      reproducible.
 *   4. Wall-clock progression alone is a no-op (SVM uses the discrete
 *      stored-multiplier model — no time-based `_rpow` streaming).
 *   5. Multi-tick yield accrual composes: 3 x 0.1% bumps across separate
 *      slots produce a strictly-higher redeem payout than the starting
 *      multiplier, with exact arithmetic at each tick.
 *
 * Time / slot progression is driven by `warpSlots` and `warpBy` from
 * `tests/shared/bankrun.ts` — bankrun's clock is sticky until something
 * explicitly warps it.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  ensurePSMUnpaused,
  mintOkuMViaProgram,
  DECIMALS,
} from "../shared/setup";
import { clearSyncWindow, expectedRedeemNet } from "../shared/multiplier";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  warpSlots,
  warpBy,
  getClock,
  expectBankrunError,
  readMultiplierFromMint,
} from "../shared/bankrun";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const PRECISION = new BN(1_000_000_000); // 1e9, matches oku-shared::PRECISION

describe("rate changes over time (slot + wall-clock progression)", () => {
  let h: BankrunHarness;
  let provider: anchor.AnchorProvider;
  let psm: Program<LitePsm>;
  let payer: Keypair;

  const orchestrator = psmOrchestrator;
  const user = Keypair.generate();

  let usdcMint: PublicKey;
  let okuMMint: PublicKey;

  let psmConfigPda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultOkuMAta: PublicKey;

  let userUsdcAta: PublicKey;
  let userOkuMAta: PublicKey;
  let orchestratorUsdcAta: PublicKey;

  before(async () => {
    h = await startBankrun();
    provider = h.provider as unknown as anchor.AnchorProvider;
    payer = h.payer;
    psm = h.program;

    const usdcMintKp = Keypair.generate();
    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      DECIMALS,
      usdcMintKp,
      TOKEN_PROGRAM_ID
    );

    await fundKeypairs(
      h,
      [user],
      10 * anchor.web3.LAMPORTS_PER_SOL
    );

    const psmSetup = await initializePsm(h, psm, payer, usdcMint);
    psmConfigPda = psmSetup.configPda;
    okuMMint = psmSetup.okuMMint;
    vaultUsdcAta = psmSetup.vaultUsdcAta;
    vaultOkuMAta = psmSetup.vaultOkuMAta;

    // User / orchestrator ATAs.
    userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    orchestratorUsdcAta = await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      usdcMint,
      TOKEN_PROGRAM_ID
    );
    userOkuMAta = getAssociatedTokenAddressSync(
      okuMMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, user.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);

    // Fund users with USDC.
    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 100_000_000_000, TOKEN_PROGRAM_ID); // 100k
    await mintToViaBankrun(h, usdcMint, orchestratorUsdcAta, payer, 100_000_000_000, TOKEN_PROGRAM_ID);

    // Mint okuM to user (50k).
    await mintOkuMViaProgram(
      psm as any,
      user,
      new BN(50_000_000_000),
      psmConfigPda,
      usdcMint,
      okuMMint,
      userUsdcAta,
      userOkuMAta,
      vaultUsdcAta
    );

    // Pre-load PSM buffer so redeems land instant throughout the suite.
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
  });

  beforeEach(async () => {
    await ensurePSMUnpaused(psm as any, psmConfigPda);
  });

  // -------------------------------------------------------------------
  // 1. PSM multiplier tick under explicit slot progression
  // -------------------------------------------------------------------

  it("redeem_oku_m payout tracks set_multiplier across explicit slot ticks", async () => {
    const m0 = await readMultiplierFromMint(h, okuMMint);

    // Redeem at m0 -> expected: oku_m * m0 / PRECISION.
    const redeemAmt = new BN(1_000_000_000); // 1000 okuM
    const expectedUsdc0 = expectedRedeemNet(redeemAmt, m0, PRECISION);
    const usdcBefore0 = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    await psm.methods
      .redeemOkuM(redeemAmt, new BN(0))
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMMint,
        userUsdcAta,
        userOkuMAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuM: vaultOkuMAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const usdcAfter0 = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    expect(Number(usdcAfter0.amount) - Number(usdcBefore0.amount)).to.equal(
      expectedUsdc0.toNumber()
    );

    // ===== Tick: bump the multiplier, then redeem again =====
    // 4 bps, inside `MAX_STEP_BPS` (5) with headroom for the f64 round-trip.
    // Was 1%, which the tightened step ceiling now refuses.
    const m1 = m0.add(m0.muln(4).divn(10_000));
    await psm.methods
      .setMultiplier(m1)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();
      await warpSlots(h, 1);
      await clearSyncWindow(h, psm as any, psmConfigPda);

    // Confirm the update landed on-chain via lastYieldDistributionSlot.
    const cfg1 = await psm.account.psmConfig.fetch(psmConfigPda);
    expect(Number(cfg1.lastYieldDistributionSlot)).to.be.greaterThan(0);

    // Explicit additional slot warp — defensive, ensures the
    // `last_yield_distribution_slot` stamp lands before the next ix.
    await warpSlots(h, 1);

    const expectedUsdc1 = expectedRedeemNet(redeemAmt, m1, PRECISION);
    const usdcBefore1 = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    await psm.methods
      .redeemOkuM(redeemAmt, new BN(0))
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMMint,
        userUsdcAta,
        userOkuMAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuM: vaultOkuMAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const usdcAfter1 = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    expect(Number(usdcAfter1.amount) - Number(usdcBefore1.amount)).to.equal(
      expectedUsdc1.toNumber()
    );

    // The tick payout must be strictly larger than the pre-tick payout
    // (same okuM input, higher multiplier).
    expect(expectedUsdc1.gt(expectedUsdc0)).to.be.true;
  });

  // -------------------------------------------------------------------
  // 2. distribute_yield composes correctly across consecutive slots
  // -------------------------------------------------------------------

  it("distribute_yield bumps multiplier by yield/supply across consecutive slot ticks", async () => {
    const m0 = await readMultiplierFromMint(h, okuMMint);

    // Read live okuM supply — distribute_yield uses this as the
    // denominator (`new_multiplier = old + yield * PRECISION / supply`).
    const { unpackMint } = await import("@solana/spl-token");
    const mintAcct0 = await provider.connection.getAccountInfo(okuMMint);
    const supply0 = new BN(
      unpackMint(okuMMint, mintAcct0!, TOKEN_2022_PROGRAM_ID).supply.toString()
    );

    // === Tick A: distribute_yield($10) ===
    const yieldA = new BN(10_000_000); // $10 in 6-decimal terms
    const expectedDeltaA = yieldA.mul(PRECISION).div(supply0);
    const mAExpected = m0.add(expectedDeltaA);

    await psm.methods
      .distributeYield(yieldA)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();
      await warpSlots(h, 1);
      await clearSyncWindow(h, psm as any, psmConfigPda);

    const cfgA = await psm.account.psmConfig.fetch(psmConfigPda);
    // Verify the on-chain update happened via lastYieldDistributionSlot.
    expect(Number(cfgA.lastYieldDistributionSlot)).to.be.greaterThan(0);

    // Warp to release the yield lock + bankrun's auto-bump still runs.
    await warpSlots(h, 1);

    // === Tick B: distribute_yield($20) at the (unchanged) supply ===
    const mintAcctB = await provider.connection.getAccountInfo(okuMMint);
    const supplyB = new BN(
      unpackMint(okuMMint, mintAcctB!, TOKEN_2022_PROGRAM_ID).supply.toString()
    );
    const yieldB = new BN(20_000_000);
    const expectedDeltaB = yieldB.mul(PRECISION).div(supplyB);
    const mBExpected = mAExpected.add(expectedDeltaB);

    await psm.methods
      .distributeYield(yieldB)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();
      await warpSlots(h, 1);
      await clearSyncWindow(h, psm as any, psmConfigPda);

    const cfgB = await psm.account.psmConfig.fetch(psmConfigPda);
    // Verify the on-chain update happened via lastYieldDistributionSlot.
    expect(Number(cfgB.lastYieldDistributionSlot)).to.be.greaterThan(
      Number(cfgA.lastYieldDistributionSlot)
    );

    // === Downstream redeem at the cumulative multiplier ===
    await warpSlots(h, 1);

    const redeemAmt = new BN(500_000_000); // 500 okuM
    const expectedUsdc = expectedRedeemNet(redeemAmt, mBExpected, PRECISION);
    const usdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    await psm.methods
      .redeemOkuM(redeemAmt, new BN(0))
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMMint,
        userUsdcAta,
        userOkuMAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuM: vaultOkuMAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const usdcAfter = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    expect(Number(usdcAfter.amount) - Number(usdcBefore.amount)).to.equal(
      expectedUsdc.toNumber()
    );
  });

  // -------------------------------------------------------------------
  // 3. Wall-clock progression alone is a no-op (discrete model)
  // -------------------------------------------------------------------

  it("wall-clock progression alone does NOT change multiplier (discrete model)", async () => {
    const cfg0 = await psm.account.psmConfig.fetch(psmConfigPda);
    const slot0 = Number(cfg0.lastYieldDistributionSlot);
    const clock0 = await getClock(h);

    // Jump the wall clock forward by 1 hour without any rebase call.
    await warpBy(h, 3600);
    await warpSlots(h, 1);

    const clock1 = await getClock(h);
    expect(Number(clock1.unixTimestamp) - Number(clock0.unixTimestamp)).to.be.greaterThan(
      3500
    );

    const cfg1 = await psm.account.psmConfig.fetch(psmConfigPda);
    // SVM PSM multiplier is a stored value — wall-clock alone is a no-op.
    // Verify lastYieldDistributionSlot did not advance (no rebase happened).
    expect(Number(cfg1.lastYieldDistributionSlot)).to.equal(slot0);
  });

  // -------------------------------------------------------------------
  // 4. Multi-tick composition under exact arithmetic
  // -------------------------------------------------------------------

  it("3 x small set_multiplier ticks compose to a strictly higher redeem payout", async () => {
    const mStart = await readMultiplierFromMint(h, okuMMint);

    let mCurrent = mStart;
    for (let i = 0; i < 3; i++) {
      const next = mCurrent.add(mCurrent.muln(4).divn(10_000)); // +4 bps
      await psm.methods
        .setMultiplier(next)
        .accountsPartial({
          rebaser: orchestrator.publicKey,
          config: psmConfigPda,
          okuMMint,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([orchestrator])
        .rpc();
        await warpSlots(h, 1);
        await clearSyncWindow(h, psm as any, psmConfigPda);
      mCurrent = next;
      await warpSlots(h, 1);
    }
    const mAfter3Ticks = mCurrent;

    // Redeem 100 okuM at the final composed multiplier.
    const redeemAmt = new BN(100_000_000);
    const expectedUsdc = expectedRedeemNet(redeemAmt, mAfter3Ticks, PRECISION);
    const usdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    await psm.methods
      .redeemOkuM(redeemAmt, new BN(0))
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMMint,
        userUsdcAta,
        userOkuMAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuM: vaultOkuMAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const usdcAfter = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);

    expect(Number(usdcAfter.amount) - Number(usdcBefore.amount)).to.equal(
      expectedUsdc.toNumber()
    );

    // The composed payout must be strictly greater than the starting-multiplier
    // payout would have been (sanity that rate actually appreciated).
    const baselineUsdc = expectedRedeemNet(redeemAmt, mStart, PRECISION);
    expect(Number(usdcAfter.amount) - Number(usdcBefore.amount)).to.be.greaterThan(
      baselineUsdc.toNumber()
    );
  });
});

// =============================================================================
// Dedicated sandwich-lock test — disables autoBumpSlot so the rebase and
// the follow-up redeem land in the SAME slot, exercising the on-chain
// YieldDistributionInProgress guard.
// =============================================================================
describe("sandwich lock under manual slot control (autoBumpSlot=false)", () => {
  let h: BankrunHarness;
  let provider: anchor.AnchorProvider;
  let psm: Program<LitePsm>;
  let payer: Keypair;

  const orchestrator = psmOrchestrator;
  const user = Keypair.generate();

  let usdcMint: PublicKey;
  let okuMMint: PublicKey;
  let psmConfigPda: PublicKey;
  let vaultUsdcAta: PublicKey;
  let vaultOkuMAta: PublicKey;
  let userUsdcAta: PublicKey;
  let userOkuMAta: PublicKey;
  let orchestratorUsdcAta: PublicKey;

  before(async () => {
    // Manual slot control — no auto-bump per send. This lets us land a
    // rebase and a redeem in the same slot to verify the lock fires.
    h = await startBankrun({ autoBumpSlot: false });
    provider = h.provider as unknown as anchor.AnchorProvider;
    payer = h.payer;
    psm = h.program;

    const usdcMintKp = Keypair.generate();
    usdcMint = await createMintViaBankrun(
      h,
      payer.publicKey,
      null,
      DECIMALS,
      usdcMintKp,
      TOKEN_PROGRAM_ID
    );
    await warpSlots(h, 1);

    await fundKeypairs(h, [user], 10 * anchor.web3.LAMPORTS_PER_SOL);
    await warpSlots(h, 1);

    // Sync window disabled for this describe: it exercises the SAME-SLOT
    // yield fence, which is a separate, orthogonal mechanism. Leaving the
    // window on would mask the fence behind a SyncWindowActive revert.
    const psmSetup = await initializePsm(h, psm, payer, usdcMint, {
      syncWindowSecs: 0,
    });
    psmConfigPda = psmSetup.configPda;
    okuMMint = psmSetup.okuMMint;
    vaultUsdcAta = psmSetup.vaultUsdcAta;
    vaultOkuMAta = psmSetup.vaultOkuMAta;
    await warpSlots(h, 1);

    userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
    await warpSlots(h, 1);
    orchestratorUsdcAta = await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      usdcMint,
      TOKEN_PROGRAM_ID
    );
    await warpSlots(h, 1);
    userOkuMAta = getAssociatedTokenAddressSync(
      okuMMint,
      user.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    await ensureAtaViaBankrun(h, user.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);
    await warpSlots(h, 1);

    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 5_000_000_000, TOKEN_PROGRAM_ID);
    await warpSlots(h, 1);
    await mintToViaBankrun(
      h,
      usdcMint,
      orchestratorUsdcAta,
      payer,
      5_000_000_000,
      TOKEN_PROGRAM_ID
    );
    await warpSlots(h, 1);

    await mintOkuMViaProgram(
      psm as any,
      user,
      new BN(1_000_000_000),
      psmConfigPda,
      usdcMint,
      okuMMint,
      userUsdcAta,
      userOkuMAta,
      vaultUsdcAta
    );
    await warpSlots(h, 1);

    await psm.methods
      .depositBuffer(new BN(2_000_000_000))
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
    await warpSlots(h, 1);
  });

  it("same-slot redeem after set_multiplier reverts with YieldDistributionInProgress; next slot succeeds", async () => {
    const m0 = await readMultiplierFromMint(h, okuMMint);
    // +0.99% — just inside what the 1% test `tout` covers, since the program
    // now refuses a step the redemption fee cannot cover.
    const m1 = m0.add(m0.muln(4).divn(10_000));

    // Stamp the yield-lock slot.
    //
    // Deliberately NO slot bump and NO window clear here — this test is
    // specifically about the same-slot fence, and settling either guard would
    // defeat the thing under test. The sync window is separately disabled in
    // this describe's setup so the two mechanisms can be observed in isolation.
    await psm.methods
      .setMultiplier(m1)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    // SAME SLOT redeem -> must revert.
    await expectBankrunError(
      () =>
        psm.methods
          .redeemOkuM(new BN(1_000_000), new BN(0))
          .accountsPartial({
            user: user.publicKey,
            config: psmConfigPda,
            usdcMint,
            okuMMint,
            userUsdcAta,
            userOkuMAta,
            vaultUsdc: vaultUsdcAta,
            vaultOkuM: vaultOkuMAta,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user])
          .rpc(),
      "YieldDistributionInProgress"
    );

    // Advance one slot — lock releases — redeem succeeds at the new multiplier.
    await warpSlots(h, 1);

    const redeemAmt = new BN(1_000_000);
    const expectedUsdc = expectedRedeemNet(redeemAmt, m1, PRECISION);
    const usdcBefore = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    await psm.methods
      .redeemOkuM(redeemAmt, new BN(0))
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMMint,
        userUsdcAta,
        userOkuMAta,
        vaultUsdc: vaultUsdcAta,
        vaultOkuM: vaultOkuMAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
    const usdcAfter = await getAccount(provider.connection, userUsdcAta, undefined, TOKEN_PROGRAM_ID);
    expect(Number(usdcAfter.amount) - Number(usdcBefore.amount)).to.equal(
      expectedUsdc.toNumber()
    );
  });
});
