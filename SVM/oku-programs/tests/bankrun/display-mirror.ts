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
import { PRECISION, ratePerSecondForApy } from "../../scripts/utils/multiplier";

const { Keypair } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const DAY = 86_400;
/** Must match `helpers::display_sync::DISPLAY_SYNC_INTERVAL`. */
const SYNC_INTERVAL = 60;

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
    await ensurePSMUnpaused(psm as any, psmConfigPda);
  });

  const nowTs = async (): Promise<number> => Number((await getClock(h)).unixTimestamp);
  const canonical = async (atTs?: bigint) =>
    computeCanonicalMultiplier(h, psm as any, psmConfigPda, atTs);

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
    for (let dt = 0; dt <= SYNC_INTERVAL + 5; dt += 7) {
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
  // D-02: what the processor does with a future effective_timestamp
  // -------------------------------------------------------------------

  it("pre-arms the next step so display advances with NO further transaction", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(1.0), start + 30 * DAY); // 100% APY, visible movement
    await sync();

    const immediately = await readDisplayMultiplier(h, okuMMint);

    // Cross the pre-armed effective timestamp WITHOUT cranking again.
    await warpBy(h, SYNC_INTERVAL + 1);
    const afterBoundary = await readDisplayMultiplier(h, okuMMint);

    expect(
      afterBoundary.effective > immediately.effective,
      `pre-armed step did not activate: ${immediately.effective} -> ${afterBoundary.effective}`,
    ).to.be.true;

    // And it is still bounded by canonical.
    expect(displayWad(afterBoundary.effective) <= (await canonical())).to.be.true;
  });

  it("documents the processor's treatment of the standing multiplier field", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(1.0), start + 30 * DAY);
    await sync();

    const d = await readDisplayMultiplier(h, okuMMint);
    // Both slots are populated: `multiplier` is the immediate write and
    // `newMultiplier` the pre-arm, with the pre-arm strictly ahead in both
    // value and time. If this ever inverts, `sync_display_multiplier`'s
    // two-CPI sequence needs revisiting.
    expect(d.newMultiplier).to.be.greaterThan(0);
    expect(d.effectiveTs).to.be.greaterThan(start);
    expect(d.newMultiplier).to.be.greaterThanOrEqual(d.multiplier);
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

  it("emergency override force-syncs the mirror, leaving no stale pre-armed step", async () => {
    const start = await nowTs();
    // A fast schedule, so the pre-armed step is meaningfully ahead of the
    // value the override will land on.
    await setRate(ratePerSecondForApy(20.0), start + 30 * DAY);
    await sync();

    const armed = await readDisplayMultiplier(h, okuMMint);
    expect(armed.newMultiplier).to.be.greaterThan(armed.multiplier);

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

    // Immediately, and after crossing where the stale step would have fired:
    // display must never exceed the (now halted) canonical value.
    for (const dt of [0, SYNC_INTERVAL + 5]) {
      if (dt > 0) await warpBy(h, dt);
      const d = await readDisplayMultiplier(h, okuMMint);
      const c = await canonical();
      expect(
        displayWad(d.effective) <= c,
        `stale pre-armed step leaked: display ${d.effective} > canonical ${c} at +${dt}s`,
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
