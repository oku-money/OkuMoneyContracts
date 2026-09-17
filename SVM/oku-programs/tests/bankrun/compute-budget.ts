/**
 * Compute-unit budget for the streaming-accrual paths.
 *
 * ## Why this suite exists
 *
 * Under the discrete model the multiplier was a stored scalar and reading it
 * was a field access. It is now *computed* on every mint and every redeem:
 * `compute_multiplier` runs `rpow`, which is exponentiation by squaring over
 * ~20-25 iterations depending on the window length, each iteration costing two
 * 256-bit `mul_div`s whose inner `u128` divisions are libcalls on SBF.
 *
 * That cost is paid by users, not operators, on the hot path. Solana's default
 * limit is 200k CU per instruction; exceeding it is a hard failure, and getting
 * close to it forces every integrator to attach a `ComputeBudgetProgram`
 * instruction, which is a real composability tax.
 *
 * The refactor was shipped on an *estimate* of 15-40k CU. This suite replaces
 * the estimate with measurements and pins them, so a regression in the math or
 * an extra CPI on the hot path fails CI instead of surfacing in production.
 *
 * ## Reading the numbers
 *
 * `rpow`'s cost scales with `log2(elapsed)`, so a 90-day window is only ~3
 * iterations more expensive than a 7-day one — the window length is a weak
 * lever. Branch 2 of `compute_multiplier` (active window closed, successor
 * running) invokes `rpow` twice and is the worst case.
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
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
  simulateTx,
} from "../shared/bankrun";
import { ratePerSecondForApy } from "@okumoney/yield-tooling";

const { Keypair } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const DAY = 86_400;

/**
 * Ceiling for a single user-facing instruction.
 *
 * Deliberately well under Solana's 200k default: an instruction that needs
 * most of the default budget cannot be composed with anything else in the same
 * transaction, which for a stablecoin PSM (routed through aggregators, wrapped
 * by vaults) is close to unusable. 100k leaves room for a CPI wrapper.
 */
const USER_PATH_CU_CEILING = 100_000;

/**
 * Ceiling for the permissionless display crank.
 *
 * Not user-facing and composes with nothing, so it only has to fit Solana's
 * 200k default on its own. It was ~104k when the mirror pre-armed a second
 * step; dropping the pre-arm (one `compute_multiplier`, one CPI) roughly halved
 * it, so the ceiling is tightened accordingly rather than left slack.
 */
const CRANK_CU_CEILING = 80_000;

