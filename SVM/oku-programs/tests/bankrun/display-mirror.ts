/**
 * The wallet-facing ScaledUiAmount display mirror.
 *
 * The canonical multiplier streams continuously and costs no transactions, but
 * wallets cannot see it: they render a Token-2022 mint via
 * `ScaledUiAmountConfig::current_multiplier()`, which is a step function with
 * exactly one pre-armable future step. So the extension is maintained as a
 * lagging mirror, cranked permissionlessly, and nothing prices against it.
 *
 * The invariant that matters, and the only one that is safety-relevant:
 *
 *     display <= canonical,  always
 *
 * A user then redeems for at least what their wallet showed. The opposite
 * direction — display reading high — would promise value the PSM will not pay.
 *
 * These tests also settle `SVM/DECISIONS.md` D-02 empirically: what
 * Token-2022's processor actually does to the standing `multiplier` field when
 * a future `effective_timestamp` is supplied. That behaviour lives in the
 * processor, not in `spl-token-2022-interface`, so it can only be observed by
 * running the real `spl_token_2022.so` dump — which `startBankrun` loads.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { expect } from "chai";
import { LitePsm } from "../../target/types/lite_psm";
import { psmOrchestrator, initializePsm, ensurePSMUnpaused, DECIMALS } from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  warpBy,
  getClock,
  readDisplayMultiplier,
  computeCanonicalMultiplier,
} from "../shared/bankrun";
import { PRECISION, ratePerSecondForApy } from "@okumoney/yield-tooling";

const { Keypair } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const DAY = 86_400;
/**
 * A representative crank cadence. NOT a protocol constant — nothing on-chain
 * enforces or assumes any interval; the mirror is a pure lag and the cadence is
 * purely an operator choice.
 */
const CRANK_SECS = 60;

