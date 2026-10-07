/**
 * Compute-unit budget for the streaming-accrual paths.
 *
 * ## Why this suite exists
 *
 * The multiplier is *computed* on every mint and every redeem:
 * `compute_multiplier` runs `rpow`, which is exponentiation by squaring over
 * ~20-25 iterations depending on the window length, each iteration costing two
 * 256-bit `mul_div`s whose inner `u128` divisions are libcalls on SBF.
 *
 * That cost is paid by users, not operators, on the hot path. Solana's default
 * limit is 200k CU per instruction; exceeding it is a hard failure, and getting
 * close to it forces every integrator to attach a `ComputeBudgetProgram`
 * instruction, which is a real composability tax.
 *
 * This suite pins measured costs, so a regression in the math or an extra CPI
 * on the hot path fails CI instead of surfacing in production.
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
 * Ceiling for a single user-facing instruction on the WARM path (the mint/
 * redeem ATA already exists).
 *
 * Deliberately well under Solana's 200k default: an instruction that needs
 * most of the default budget cannot be composed with anything else in the same
 * transaction, which for a stablecoin PSM (routed through aggregators, wrapped
 * by vaults) is close to unusable. 100k leaves room for a CPI wrapper. Warm
 * mint/redeem sit at ~49k-74k, comfortably inside this — see
 * `COLD_PATH_CU_CEILING` below for the one branch that doesn't fit it.
 */
const USER_PATH_CU_CEILING = 100_000;

/**
 * Ceiling for mint_oku_m on a COLD ATA (first-time minter) in the two-rpow
 * branch — the measured worst case or close to it.
 *
 * Measured at ~98.6k-107.6k CU across runs, straddling `USER_PATH_CU_CEILING`.
 * The dominant costs are the ATA-program CPI + rent-exempt allocation
 * (intrinsic to `init_if_needed`) and `rpow`'s bit-pattern-dependent cost.
 * 150k keeps proportional headroom under Solana's 200k hard limit.
 */
const COLD_PATH_CU_CEILING = 150_000;

/**
 * Ceiling for the permissionless display crank.
 *
 * Not user-facing and composes with nothing, so it only has to fit Solana's
 * 200k default on its own. The crank does one `compute_multiplier` and one
 * CPI; the ceiling is set tight to that rather than left slack.
 */
const CRANK_CU_CEILING = 80_000;

/**
 * Ceiling for operator-only instructions (rate schedule writes).
 *
 * These are submitted by the orchestrator alone, never composed, and run at
 * most twice per epoch. The bound exists so a regression surfaces, not because
 * the budget is tight -- schedule writes do no `rpow` beyond a single re-anchor.
 */
const OPERATOR_PATH_CU_CEILING = 30_000;

/**
 * Solana's default per-instruction compute limit. The hard constraint.
 */
const SOLANA_DEFAULT_CU_LIMIT = 200_000;

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
  // The user path must not touch the display mirror
  // -------------------------------------------------------------------

  it("mint cost does not depend on display staleness", async () => {
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
    // display staleness with rpow cost, which grows with elapsed time.
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
  // Cold ATA: the path that actually threatens the ceiling
  // -------------------------------------------------------------------

  /**
   * `MintOkuM.user_oku_m_ata` is `init_if_needed` (contexts/psm.rs), so a
   * first-time minter pays an ATA-program CPI plus a rent-exempt allocation on
   * top of the accrual math. See `COLD_PATH_CU_CEILING`'s doc comment for why
   * this path has its own ceiling.
   *
   * EVERY OTHER MEASUREMENT IN THIS FILE IS THE WARM PATH: `beforeEach` calls
   * `ensureAtaViaBankrun` for the shared `user`, so `init_if_needed` is a
   * no-op in them.
   *
   * A fresh keypair with no okuM ATA exercises it.
   */
  it("mint_oku_m stays under budget on a COLD ATA in the two-rpow branch", async () => {
    // THE TRUE WORST CASE: a first-time minter arriving during the overhang,
    // so the instruction pays the ATA creation AND runs `rpow` twice. Measuring
    // the cold ATA against a simple window would understate it.
    const start = await nowTs();
    await setRateWithSuccessor(
      ratePerSecondForApy(0.05),
      start + 30 * DAY,
      ratePerSecondForApy(0.08),
      start + 90 * DAY,
    );
    await seedBuffer();
    await warpBy(h, 60 * DAY); // past rateEnd, inside the successor's window

    const newcomer = Keypair.generate();
    await fundKeypairs(h, [newcomer], 10 * anchor.web3.LAMPORTS_PER_SOL);
    const newcomerUsdcAta = await ensureAtaViaBankrun(
      h, newcomer.publicKey, usdcMint, TOKEN_PROGRAM_ID,
    );
    await mintToViaBankrun(h, usdcMint, newcomerUsdcAta, payer, 10_000_000, TOKEN_PROGRAM_ID);

    // Deliberately NOT pre-created — this is the whole point of the test.
    const newcomerOkuMAta = getAssociatedTokenAddressSync(
      okuMMint, newcomer.publicKey, false, TOKEN_2022_PROGRAM_ID,
    );
    // `banksClient.getAccount` returns null for a missing account; the
    // connection proxy throws, so use the client directly.
    expect(
      await h.context.banksClient.getAccount(newcomerOkuMAta),
      "fixture: the okuM ATA must NOT exist, or this measures the warm path",
    ).to.be.null;

    const coldTx = await psm.methods
      .mintOkuM(new BN(1_000_000))
      .accountsPartial({
        user: newcomer.publicKey,
        config: psmConfigPda,
        usdcMint,
        okuMMint,
        userUsdcAta: newcomerUsdcAta,
        userOkuMAta: newcomerOkuMAta,
        vaultUsdc: vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .transaction();

    const sim = await simulateTx(h, coldTx, [newcomer]);
    expect(sim.error, "cold-ATA mint simulation failed").to.be.null;
    record("mint_oku_m (COLD ATA, branch 2)", sim.computeUnits);

    // The precondition above is what guarantees this is the cold path --
    // `simulateTx` does not commit, so the ATA is still absent afterwards.
    //
    // Run-to-run spread is expected: `rpow`'s cost depends on the BIT PATTERN
    // of `elapsed`, and bankrun's start clock is wall-clock derived. No lower
    // bound — a floor would pin the absence of a future optimisation.
    expect(
      sim.computeUnits,
      "cold-ATA mint must still fit Solana's default compute limit",
    ).to.be.lessThan(SOLANA_DEFAULT_CU_LIMIT);
    expect(
      sim.computeUnits,
      "cold-ATA mint must fit the cold-path target -- if this regresses, " +
        "check for new deserializations/CPIs added to the mint path before " +
        "concluding `rpow`'s variance just got unlucky",
    ).to.be.lessThan(COLD_PATH_CU_CEILING);
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
    // Asserted, not merely recorded, so an order-of-magnitude regression on
    // the operator path fails the suite.
    expect(rateSim.computeUnits).to.be.lessThan(OPERATOR_PATH_CU_CEILING);

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
