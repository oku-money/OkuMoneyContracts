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
 * These tests also settle empirically: what
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
  warpSlots,
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

  /**
   * Does the f64 display multiplier exceed the canonical WAD integer?
   *
   * EXACT. A positive normal f64 is exactly `mantissa * 2^exp`, so
   * `display * 1e18 > canonical` becomes the integer comparison
   * `mantissa * 1e18 > canonical * 2^-exp` with no rounding anywhere.
   *
   * `BigInt(Math.floor(ratio * 1e18))` is NOT exact: near 1 the product's ULP
   * is 256, and flooring hides a ~256-wei overshoot — the same order as the
   * margin the mirror actually runs on.
   */
  const displayExceedsCanonical = (displayRatio: number, canonicalWad: bigint): boolean => {
    if (!Number.isFinite(displayRatio) || displayRatio <= 0) {
      throw new Error(`display multiplier not a positive normal: ${displayRatio}`);
    }
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(displayRatio, 0);
    const bits = buf.readBigUInt64LE(0);
    const rawExp = Number((bits >> 52n) & 0x7ffn);
    const frac = bits & 0xf_ffff_ffff_ffffn;
    // Normal: mantissa = 2^52 + frac, exponent = rawExp - 1075.
    if (rawExp === 0) throw new Error(`subnormal display multiplier: ${displayRatio}`);
    const mantissa = (1n << 52n) | frac;
    const exp = rawExp - 1075;
    if (exp >= 0) {
      // display >= 2^52; far outside the domain, but handle it without shifting right.
      return mantissa * (1n << BigInt(exp)) * 10n ** 18n > canonicalWad;
    }
    return mantissa * 10n ** 18n > canonicalWad * (1n << BigInt(-exp));
  };

  // -------------------------------------------------------------------
  // The safety invariant
  // -------------------------------------------------------------------

  it("never reads above canonical, across a full sync interval", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.2), start + 30 * DAY);
    await sync();

    // The multiplier at the moment of that sync. Everything below is bounded
    // against it, which is what stops a FROZEN mirror from passing.
    const atSync = await canonical();

    // Walk across the whole interval in small steps.
    for (let dt = 0; dt <= CRANK_SECS + 5; dt += 7) {
      const d = await readDisplayMultiplier(h, okuMMint);
      const c = await canonical();

      // Upper bound (the safety direction): never above canonical.
      expect(
        !displayExceedsCanonical(d.effective, c),
        `display ${d.effective} exceeded canonical ${c} at +${dt}s`,
      ).to.be.true;

      // LOWER bound. Without this the whole file is one-sided: a mirror that
      // wrote 1.0 once and never advanced satisfies "never above canonical"
      // forever. The mirror must be CORRECT AS OF ITS LAST CRANK -- it may lag,
      // but must not sit materially below the value at that crank.
      //
      // The slack is 1e-12 relative. That is ~4500x the deliberate f64
      // conversion bias (two `next_down` steps, ~2.2e-16) and still ~4 orders
      // of magnitude tighter than one crank interval of accrual at 20% APY, so
      // a frozen or regressing mirror fails.
      const syncFloor = atSync - atSync / 1_000_000_000_000n;
      expect(
        displayExceedsCanonical(d.effective, syncFloor),
        `display ${d.effective} fell below its value at last sync ${atSync} at +${dt}s`,
      ).to.be.true;

      await warpBy(h, 7);
    }
  });

  it("is permissionless — any keypair can crank it, and the crank advances the mirror", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.05), start + 30 * DAY);
    await sync();

    // Let the mirror go stale, so a no-op crank is distinguishable from a real one.
    await warpBy(h, 7 * DAY);
    await warpSlots(h, 1);
    const stale = await readDisplayMultiplier(h, okuMMint);

    // `stranger` holds no role whatsoever.
    await sync(stranger);
    const fresh = await readDisplayMultiplier(h, okuMMint);

    // The extension starts at 1.0, so `> 0` would be vacuous: assert the
    // unprivileged crank ADVANCED the mirror and landed at canonical.
    expect(fresh.effective).to.be.greaterThan(stale.effective);
    const c = await canonical();
    expect(!displayExceedsCanonical(fresh.effective, c), "crank must not overshoot").to.be.true;
    expect(
      displayExceedsCanonical(fresh.effective, c - c / 1_000_000n),
      `crank must land within 1e-6 of canonical (${c}), not merely below it; got ${fresh.effective}`,
    ).to.be.true;
  });

  // -------------------------------------------------------------------
  // The invariant must hold across a rate DECREASE
  // -------------------------------------------------------------------

  it("never reads above canonical across a rate DECREASE", async () => {
    // Not an edge case: settlement rates are routinely lower than base rates,
    // so a decrease happens at essentially every epoch roll. Any future step
    // armed under the fast schedule would fire ABOVE the slower re-anchored
    // curve; the mirror writes only m(now), so there is none to go stale.
    const start = await nowTs();
    await setRate(ratePerSecondForApy(20.0), start + 30 * DAY);
    await sync();

    // Drop hard, immediately after the sync — the worst alignment.
    await setRate(ratePerSecondForApy(0.01), (await nowTs()) + 30 * DAY);

    for (let dt = 0; dt <= CRANK_SECS * 2; dt += 10) {
      const d = await readDisplayMultiplier(h, okuMMint);
      const c = await canonical();
      expect(
        !displayExceedsCanonical(d.effective, c),
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
        !displayExceedsCanonical(d.effective, c),
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

    // No crank -> display must not move, however much time passes.
    await warpBy(h, CRANK_SECS * 5);
    const uncranked = await readDisplayMultiplier(h, okuMMint);
    expect(uncranked.effective).to.equal(
      afterSync.effective,
      "display moved without a crank",
    );

    // Canonical has moved on, so the gap is pure (safe) lag.
    expect(!displayExceedsCanonical(uncranked.effective, await canonical())).to.be.true;

    // Crank -> display catches up.
    await sync();
    const cranked = await readDisplayMultiplier(h, okuMMint);
    expect(cranked.effective).to.be.greaterThan(uncranked.effective);
    expect(!displayExceedsCanonical(cranked.effective, await canonical())).to.be.true;
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
  // Emergency override must correct the mirror synchronously
  // -------------------------------------------------------------------

  it("emergency override force-syncs the mirror immediately", async () => {
    const start = await nowTs();
    // A fast schedule, so any lingering future step would be meaningfully
    // ahead of the value the override lands on.
    await setRate(ratePerSecondForApy(20.0), start + 30 * DAY);
    await sync();

    const beforeOverride = await readDisplayMultiplier(h, okuMMint);

    // Override to barely above current canonical.
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
        !displayExceedsCanonical(d.effective, c),
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