describe("compute budget (streaming accrual hot paths)", () => {
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

  /** Collected for the summary table printed at the end. */
  const measurements: Array<{ label: string; cu: number }> = [];

  const record = (label: string, cu: number) => {
    measurements.push({ label, cu });
  };

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
    await ensurePSMUnpaused(psm, psmConfigPda);
  });

  after(() => {
    if (measurements.length === 0) return;
    const w = Math.max(...measurements.map((m) => m.label.length));
    // eslint-disable-next-line no-console
    console.log("\n  compute units consumed");
    for (const m of measurements) {
      // eslint-disable-next-line no-console
      console.log(`    ${m.label.padEnd(w)}  ${String(m.cu).padStart(7)}`);
    }
    // eslint-disable-next-line no-console
    console.log(`    ${"(ceiling)".padEnd(w)}  ${String(USER_PATH_CU_CEILING).padStart(7)}\n`);
  });

  const nowTs = async (): Promise<number> => Number((await getClock(h)).unixTimestamp);

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

  const seedBuffer = async () => {
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
  };

  const mintTx = async () =>
    psm.methods
      .mintOkuM(new BN(1_000_000))
      .accountsPartial({
        user: user.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMMint,
        userUsdcAta,
        userOkuMAta,
        vaultUsdc: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .transaction();

  const measureMint = async (label: string): Promise<number> => {
    const sim = await simulateTx(h, await mintTx(), [user]);
    expect(sim.error, `${label}: simulation failed`).to.be.null;
    record(label, sim.computeUnits);
    return sim.computeUnits;
  };

  // -------------------------------------------------------------------
  // Window length: rpow scales with log2(elapsed), so this is a weak lever
  // -------------------------------------------------------------------

  for (const days of [7, 30, 90]) {
    it(`mint_oku_m stays under budget with a ${days}-day window`, async () => {
      const start = await nowTs();
      await setRate(ratePerSecondForApy(0.05), start + days * DAY);
      await seedBuffer();
      // Sit most of the way through the window so `elapsed` is large.
      await warpBy(h, Math.floor(days * DAY * 0.9));

      const cu = await measureMint(`mint_oku_m (${days}d window)`);
      expect(cu).to.be.lessThan(USER_PATH_CU_CEILING);
    });
  }

  // -------------------------------------------------------------------
  // Worst case: branch 2 runs rpow TWICE
  // -------------------------------------------------------------------

  it("mint_oku_m stays under budget in the two-rpow overhang branch", async () => {
    const start = await nowTs();
    // Active window closes; successor runs on. Evaluating the multiplier then
    // compounds to `rateEnd` AND across the overhang — two rpow invocations.
    await setRateWithSuccessor(
      ratePerSecondForApy(0.05),
      start + 30 * DAY,
      ratePerSecondForApy(0.08),
      start + 90 * DAY,
    );
    await seedBuffer();
    await warpBy(h, 60 * DAY); // past rateEnd, inside the successor's window

    const cu = await measureMint("mint_oku_m (branch 2, 2x rpow)");
    expect(cu).to.be.lessThan(USER_PATH_CU_CEILING);
  });

  it("redeem_oku_m stays under budget in the two-rpow overhang branch", async () => {
    const start = await nowTs();
    await setRateWithSuccessor(
      ratePerSecondForApy(0.05),
      start + 30 * DAY,
      ratePerSecondForApy(0.08),
      start + 90 * DAY,
    );
    await seedBuffer();
    await mintOkuMViaProgram(
      psm,
      user,
      new BN(10_000_000),
      psmConfigPda,
      usdcMint,
      okuMMint,
      userUsdcAta,
      userOkuMAta,
      vaultUsdcAta,
    );
    await warpBy(h, 60 * DAY);

    const tx = await psm.methods
      .redeemOkuM(new BN(1_000_000), new BN(0))
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
      .transaction();
    const sim = await simulateTx(h, tx, [user]);
    expect(sim.error, "redeem simulation failed").to.be.null;
    record("redeem_oku_m (branch 2, 2x rpow)", sim.computeUnits);
    expect(sim.computeUnits).to.be.lessThan(USER_PATH_CU_CEILING);
  });

  // -------------------------------------------------------------------
  // The piggyback: isolating what the opportunistic display sync costs
  // -------------------------------------------------------------------

  it("mint cost does not depend on display staleness (piggyback is gone)", async () => {
    const start = await nowTs();
    await setRate(ratePerSecondForApy(0.05), start + 30 * DAY);
    await seedBuffer();

    await psm.methods
      .syncDisplayMultiplier()
      .accountsPartial({
        cranker: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();
    // Warp FIRST, so both measurements below share the same `elapsed` and
    // therefore the same rpow iteration count. Comparing a fresh-display mint
    // against a stale-display mint at different points in time would confound
    // display staleness with rpow cost, which grows with elapsed time --
    // an earlier version of this test did exactly that and measured a 10k
    // delta that had nothing to do with the display.
    await warpBy(h, 600);
    const stale = await measureMint("mint_oku_m (display stale)");

    await psm.methods
      .syncDisplayMultiplier()
      .accountsPartial({
        cranker: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();
    const fresh = await measureMint("mint_oku_m (display fresh, same elapsed)");

    const delta = Math.abs(stale - fresh);
    expect(
      delta,
      `mint cost moved by ${delta} CU with display staleness — the user path ` +
        "must not touch the display mirror at all",
    ).to.be.lessThan(500);

    expect(stale).to.be.lessThan(USER_PATH_CU_CEILING);
  });

  // -------------------------------------------------------------------
  // Operator paths — not user-facing, but worth tracking
  // -------------------------------------------------------------------

  it("measures the operator and crank paths", async () => {
    const start = await nowTs();

    const rateTx = await psm.methods
      .setOkumYieldRateWithSuccessor(
        new BN(ratePerSecondForApy(0.05).toString()),
        new BN(start + 30 * DAY),
        new BN(ratePerSecondForApy(0.08).toString()),
        new BN(start + 90 * DAY),
      )
      .accountsPartial({ rebaser: orchestrator.publicKey, config: psmConfigPda })
      .transaction();
    const rateSim = await simulateTx(h, rateTx, [orchestrator]);
    expect(rateSim.error).to.be.null;
    record("set_okum_yield_rate_with_successor", rateSim.computeUnits);

    await setRateWithSuccessor(
      ratePerSecondForApy(0.05),
      start + 30 * DAY,
      ratePerSecondForApy(0.08),
      start + 90 * DAY,
    );
    await warpBy(h, 60 * DAY);

    const syncTx = await psm.methods
      .syncDisplayMultiplier()
      .accountsPartial({
        cranker: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .transaction();
    const syncSim = await simulateTx(h, syncTx, [orchestrator]);
    expect(syncSim.error).to.be.null;
    record("sync_display_multiplier (1 CPI)", syncSim.computeUnits);

    // The crank is permissionless and runs ~1440x/day. It is measured in the
    // two-rpow overhang branch here, which is its worst case.
    expect(syncSim.computeUnits).to.be.lessThan(CRANK_CU_CEILING);
  });
});
