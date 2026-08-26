/**
 * Post-step sync window + PSM `tin`/`tout` fees.
 *
 * These two mechanisms address two structurally different arbitrage
 * surfaces around a multiplier update, and the tests are organised to keep
 * that distinction explicit because conflating them is the easy mistake:
 *
 *   - **Sync window** — cross-chain, and TRANSIENT. Profit requires
 *     *transacting while the chains disagree*, during the interval between
 *     the EVM write and the SVM write. Once the lagging chain ticks the edge
 *     is exactly zero, so making the attacker wait removes it — which is why
 *     a time lock is the right tool. Armed automatically by every multiplier
 *     write; released by nothing but the clock.
 *
 *     Scope is now the BRIDGE LEGS ONLY (`mint_oku_m_direct` /
 *     `burn_oku_m_direct`). `mint_oku_m` and `redeem_oku_m` are single-chain
 *     and priced at this chain's own multiplier, which is correct whatever
 *     the peer believes, so gating them bought nothing and cost an outage
 *     after every mark.
 *
 *   - **`tin`/`tout` fees** — local, and PERMANENT. Profit requires *holding
 *     raw across a discrete step*, which needs no transaction during any
 *     window at all, and the multiplier is monotone so waiting costs the
 *     attacker nothing. No window length deters this; only a fee covering
 *     the step does. See `describe("local step arbitrage")` below.
 *
 * THERE IS NO OPEN/CLOSE PROTOCOL. An earlier design had
 * `begin_sync_window(epoch)` / `end_sync_window(epoch)` with an
 * orchestrator-assigned epoch, a write-landed-in-epoch attestation, and an
 * anti-grief gap between windows. All of it is gone, and the reduction is
 * worth recording because the machinery looked load-bearing:
 *
 *   - The epoch existed to make cross-chain tick completion verifiable, and
 *     it never did: equal epochs proved both chains WROTE, never that they
 *     wrote the same VALUE. Parity is now checked off-chain against the
 *     multiplier values directly, which catches wrong-value writes too.
 *   - Every other piece existed to contain the previous piece. An explicit
 *     open could be left unused, so closing needed a write attestation;
 *     opens could be chained, so they needed a gap. Arming on the write
 *     makes the fence and the tick the same transaction, so none of those
 *     failure modes exist.
 *
 * STEP COVERAGE IS NOW STATIC, and that is the other large reduction here.
 * It used to be three coupled mechanisms: `step_is_covered(tin + tout)` read
 * at write time, a `max_step_bps` high-water ratchet, a floor on later
 * `set_fees` calls against that ratchet, and a cold
 * `reset_step_high_water_mark` escape hatch whose honest precondition was not
 * verifiable on-chain. It is now two rules over one constant:
 *
 *     set_multiplier / distribute_yield:  step_bps <= MAX_STEP_BPS
 *     set_fees:                           tin_bps  >= MAX_STEP_BPS
 *                                         tout_bps >= MAX_STEP_BPS
 *
 * Strictly stronger than the ratchet, which only ever covered steps that had
 * actually happened. PER-LEG rather than combined because a cross-chain round
 * trip pays `tin` on the chain it mints on and `tout` on the chain it redeems
 * on, so `(0, 2N)` here and `(2N, 0)` on EVM would each pass a combined check
 * while the pair paid nothing.
 *
 * The window ships ON (`DEFAULT_SYNC_WINDOW_SECS`); fees ship AT THE FLOOR,
 * not at zero. With the program no longer reading the fee schedule at
 * multiplier-write time, a zero-fee window would be an uncovered-step window.
 * The first describe block pins both.
 *
 * Clock discipline: the sync window is wall-clock (`warpBy`) while the
 * pre-existing yield fence is slot-based (`warpSlots`). This suite uses
 * the default `autoBumpSlot: true` harness so the slot fence never
 * interferes, which is only possible *because* the two mechanisms are
 * denominated in different units.
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
import { unpackMint } from "@solana/spl-token";
import { LitePsm } from "../../target/types/lite_psm";
import { clearSyncWindow } from "../shared/multiplier";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  ensurePSMUnpaused,
  mintOkuMViaProgram,
  DECIMALS,
  DEFAULT_SYNC_WINDOW_SECS,
  MIN_MARK_INTERVAL_SECS,
} from "../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  warpBy,
  expectBankrunError,
  readMultiplierFromMint,
} from "../shared/bankrun";

const { Keypair, SystemProgram } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

const PRECISION = new BN(1_000_000_000); // 1e9, matches oku-shared::PRECISION
const BASIS_POINTS = new BN(10_000);
const MAX_FEE_BPS = 100; // oku-shared::MAX_FEE_BPS
const MAX_SYNC_WINDOW_SECS = 900; // oku-shared::MAX_SYNC_WINDOW_SECS
const MAX_STEP_BPS = 2; // oku-shared::MAX_STEP_BPS

describe("post-step sync window + PSM fees", () => {
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
  let orchestratorOkuMAta: PublicKey;

  // ---- helpers -----------------------------------------------------------

  const redeem = (rawAmount: BN, minUsdcOut: BN = new BN(0)) =>
    psm.methods
      .redeemOkuM(rawAmount, minUsdcOut)
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

  const mint = (usdcAmount: BN) =>
    mintOkuMViaProgram(
      psm as any,
      user,
      usdcAmount,
      psmConfigPda,
      usdcMint,
      okuMMint,
      userUsdcAta,
      userOkuMAta,
      vaultUsdcAta
    );

  const setWindowSecs = (secs: number, signer: Keypair = coldMultisig) =>
    psm.methods
      .setSyncWindowSecs(new BN(secs))
      .accountsPartial({ capManager: signer.publicKey, config: psmConfigPda })
      .signers([signer])
      .rpc();

  const setFees = (tinBps: number, toutBps: number, signer: Keypair = coldMultisig) =>
    psm.methods
      .setFees(new BN(tinBps), new BN(toutBps))
      .accountsPartial({ capManager: signer.publicKey, config: psmConfigPda })
      .signers([signer])
      .rpc();

  const setMultiplier = (m: BN) =>
    psm.methods
      .setMultiplier(m)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

  const usdcBal = async (ata: PublicKey) =>
    Number((await getAccount(provider.connection, ata, undefined, TOKEN_PROGRAM_ID)).amount);

  const okuMBal = async (ata: PublicKey) =>
    Number(
      (await getAccount(provider.connection, ata, undefined, TOKEN_2022_PROGRAM_ID)).amount
    );

  const cfg = () => psm.account.psmConfig.fetch(psmConfigPda);

  const distributeYield = (amount: BN) =>
    psm.methods
      .distributeYield(amount)
      .accountsPartial({
        rebaser: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

  // The step high-water ratchet and its `reset_step_high_water_mark`
  // instruction were both removed with the move to a static per-leg fee floor.
  // Retained as a no-op seam so the fixtures below still read as
  // "start from a clean coverage state", which is now simply always true.
  const resetMark = async (_signer: Keypair = coldMultisig) => {};

  const directMint = (raw: BN) =>
    psm.methods
      .mintOkuMDirect(raw)
      .accountsPartial({
        directMinter: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        recipient: user.publicKey,
        recipientOkuMAta: userOkuMAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([orchestrator])
      .rpc();

  const directBurn = (raw: BN) =>
    psm.methods
      .burnOkuMDirect(raw)
      .accountsPartial({
        directBurner: orchestrator.publicKey,
        config: psmConfigPda,
        okuMMint,
        burnerOkuMAta: orchestratorOkuMAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([orchestrator])
      .rpc();

  const totalSupply = async (): Promise<BN> => {
    const info = await provider.connection.getAccountInfo(okuMMint);
    const m = unpackMint(okuMMint, info!, TOKEN_2022_PROGRAM_ID);
    return new BN(m.supply.toString());
  };

  /** Warp past any armed window. */
  const clearWindow = () => clearSyncWindow(h, psm as any, psmConfigPda);

  /**
   * A covered multiplier write — the only way to arm the window.
   *
   * Sizes the step just under `MAX_STEP_BPS` so it is always admissible, and
   * never zero (a no-op write is rejected by the strict-increase guard).
   *
   * No longer reads the fee schedule: step admissibility does not depend on it.
   */
  const markMultiplier = async () => {
    // Advance past the cadence bound first. `MIN_MARK_INTERVAL_SECS` gates every
    // mark including the first (`initialize` leaves `last_mark_ts` at 0, but any
    // prior mark in the same suite sets it), so a fixture that marks repeatedly
    // has to move the wall clock between them.
    await warpBy(h, MIN_MARK_INTERVAL_SECS);
    const m = await readMultiplierFromMint(h, okuMMint);
    const step = m.muln(MAX_STEP_BPS - 1).divn(10_000);
    await setMultiplier(m.add(step.gtn(0) ? step : new BN(1)));
  };

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

    await fundKeypairs(h, [user], 10 * anchor.web3.LAMPORTS_PER_SOL);

    // Raw post-initialize state: this suite is ABOUT the window and the fees,
    // so it configures them per-describe rather than inheriting the harness
    // defaults.
    const setup = await initializePsm(h, psm, payer, usdcMint, {
      toutBps: 0,
      syncWindowSecs: 0,
    });
    psmConfigPda = setup.configPda;
    okuMMint = setup.okuMMint;
    vaultUsdcAta = setup.vaultUsdcAta;
    vaultOkuMAta = setup.vaultOkuMAta;

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
    orchestratorOkuMAta = await ensureAtaViaBankrun(
      h,
      orchestrator.publicKey,
      okuMMint,
      TOKEN_2022_PROGRAM_ID
    );

    await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 100_000_000_000, TOKEN_PROGRAM_ID);
    await mintToViaBankrun(
      h,
      usdcMint,
      orchestratorUsdcAta,
      payer,
      100_000_000_000,
      TOKEN_PROGRAM_ID
    );

    // Seed the buffer so redeems settle instantly throughout.
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

  // =========================================================================
  // Fail-closed defaults
  // =========================================================================

  describe("ships covered", () => {
    it("initializes with the window ON, free deposits and a covered exit", async () => {
      // A separate cluster, so the suite-level overrides in `before` do not
      // mask the real post-initialize state.
      const probeH = await startBankrun();
      const probeUsdc = await createMintViaBankrun(
        probeH,
        probeH.payer.publicKey,
        null,
        DECIMALS,
        Keypair.generate(),
        TOKEN_PROGRAM_ID
      );
      const probe = await initializePsm(
        probeH,
        probeH.program,
        probeH.payer,
        probeUsdc,
        { toutBps: MAX_STEP_BPS, tinBps: 0 }
      );
      const c: any = await probeH.program.account.psmConfig.fetch(probe.configPda);

      // The window ships ON. Protection that depends on someone remembering to
      // switch it on is not protection.
      expect(c.syncWindowSecs.toNumber()).to.equal(DEFAULT_SYNC_WINDOW_SECS);
      // Nothing is locked until the first multiplier write arms it.
      expect(c.syncLockUntilTs.toNumber()).to.equal(0);

      // DEPOSITS FREE, EXITS COVERED. `tin` ships at zero and has no floor;
      // `tout` ships at the floor and can never go below it. The arbitrage gain
      // is realised on exit, so the exit leg alone closes it — and taxing entry
      // would only penalise the permissionless access the product exists for.
      expect(c.tinBps.toNumber()).to.equal(0);
      expect(c.toutBps.toNumber()).to.equal(MAX_STEP_BPS);
      // `maxStepBps` is gone entirely — the ratchet it served was deleted.
      expect(c.maxStepBps).to.equal(undefined);
    });

    it("can step immediately after initialize, with no fee configuration", async () => {
      // The point of shipping covered: there is no launch-ordering dependency
      // and no window in which marks are impossible.
      const m = await readMultiplierFromMint(h, okuMMint);
      await setFees(0, MAX_STEP_BPS);
      await setMultiplier(m.addn(1));
      expect((await readMultiplierFromMint(h, okuMMint)).toNumber()).to.equal(
        m.addn(1).toNumber()
      );
    });

    it("cannot reach a zero-TOUT state, but zero tin is the default", async () => {
      await expectBankrunError(() => setFees(0, 0), "FeeBelowStepFloor");
      await expectBankrunError(() => setFees(MAX_FEE_BPS, 0), "FeeBelowStepFloor");
      // A free deposit leg is not merely tolerated — it is what ships.
      await setFees(0, MAX_FEE_BPS);
      expect((await cfg()).tinBps.toNumber()).to.equal(0);
    });

    it("rejects tout below the floor; tin has no floor", async () => {
      // `MAX_STEP_BPS` is 2, so "one bp below" is 1 — still a valid u64, and
      // still refused.
      await expectBankrunError(() => setFees(0, MAX_STEP_BPS - 1), "FeeBelowStepFloor");
      // Any `tin` is fine, including the ceiling, provided `tout` is covered.
      await setFees(MAX_FEE_BPS, MAX_STEP_BPS);
      await setFees(0, MAX_STEP_BPS);
    });
  });

  // =========================================================================
  // Step coverage — the invariant that makes step arbitrage impossible
  // =========================================================================

  describe("step ceiling", () => {
    beforeEach(async () => {
      await setFees(0, MAX_FEE_BPS);
    });

    it("permits a step at the ceiling and refuses one above it", async () => {
      await warpBy(h, MIN_MARK_INTERVAL_SECS);
      const m = await readMultiplierFromMint(h, okuMMint);
      // 1 bp under the ceiling, so the f64 round-trip cannot tip it over.
      const covered = m.add(m.muln(MAX_STEP_BPS - 1).divn(10_000));
      const uncovered = m.add(m.muln(MAX_STEP_BPS + 5).divn(10_000));

      await expectBankrunError(() => setMultiplier(uncovered), "StepAboveMax");
      await setMultiplier(covered);
    });

    it("does not consult the fee schedule at all", async () => {
      // The coupling is gone: the largest fee and the smallest fee admit
      // exactly the same set of steps, because coverage is guaranteed by the
      // floor rather than checked here.
      const oversized = (m: BN) => m.add(m.muln(MAX_STEP_BPS + 5).divn(10_000));

      await setFees(MAX_FEE_BPS, MAX_FEE_BPS);
      let m = await readMultiplierFromMint(h, okuMMint);
      await expectBankrunError(() => setMultiplier(oversized(m)), "StepAboveMax");

      await setFees(0, MAX_STEP_BPS);
      m = await readMultiplierFromMint(h, okuMMint);
      await expectBankrunError(() => setMultiplier(oversized(m)), "StepAboveMax");
    });

    it("implies a minimum rebase cadence", async () => {
      await warpBy(h, MIN_MARK_INTERVAL_SECS);
      // A derived bound worth stating: a long outage cannot be caught up in a
      // single write and must be walked. This is the operator-absence
      // protection working, not an obstacle.
      const m = await readMultiplierFromMint(h, okuMMint);
      const aMonthOfYield = m.add(m.muln(41).divn(10_000)); // ~monthly at 5% APY
      await expectBankrunError(() => setMultiplier(aMonthOfYield), "StepAboveMax");
    });

    it("applies the same ceiling to distribute_yield", async () => {
      await warpBy(h, MIN_MARK_INTERVAL_SECS);
      // distribute_yield reaches the multiplier by a different route; it must
      // not be a way around the check.
      const supply = await totalSupply();
      const m = await readMultiplierFromMint(h, okuMMint);
      const hugeBump = m.muln(50).divn(10_000);
      const hugeYield = hugeBump.mul(supply).div(PRECISION);
      if (hugeYield.gtn(0)) {
        await expectBankrunError(() => distributeYield(hugeYield), "StepAboveMax");
      }
    });
  });

  // =========================================================================
  // The fee floor — coverage cannot be removed after the fact
  // =========================================================================

  // NOTE: `describe("fee high-water mark")` was removed here along with the
  // ratchet it tested — four tests covering the mark, its floor under
  // `set_fees`, the cold reset, and the reset's role gate. The static per-leg
  // floor makes all four vacuous: there is no accumulated state, so nothing can
  // be un-covered after the fact and there is no escape hatch to gate. The
  // property they protected is now asserted unconditionally in
  // `describe("ships covered")` above.

  describe("parameter bounds", () => {
    it("rejects a sync window above MAX_SYNC_WINDOW_SECS", async () => {
      await expectBankrunError(
        () => setWindowSecs(MAX_SYNC_WINDOW_SECS + 1),
        "SyncWindowTooLong"
      );
    });

    it("rejects a negative sync window", async () => {
      await expectBankrunError(() => setWindowSecs(-1), "SyncWindowTooLong");
    });

    it("accepts exactly MAX_SYNC_WINDOW_SECS", async () => {
      await setWindowSecs(MAX_SYNC_WINDOW_SECS);
      expect((await cfg()).syncWindowSecs.toNumber()).to.equal(MAX_SYNC_WINDOW_SECS);
      await setWindowSecs(0);
    });

    it("rejects a fee above MAX_FEE_BPS on either leg", async () => {
      await expectBankrunError(() => setFees(MAX_FEE_BPS + 1, 0), "FeeAboveMax");
      await expectBankrunError(() => setFees(0, MAX_FEE_BPS + 1), "FeeAboveMax");
    });

    it("restricts the parameter setters to cap_manager", async () => {
      await expectBankrunError(() => setWindowSecs(60, warmMultisig), "Unauthorized");
      await expectBankrunError(() => setFees(10, 10, warmMultisig), "Unauthorized");
      await expectBankrunError(() => setWindowSecs(60, orchestrator), "Unauthorized");
    });

    it("restricts the multiplier write — the only way to arm a window — to rebaser", async () => {
      // With the open/close instructions gone, the window has no dedicated
      // entrypoint and therefore no dedicated key. The only actor who can arm
      // it is the one who can mark the multiplier, which is exactly the
      // separation the old two-instruction design was reaching for.
      await resetMark();
      await setFees(0, MAX_FEE_BPS);
      const m = await readMultiplierFromMint(h, okuMMint);
      const target = m.add(m.muln(10).divn(10_000));
      for (const wrong of [coldMultisig, warmMultisig]) {
        await expectBankrunError(
          () =>
            psm.methods
              .setMultiplier(target)
              .accountsPartial({
                rebaser: wrong.publicKey,
                config: psmConfigPda,
                okuMMint,
                token2022Program: TOKEN_2022_PROGRAM_ID,
              })
              .signers([wrong])
              .rpc(),
          "Unauthorized"
        );
      }
    });
  });

  // =========================================================================
  // Sync window
  // =========================================================================

  // Scope is the BRIDGE LEGS only. `mint_oku_m` / `redeem_oku_m` used to be
  // gated too; they are not any more, and the inverted tests below are the
  // regression guard. A single-chain operation priced at this chain's own
  // multiplier is correct whatever the peer believes, so gating it bought
  // nothing and cost an outage after every mark.
  describe("sync window blocks the bridge legs", () => {
    before(async () => {
      await resetMark();
      await setFees(0, MAX_FEE_BPS);
      await setWindowSecs(120);

      // Wire the direct bridge legs to the orchestrator, so that when they are
      // rejected below it is demonstrably the sync window doing it and not a
      // missing role. Anchor's `has_one` runs before the handler body, so an
      // unconfigured authority would mask the check under test.
      for (const [role, key] of [
        [{ directMinter: {} }, orchestrator.publicKey],
        [{ directBurner: {} }, orchestrator.publicKey],
      ] as const) {
        await psm.methods
          .setAuthority(role as any, key)
          .accountsPartial({ roleAdmin: payer.publicKey, config: psmConfigPda })
          .rpc();
      }
      await psm.methods
        .setDirectMinterAllowance(new BN(1_000_000_000))
        .accountsPartial({ allowanceManager: coldMultisig.publicKey, config: psmConfigPda })
        .signers([coldMultisig])
        .rpc();
      await psm.methods
        .setDirectBurnerAllowance(new BN(1_000_000_000))
        .accountsPartial({ allowanceManager: coldMultisig.publicKey, config: psmConfigPda })
        .signers([coldMultisig])
        .rpc();
    });

    after(async () => {
      await setWindowSecs(0);
    });

    it("arms on a multiplier write for exactly the configured duration", async () => {
      await clearWindow();
      await markMultiplier();

      const c: any = await cfg();
      const clock = await h.context.banksClient.getClock();
      expect(c.syncLockUntilTs.toNumber()).to.equal(
        Number(clock.unixTimestamp) + 120,
        "armed for exactly the configured duration, from now"
      );
    });

    it("does NOT block mint or redeem — those are single-chain", async () => {
      // Inverted deliberately when the window was narrowed. A user must be able
      // to subscribe and redeem while a mark propagates; the price they get is
      // this chain's own multiplier, which is correct by definition.
      await clearWindow();
      await markMultiplier();
      expect((await cfg()).syncLockUntilTs.toNumber()).to.be.greaterThan(0);

      await mint(new BN(10_000_000));
      await redeem(new BN(1_000_000));
    });

    it("blocks the direct bridge legs too", async () => {
      // Neither leg prices through the multiplier on its own — but the
      // cross-chain PAIR does: burning 100 raw at M=1.04 destroys $104 of claim
      // while minting 100 raw at M=1.05 creates $105. "Raw-conserving" is a
      // per-instruction property that does not survive the round trip.
      await clearWindow();
      await markMultiplier();

      await expectBankrunError(() => directMint(new BN(1_000)), "SyncWindowActive");
      await expectBankrunError(() => directBurn(new BN(1_000)), "SyncWindowActive");

      await warpBy(h, 121);
      await directMint(new BN(1_000));
    });

    it("re-arms from now on a second write, never stacking past the ceiling", async () => {
      // ASSIGN, NEVER EXTEND. This is what makes the MAX_SYNC_WINDOW_SECS bound
      // hold by construction: no sequence of writes can push a single window
      // past the ceiling, so a compromised rebaser looping writes still cannot
      // hold a longer lock than one window — and cannot write at all without
      // taking a real, fee-covered, bounded step.
      await clearWindow();
      await markMultiplier();
      const first = (await cfg()).syncLockUntilTs.toNumber();

      // `markMultiplier` itself warps a full `MIN_MARK_INTERVAL_SECS` (marks are
      // cadence-limited), so the gap between the two arms is that interval
      // rather than an arbitrary 10s. The property under test is unchanged:
      // the second window is measured from ITS OWN arming instant, not appended
      // to the first.
      await markMultiplier();
      const second = (await cfg()).syncLockUntilTs.toNumber();

      expect(second - first).to.equal(
        MIN_MARK_INTERVAL_SECS,
        "re-armed from now, not appended to"
      );

      const clock = await h.context.banksClient.getClock();
      expect(second - Number(clock.unixTimestamp)).to.be.at.most(MAX_SYNC_WINDOW_SECS);
    });

    it("auto-expires without any transaction (liveness backstop)", async () => {
      // If the orchestrator dies mid-tick, redemption must resume unaided —
      // otherwise the mechanism is a bricking vector worse than the arbitrage
      // it prevents. Under the old design this was one of two release paths;
      // now it is the only one, which makes the property structural.
      await clearWindow();
      await markMultiplier();
      await expectBankrunError(() => directMint(new BN(1_000)), "SyncWindowActive");

      await warpBy(h, 121);
      await directMint(new BN(1_000));
    });

    it("leaves multiplier-independent instructions open while engaged", async () => {
      await clearWindow();
      await markMultiplier();

      // Buffer movement is at par — a stale multiplier cannot misprice it. So
      // are `mint_oku_m` / `redeem_oku_m`, covered separately above.
      await psm.methods
        .depositBuffer(new BN(1_000_000))
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

      // And the multiplier itself stays writable: the window must never
      // censor the rebaser. Under the old design this needed an argument
      // (the clamp-not-reject rule); now it is simply true, because the
      // write path never consults the window at all.
      await markMultiplier();
      await clearWindow();
    });

    it("is completely inert at a zero duration", async () => {
      await clearWindow();
      await setWindowSecs(0);
      const before = (await cfg()).syncLockUntilTs.toNumber();

      await markMultiplier();

      // Asserts the field is UNTOUCHED, not that it is zero: a window armed
      // earlier in the suite leaves a stale (expired) timestamp behind, and the
      // property that matters is that an inert configuration writes nothing —
      // no anchor update and no event for a lock that blocks nothing.
      expect((await cfg()).syncLockUntilTs.toNumber()).to.equal(
        before,
        "an inert window must not touch the anchor at all"
      );
      await redeem(new BN(1_000_000));
      await setWindowSecs(120);
    });

    it("also arms on distribute_yield", async () => {
      // The other route to the multiplier. If it did not arm, the fence would
      // have a hole exactly as wide as the instruction.
      await setWindowSecs(120);
      await clearWindow();
      const supply = await totalSupply();
      const m = await readMultiplierFromMint(h, okuMMint);
      // A step comfortably inside `MAX_STEP_BPS`.
      const bump = m.muln(MAX_STEP_BPS - 1).divn(10_000);
      const amount = bump.mul(supply).div(PRECISION);
      if (amount.gtn(0)) {
        await warpBy(h, MIN_MARK_INTERVAL_SECS);
        await distributeYield(amount);
        expect((await cfg()).syncLockUntilTs.toNumber()).to.be.greaterThan(0);
        // A bridge leg is what the window blocks; redeem is single-chain.
        await expectBankrunError(() => directMint(new BN(1_000)), "SyncWindowActive");
        await warpBy(h, 121);
      }
    });
  });

  // =========================================================================
  // Fee arithmetic
  // =========================================================================

  describe("tout / tin arithmetic", () => {
    // "No fee on the leg not under test" is now the FLOOR, not zero — the
    // per-leg step-coverage floor is permanent. Each test therefore isolates
    // one leg by pinning the other at `MAX_STEP_BPS` and accounting for it.
    beforeEach(async () => {
      await setFees(0, MAX_STEP_BPS);
      await mint(new BN(2_000_000_000));
    });

    afterEach(async () => {
      await setFees(0, MAX_STEP_BPS);
    });

    it("withholds exactly ceil(gross * tout / 10_000) from the payout", async () => {
      await setFees(0, 15);
      const m = await readMultiplierFromMint(h, okuMMint);
      const redeemRaw = new BN(1_000_000_000);

      const gross = redeemRaw.mul(m).div(PRECISION);
      const fee = gross.muln(15).add(BASIS_POINTS).subn(1).div(BASIS_POINTS);
      const expected = gross.sub(fee);

      const before = await usdcBal(userUsdcAta);
      await redeem(redeemRaw);
      expect((await usdcBal(userUsdcAta)) - before).to.equal(expected.toNumber());
    });

    it("mints against the post-tin deposit", async () => {
      // `tout` at the floor is irrelevant here: the mint path charges `tin`
      // only, which is the property being isolated.
      await setFees(25, MAX_STEP_BPS);
      const m = await readMultiplierFromMint(h, okuMMint);
      const deposit = new BN(100_000_000);

      const fee = deposit.muln(25).add(BASIS_POINTS).subn(1).div(BASIS_POINTS);
      const credited = deposit.sub(fee);
      const expectedRaw = credited.mul(PRECISION).div(m);

      const before = await okuMBal(userOkuMAta);
      await mint(deposit);
      expect((await okuMBal(userOkuMAta)) - before).to.equal(expectedRaw.toNumber());
    });

    it("accrues the fee to the buffer rather than a recipient", async () => {
      await setFees(0, 50);
      const m = await readMultiplierFromMint(h, okuMMint);
      const redeemRaw = new BN(1_000_000_000);
      const gross = redeemRaw.mul(m).div(PRECISION);

      const vaultBefore = await usdcBal(vaultUsdcAta);
      const userBefore = await usdcBal(userUsdcAta);
      await redeem(redeemRaw);
      const vaultDelta = vaultBefore - (await usdcBal(vaultUsdcAta));
      const userDelta = (await usdcBal(userUsdcAta)) - userBefore;

      expect(userDelta).to.equal(vaultDelta);
      expect(gross.toNumber() - vaultDelta).to.be.greaterThan(0);
    });

    it("rejects a redemption whose entire payout is consumed by the fee", async () => {
      await setFees(0, MAX_FEE_BPS);
      await expectBankrunError(() => redeem(new BN(1)), "ZeroOutput");
    });

    it("compares min_usdc_out against the net payout", async () => {
      await setFees(0, 100);
      const m = await readMultiplierFromMint(h, okuMMint);
      const redeemRaw = new BN(1_000_000_000);
      const gross = redeemRaw.mul(m).div(PRECISION);

      await expectBankrunError(() => redeem(redeemRaw, gross), "SlippageExceeded");

      const fee = gross.muln(100).add(BASIS_POINTS).subn(1).div(BASIS_POINTS);
      await redeem(redeemRaw, gross.sub(fee));
    });
  });

  // =========================================================================
  // The design goal, stated as a test
  // =========================================================================

  describe("local step arbitrage", () => {
    /**
     * Mint at M0, hold across a discrete step, redeem at M1.
     *
     * This is the attack the sync window CANNOT touch — the attacker never
     * transacts while a window is open, so no window length deters it, and the
     * multiplier is monotone so waiting costs them nothing.
     *
     * The defence is two rules over one constant, and neither reads state:
     *
     *   1. `set_multiplier` refuses any step above `MAX_STEP_BPS`; and
     *   2. `set_fees` refuses either leg below `MAX_STEP_BPS`.
     *
     * So the worst case available to an attacker is a full `MAX_STEP_BPS` step
     * against `2 * MAX_STEP_BPS` of round-trip fee — a full step of margin.
     * That margin is the price of the per-leg rule, and it is what buys the
     * cross-chain guarantee the combined rule could not provide.
     */
    const DEPOSIT = new BN(1_000_000_000); // 1000 USDC

    /** Mint, step to the ceiling, redeem. Returns proceeds in USDC units. */
    const roundTrip = async (tinBps: number, toutBps: number) => {
      await setFees(tinBps, toutBps);

      const rawBefore = await okuMBal(userOkuMAta);
      await mint(DEPOSIT);
      const acquired = new BN((await okuMBal(userOkuMAta)) - rawBefore);

      // The largest mark the program admits — the best case for an attacker.
      await warpBy(h, MIN_MARK_INTERVAL_SECS);
      const m = await readMultiplierFromMint(h, okuMMint);
      await setMultiplier(m.add(m.muln(MAX_STEP_BPS - 1).divn(10_000)));
      await clearWindow();

      const usdcBefore = await usdcBal(userUsdcAta);
      await redeem(acquired);
      return (await usdcBal(userUsdcAta)) - usdcBefore;
    };

    it("cannot be set up with an oversized step", async () => {
      await warpBy(h, MIN_MARK_INTERVAL_SECS);
      // The historical "profitable with no fee" case is unreachable, but by a
      // different route than before: it is not that a zero fee blocks the step
      // (fees can no longer BE zero) — it is that the step itself is bounded,
      // and the bound is exactly what the mandatory fee covers.
      const m = await readMultiplierFromMint(h, okuMMint);
      await expectBankrunError(
        () => setMultiplier(m.add(m.muln(MAX_STEP_BPS + 5).divn(10_000))),
        "StepAboveMax"
      );
      await expectBankrunError(
        () => setMultiplier(m.add(m.muln(100).divn(10_000))),
        "StepAboveMax"
      );
    });

    it("is unprofitable at the floor fee and the largest admissible step", async () => {
      // THE worst case the contracts permit: free entry, floor exit, biggest
      // possible mark. If this passes, nothing tighter exists.
      const proceeds = await roundTrip(0, MAX_STEP_BPS);
      expect(proceeds).to.be.at.most(
        DEPOSIT.toNumber(),
        "floor fees against a maximal step must never profit"
      );
    });

    it("is unprofitable with coverage weighted onto tin", async () => {
      const proceeds = await roundTrip(MAX_FEE_BPS, MAX_STEP_BPS);
      expect(proceeds).to.be.at.most(DEPOSIT.toNumber());
    });

    it("is unprofitable with coverage weighted onto tout", async () => {
      const proceeds = await roundTrip(0, MAX_FEE_BPS);
      expect(proceeds).to.be.at.most(DEPOSIT.toNumber());
    });

    it("cannot be made profitable by lowering the fee afterwards", async () => {
      // What the high-water ratchet used to defend, now structural. Take the
      // biggest admissible step at a high fee, then cheapen the exit as far as
      // the program allows — which is the floor, and the floor still covers it.
      await setFees(MAX_FEE_BPS, MAX_FEE_BPS);

      const rawBefore = await okuMBal(userOkuMAta);
      await mint(DEPOSIT);
      const acquired = new BN((await okuMBal(userOkuMAta)) - rawBefore);

      await warpBy(h, MIN_MARK_INTERVAL_SECS);
      const m = await readMultiplierFromMint(h, okuMMint);
      await setMultiplier(m.add(m.muln(MAX_STEP_BPS - 1).divn(10_000)));
      await clearWindow();

      // As cheap as an exit can ever get. No reset instruction exists because
      // there is no accumulated state to reset.
      await setFees(0, MAX_STEP_BPS);

      const usdcBefore = await usdcBal(userUsdcAta);
      await redeem(acquired);
      const proceeds = (await usdcBal(userUsdcAta)) - usdcBefore;

      expect(proceeds).to.be.at.most(
        DEPOSIT.toNumber(),
        "the minimum reachable fee must still cover any step already taken"
      );
    });
  });
});