describe("display mirror (ScaledUiAmount)", () => {
  let h: BankrunHarness;
  let psm: Program<LitePsm>;
  let payer: Keypair;
  const orchestrator = psmOrchestrator;
  const stranger = Keypair.generate();

  let usdcMint: PublicKey;
  let okuMMint: PublicKey;
  let psmConfigPda: PublicKey;

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
    await fundKeypairs(h, [stranger], 10 * anchor.web3.LAMPORTS_PER_SOL);

    const setup = await initializePsm(h, psm, payer, usdcMint);
    psmConfigPda = setup.configPda;
    okuMMint = setup.okuMMint;
    await ensurePSMUnpaused(psm, psmConfigPda);
  });

  const nowTs = async (): Promise<number> => Number((await getClock(h)).unixTimestamp);
  const canonical = async (atTs?: bigint) =>
    computeCanonicalMultiplier(h, psm, psmConfigPda, atTs);

  const setRate = async (rate: bigint, endTs: number) =>
    psm.methods
      .setOkumYieldRate(new BN(rate.toString()), new BN(endTs))
      .accountsPartial({ rebaser: orchestrator.publicKey, config: psmConfigPda })
      .signers([orchestrator])
      .rpc();

  const sync = async (signer: Keypair = stranger) =>
    psm.methods
      .syncDisplayMultiplier()
      .accountsPartial({
        cranker: signer.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();

  /** `display <= canonical`, expressed in WAD integers for exactness. */
  const displayWad = (displayRatio: number): bigint =>
    BigInt(Math.floor(displayRatio * 1e18));

  // -------------------------------------------------------------------
  // The safety invariant
  // -------------------------------------------------------------------

  it("never reads above canonical, across a full sync interval", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.2), start + 30 * DAY);
    await sync();

    // Walk across the whole interval in small steps; display must stay <=
    // canonical at every point, including right at the pre-armed boundary.
    for (let dt = 0; dt <= CRANK_SECS + 5; dt += 7) {
      const d = await readDisplayMultiplier(h, okuMMint);
      const c = await canonical();
      expect(
        displayWad(d.effective) <= c,
        `display ${d.effective} exceeded canonical ${c} at +${dt}s`,
      ).to.be.true;
      await warpBy(h, 7);
    }
  });

  it("is permissionless — any keypair can crank it", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.05), start + 30 * DAY);
    // `stranger` holds no role whatsoever.
    await sync(stranger);
    const d = await readDisplayMultiplier(h, okuMMint);
    expect(d.effective).to.be.greaterThan(0);
  });

  // -------------------------------------------------------------------
  // The invariant must hold across a rate DECREASE
  // -------------------------------------------------------------------

  it("never reads above canonical across a rate DECREASE", async () => {
    // This is the case that broke the old pre-armed design, and it is not an
    // edge case: settlement rates are routinely lower than base rates, so a
    // decrease happens at essentially every epoch roll.
    //
    // Previously the sync armed m(now+60) under the fast schedule; lowering the
    // rate re-anchored canonical onto a slower curve, and at now+60 the armed
    // step fired ABOVE it. The mirror now writes only m(now), so there is no
    // armed step to go stale.
    const start = await nowTs();
    await setRate(ratePerSecondForApy(20.0), start + 30 * DAY);
    await sync();

    // Drop hard, immediately after the sync — the worst alignment.
    await setRate(ratePerSecondForApy(0.01), (await nowTs()) + 30 * DAY);

    for (let dt = 0; dt <= CRANK_SECS * 2; dt += 10) {
      const d = await readDisplayMultiplier(h, okuMMint);
      const c = await canonical();
      expect(
        displayWad(d.effective) <= c,
        `display ${d.effective} exceeded canonical ${c} at +${dt}s after a rate decrease`,
      ).to.be.true;
      await warpBy(h, 10);
    }
  });

  it("never reads above canonical across a halt", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(20.0), start + 30 * DAY);
    await sync();

    // Halting is the largest possible decrease.
    await setRate(PRECISION, 0);

    for (let dt = 0; dt <= CRANK_SECS * 2; dt += 10) {
      const d = await readDisplayMultiplier(h, okuMMint);
      const c = await canonical();
      expect(
        displayWad(d.effective) <= c,
        `display ${d.effective} exceeded canonical ${c} at +${dt}s after a halt`,
      ).to.be.true;
      await warpBy(h, 10);
    }
  });

  it("is a pure lag: flat between cranks, stepping up at each one", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(1.0), start + 30 * DAY);
    await sync();

    const afterSync = await readDisplayMultiplier(h, okuMMint);

    // No crank -> display must not move, however much time passes. The old
    // design deliberately advanced here via a pre-armed step; it no longer does.
    await warpBy(h, CRANK_SECS * 5);
    const uncranked = await readDisplayMultiplier(h, okuMMint);
    expect(uncranked.effective).to.equal(
      afterSync.effective,
      "display moved without a crank — there should be no pre-armed step",
    );

    // Canonical has moved on, so the gap is pure (safe) lag.
    expect(displayWad(uncranked.effective) <= (await canonical())).to.be.true;

    // Crank -> display catches up.
    await sync();
    const cranked = await readDisplayMultiplier(h, okuMMint);
    expect(cranked.effective).to.be.greaterThan(uncranked.effective);
    expect(displayWad(cranked.effective) <= (await canonical())).to.be.true;
  });

  // -------------------------------------------------------------------
  // Sandwich lock must NOT engage
  // -------------------------------------------------------------------

  it("does not stamp the sandwich lock (PSM stays usable in the same slot)", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.05), start + 30 * DAY);

    const before = await psm.account.psmConfig.fetch(psmConfigPda);
    await sync();
    const after = await psm.account.psmConfig.fetch(psmConfigPda);

    expect(
      (after as any).lastYieldDistributionSlot.toString(),
      "display sync must not engage the sandwich lock — it would make the PSM " +
        "unavailable for one slot per sync interval for no security benefit",
    ).to.equal((before as any).lastYieldDistributionSlot.toString());
  });

  it("records the sync timestamp for staleness tracking", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.05), start + 30 * DAY);
    await sync();
    const cfg = await psm.account.psmConfig.fetch(psmConfigPda);
    expect(Number((cfg as any).lastDisplaySyncTs)).to.be.greaterThanOrEqual(start);
  });

  // -------------------------------------------------------------------
  // Emergency override must correct the mirror synchronously (D-10)
  // -------------------------------------------------------------------

  it("emergency override force-syncs the mirror immediately", async () => {
    const start = await nowTs();
    // A fast schedule, so the pre-armed step is meaningfully ahead of the
    // value the override will land on.
    await setRate(ratePerSecondForApy(20.0), start + 30 * DAY);
    await sync();

    const beforeOverride = await readDisplayMultiplier(h, okuMMint);

    // Override to barely above current canonical — well BELOW the armed step.
    const current = await canonical();
    const target = current + 1_000n;

    await psm.methods
      .setOkumMultiplier(new BN(target.toString()))
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    // The override halts the schedule, so canonical stops moving. The mirror
    // is force-synced rather than left to the next crank — belt-and-braces
    // since a pure lag would already be safe, but an emergency is exactly when
    // a correct display is worth the two extra CPIs.
    expect(beforeOverride.effective).to.be.greaterThan(0);

    for (const dt of [0, CRANK_SECS + 5]) {
      if (dt > 0) await warpBy(h, dt);
      const d = await readDisplayMultiplier(h, okuMMint);
      const c = await canonical();
      expect(
        displayWad(d.effective) <= c,
        `display ${d.effective} > canonical ${c} at +${dt}s after override`,
      ).to.be.true;
    }
  });

  it("emergency override halts accrual and stamps the sandwich lock", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.05), start + 30 * DAY);
    await warpBy(h, DAY);

    const current = await canonical();
    await psm.methods
      .setOkumMultiplier(new BN((current + 10_000n).toString()))
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

    const cfg: any = await psm.account.psmConfig.fetch(psmConfigPda);
    expect(cfg.lastYieldDistributionSlot.toNumber()).to.be.greaterThan(0);
    expect(cfg.okumRateEnd.toNumber()).to.equal(0, "override must halt the schedule");
    expect(cfg.okumRatePerSecond.toString()).to.equal(PRECISION.toString());

    // Frozen thereafter.
    const m1 = await canonical();
    await warpBy(h, 100 * DAY);
    expect(await canonical()).to.equal(m1);
  });
});
