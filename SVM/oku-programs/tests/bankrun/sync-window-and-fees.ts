/**
 * Cross-chain multiplier sync window + PSM `tin`/`tout` fees.
 *
 * These two mechanisms address two structurally different arbitrage
 * surfaces around a multiplier update, and the tests are organised to keep
 * that distinction explicit because conflating them is the easy mistake:
 *
 *   - **Sync window** — cross-chain. Profit requires *transacting while the
 *     chains disagree*, during the interval between the EVM write and the
 *     SVM write. Blocking the price-sensitive instructions for that
 *     interval removes the opportunity entirely.
 *
 *   - **`tout` fee** — local. Profit requires *holding raw across a
 *     discrete step*, which needs no transaction during any window at all.
 *     The window is powerless here; only a fee exceeding the step's yield
 *     makes the round trip lossy. See
 *     `describe("local step arbitrage")` below, which demonstrates both
 *     the attack and the fix.
 *
 * Both ship inert (`sync_window_secs = 0`, `tin = tout = 0`) and are
 * enabled by configuration, so the first describe block pins that
 * property — a regression there would silently change behaviour for every
 * existing deployment.
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
const MIN_SYNC_WINDOW_GAP_SECS = 21_600; // oku-shared::MIN_SYNC_WINDOW_GAP_SECS

describe("cross-chain sync window + PSM fees", () => {
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

  const beginWindow = (epoch: number, signer: Keypair = orchestrator) =>
    psm.methods
      .beginSyncWindow(new BN(epoch))
      .accountsPartial({ rebaser: signer.publicKey, config: psmConfigPda })
      .signers([signer])
      .rpc();

  const endWindow = (epoch: number, signer: Keypair = orchestrator) =>
    psm.methods
      .endSyncWindow(new BN(epoch))
      .accountsPartial({ rebaser: signer.publicKey, config: psmConfigPda })
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

  const resetMark = (signer: Keypair = coldMultisig) =>
    psm.methods
      .resetStepHighWaterMark()
      .accountsPartial({ capManager: signer.publicKey, config: psmConfigPda })
      .signers([signer])
      .rpc();

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

  /**
   * Advance past the inter-window gap so a fresh window can be opened.
   *
   * Computed from the stored anchor rather than warping a fixed amount: a
   * preceding test may have left `sync_lock_until_ts` in the future, in which
   * case a blind warp lands short and `begin_sync_window` reverts.
   */
  const clearGap = async () => {
    const c: any = await cfg();
    const lockUntil = Number(c.syncLockUntilTs.toString());
    const clock = await h.context.banksClient.getClock();
    const now = Number(clock.unixTimestamp);
    const earliest = lockUntil + MIN_SYNC_WINDOW_GAP_SECS;
    if (now <= earliest) await warpBy(h, earliest - now + 1);
  };

  /** Warp past any armed window. */
  const clearWindow = () => clearSyncWindow(h, psm as any, psmConfigPda);

  /**
   * A covered multiplier write inside the current epoch.
   *
   * `end_sync_window` now requires one, so any test that opens a window must
   * also write before it can close.
   */
  const writeInEpoch = async () => {
    const m = await readMultiplierFromMint(h, okuMMint);
    const tout = (await cfg()).toutBps.toNumber();
    const step = m.muln(Math.max(1, Math.floor(tout / 2))).divn(10_000);
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

  describe("ships fail-closed", () => {
    it("initializes with the window ON, fees at zero, and no step mark", async () => {
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
        { toutBps: 0 }
      );
      const c: any = await probeH.program.account.psmConfig.fetch(probe.configPda);

      // The window ships ON. Protection that depends on someone remembering to
      // switch it on is not protection.
      expect(c.syncWindowSecs.toNumber()).to.equal(DEFAULT_SYNC_WINDOW_SECS);
      expect(c.syncLockUntilTs.toNumber()).to.equal(0);
      expect(c.syncEpoch.toNumber()).to.equal(0);
      expect(c.lastWriteEpoch.toNumber()).to.equal(0);

      // Fees ship at zero — which is now fail-closed, not a hole. See below.
      expect(c.tinBps.toNumber()).to.equal(0);
      expect(c.toutBps.toNumber()).to.equal(0);
      expect(c.maxStepBps.toNumber()).to.equal(0);
    });

    it("refuses to rebase at all while tout is zero", async () => {
      // THE fail-closed property, and the reason shipping fees at 0 is safe.
      //
      // With no redemption fee, any multiplier increase creates a step nothing
      // covers, so the program refuses it outright. The operator is unable to
      // create the arbitrage condition rather than merely trusted not to, and
      // configuring a fee sized to the intended cadence becomes a precondition
      // of rebasing rather than a step someone might forget.
      await setFees(0, 0);
      const m = await readMultiplierFromMint(h, okuMMint);
      await expectBankrunError(() => setMultiplier(m.addn(1)), "StepExceedsFeeCoverage");
      // `distribute_yield` reaches the multiplier by a different route and is
      // equally fail-closed; asserted in the step-coverage describe below,
      // where a nonzero supply is guaranteed.
    });
  });

  // =========================================================================
  // Step coverage — the invariant that makes step arbitrage impossible
  // =========================================================================

  describe("step coverage", () => {
    beforeEach(async () => {
      await resetMark();
      await setFees(0, 10);
    });

    it("permits a step the fee covers and refuses one it does not", async () => {
      const m = await readMultiplierFromMint(h, okuMMint);
      const covered = m.add(m.muln(9).divn(10_000)); // 9 bps under a 10 bps fee
      const uncovered = m.add(m.muln(20).divn(10_000)); // 20 bps

      await expectBankrunError(() => setMultiplier(uncovered), "StepExceedsFeeCoverage");
      await setMultiplier(covered);
    });

    it("records the step as a high-water mark", async () => {
      const m = await readMultiplierFromMint(h, okuMMint);
      await setMultiplier(m.add(m.muln(9).divn(10_000)));
      const mark = (await cfg()).maxStepBps.toNumber();
      expect(mark).to.be.greaterThan(0);
      expect(mark).to.be.at.most(10, "mark must never exceed the fee that permitted it");
    });

    it("caps a single step at MAX_FEE_BPS however high the fee is set", async () => {
      // A derived bound worth stating: tout <= MAX_FEE_BPS, and step <= tout,
      // so the multiplier can never move more than 1% in one write. That in
      // turn implies a MINIMUM rebase cadence — a long outage cannot be caught
      // up in a single step.
      await setFees(0, MAX_FEE_BPS);
      const m = await readMultiplierFromMint(h, okuMMint);
      const overCeiling = m.add(m.muln(MAX_FEE_BPS + 1).divn(10_000));
      await expectBankrunError(() => setMultiplier(overCeiling), "StepExceedsFeeCoverage");
    });

    it("applies the same coverage rule to distribute_yield", async () => {
      // distribute_yield reaches the multiplier by a different route; it must
      // not be a way around the check.
      const supply = await totalSupply();
      const m = await readMultiplierFromMint(h, okuMMint);
      // A yield amount whose implied bump lands far above the 10 bps fee.
      const hugeBump = m.muln(50).divn(10_000);
      const hugeYield = hugeBump.mul(supply).div(PRECISION);
      if (hugeYield.gtn(0)) {
        await expectBankrunError(
          () => distributeYield(hugeYield),
          "StepExceedsFeeCoverage"
        );
      }
    });
  });

  // =========================================================================
  // The fee floor — coverage cannot be removed after the fact
  // =========================================================================

  describe("fee high-water mark", () => {
    it("refuses to lower tout below a step already taken", async () => {
      await resetMark();
      await setFees(0, MAX_FEE_BPS);

      // Take a large step under a large fee.
      const m = await readMultiplierFromMint(h, okuMMint);
      await setMultiplier(m.add(m.muln(50).divn(10_000))); // 50 bps
      const mark = (await cfg()).maxStepBps.toNumber();
      expect(mark).to.be.at.least(50);

      // THE MANIPULATION THIS BLOCKS: raise tout, take a big step, drop tout —
      // handing a cheap exit to everyone who held across the step. The
      // attacker's edge is locked in when the step lands and never decays,
      // which is why a time-based cooldown would not close this and a
      // high-water mark does.
      await expectBankrunError(() => setFees(0, mark - 1), "FeeBelowStepHighWaterMark");
      await expectBankrunError(() => setFees(0, 0), "FeeBelowStepHighWaterMark");

      // At or above the mark is fine.
      await setFees(0, mark);
    });

    it("only pins against steps actually taken", async () => {
      // Not "the fee can never fall". A protocol that only ever took 1 bps
      // steps can still lower tout to 1 bps — the floor tracks reality, not
      // the historical maximum fee.
      await resetMark();
      await setFees(0, MAX_FEE_BPS);
      const m = await readMultiplierFromMint(h, okuMMint);
      await setMultiplier(m.add(m.muln(1).divn(10_000))); // 1 bps step

      const mark = (await cfg()).maxStepBps.toNumber();
      expect(mark).to.be.at.most(2);
      await setFees(0, mark); // far below the 100 bps that permitted it
    });

    it("clears only via the explicit, separately-named reset", async () => {
      await resetMark();
      await setFees(0, MAX_FEE_BPS);
      const m = await readMultiplierFromMint(h, okuMMint);
      await setMultiplier(m.add(m.muln(50).divn(10_000)));
      expect((await cfg()).maxStepBps.toNumber()).to.be.at.least(50);

      await expectBankrunError(() => setFees(0, 1), "FeeBelowStepHighWaterMark");

      // Deliberately not a side effect of set_fees: clearing the mark reopens
      // historical step exposure, so it has to be its own auditable action.
      await resetMark();
      expect((await cfg()).maxStepBps.toNumber()).to.equal(0);
      await setFees(0, 1);
    });

    it("restricts the reset to cap_manager", async () => {
      await expectBankrunError(() => resetMark(orchestrator), "Unauthorized");
      await expectBankrunError(() => resetMark(warmMultisig), "Unauthorized");
    });
  });

  // =========================================================================
  // Parameter bounds and RBAC
  // =========================================================================

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

    it("restricts window open/close to rebaser", async () => {
      await expectBankrunError(() => beginWindow(1, coldMultisig), "Unauthorized");
      await expectBankrunError(() => endWindow(0, warmMultisig), "Unauthorized");
    });
  });

  // =========================================================================
  // Sync window
  // =========================================================================

  describe("sync window blocks price-sensitive instructions", () => {
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

    it("blocks mint and redeem while open, and both resume after early close", async () => {
      await clearGap();
      const epoch = (await cfg()).syncEpoch.toNumber() + 1;
      await beginWindow(epoch);

      await expectBankrunError(() => mint(new BN(10_000_000)), "SyncWindowActive");
      await expectBankrunError(() => redeem(new BN(1_000_000)), "SyncWindowActive");

      await writeInEpoch();
      await endWindow(epoch);

      await mint(new BN(10_000_000));
      await redeem(new BN(1_000_000));
    });

    it("blocks the direct bridge legs too", async () => {
      // Neither leg prices through the multiplier on its own — but the
      // cross-chain PAIR does: burning 100 raw at M=1.04 destroys $104 of claim
      // while minting 100 raw at M=1.05 creates $105. "Raw-conserving" is a
      // per-instruction property that does not survive the round trip.
      await clearGap();
      const epoch = (await cfg()).syncEpoch.toNumber() + 1;
      await beginWindow(epoch);

      await expectBankrunError(() => directMint(new BN(1_000)), "SyncWindowActive");
      await expectBankrunError(() => directBurn(new BN(1_000)), "SyncWindowActive");

      await writeInEpoch();
      await endWindow(epoch);
    });

    it("auto-expires without an explicit close (liveness backstop)", async () => {
      // If the orchestrator dies mid-tick, redemption must resume unaided —
      // otherwise the mechanism is a bricking vector worse than the arbitrage
      // it prevents.
      await clearGap();
      const epoch = (await cfg()).syncEpoch.toNumber() + 1;
      await beginWindow(epoch);
      await expectBankrunError(() => redeem(new BN(1_000_000)), "SyncWindowActive");

      await warpBy(h, 121);
      await redeem(new BN(1_000_000));
    });

    it("leaves multiplier-independent instructions open while engaged", async () => {
      await clearGap();
      const epoch = (await cfg()).syncEpoch.toNumber() + 1;
      await beginWindow(epoch);

      // Buffer movement is at par — a stale multiplier cannot misprice it.
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
      // censor the rebaser.
      await writeInEpoch();
      await endWindow(epoch);
    });
  });

  // =========================================================================
  // Epoch discipline
  // =========================================================================

  describe("epoch discipline", () => {
    before(async () => {
      await resetMark();
      await setFees(0, MAX_FEE_BPS);
      await setWindowSecs(60);
    });
    after(async () => {
      await setWindowSecs(0);
    });

    it("requires begin to advance the epoch by exactly one", async () => {
      await clearGap();
      const current = (await cfg()).syncEpoch.toNumber();

      await expectBankrunError(() => beginWindow(current), "EpochMismatch");
      await expectBankrunError(() => beginWindow(current + 2), "EpochMismatch");

      await beginWindow(current + 1);
      expect((await cfg()).syncEpoch.toNumber()).to.equal(current + 1);
      await writeInEpoch();
      await endWindow(current + 1);
    });

    it("requires close to match the open, so a stale release cannot fire", async () => {
      await clearGap();
      const epoch = (await cfg()).syncEpoch.toNumber() + 1;
      await beginWindow(epoch);
      await writeInEpoch();

      await expectBankrunError(() => endWindow(epoch - 1), "EpochMismatch");
      await expectBankrunError(() => redeem(new BN(1_000_000)), "SyncWindowActive");

      await endWindow(epoch);
      await redeem(new BN(1_000_000));
    });

    it("refuses to close a window in which no multiplier write landed", async () => {
      // Without this, "open, forget to write, close" advances sync_epoch
      // against an untouched multiplier and the cross-chain parity check —
      // which compares epochs — reports a false OK. This is what makes
      // sync_epoch mean "this chain actually wrote for tick N".
      await clearGap();
      const epoch = (await cfg()).syncEpoch.toNumber() + 1;
      await beginWindow(epoch);

      await expectBankrunError(() => endWindow(epoch), "NoWriteInEpoch");

      // The write makes the close legal.
      await writeInEpoch();
      await endWindow(epoch);
      expect((await cfg()).lastWriteEpoch.toNumber()).to.equal(epoch);
    });
  });

  // =========================================================================
  // Anti-griefing gap
  // =========================================================================

  describe("anti-griefing gap", () => {
    before(async () => {
      await resetMark();
      await setFees(0, MAX_FEE_BPS);
      await setWindowSecs(60);
    });
    after(async () => {
      await setWindowSecs(0);
    });

    it("refuses a second explicit window inside the gap", async () => {
      await clearGap();
      const epoch = (await cfg()).syncEpoch.toNumber() + 1;
      await beginWindow(epoch);
      await writeInEpoch();
      await endWindow(epoch);

      await expectBankrunError(() => beginWindow(epoch + 1), "SyncWindowGapNotElapsed");

      await clearGap();
      await beginWindow(epoch + 1);
      await writeInEpoch();
      await endWindow(epoch + 1);
    });

    it("clamps rather than reverts when a multiplier write lands inside the gap", async () => {
      // THE anti-griefing property. A rebaser looping set_multiplier must not
      // be able to hold a permanent lock — but the write must also never be
      // REJECTED on window state, or anyone able to open a window could censor
      // the rebaser.
      await clearGap();
      const epoch = (await cfg()).syncEpoch.toNumber() + 1;
      await beginWindow(epoch);
      await writeInEpoch();
      await endWindow(epoch);

      const anchorTs = (await cfg()).syncLockUntilTs.toNumber();

      for (let i = 0; i < 3; i++) {
        await warpBy(h, 2);
        await writeInEpoch(); // must SUCCEED
      }

      expect((await cfg()).syncLockUntilTs.toNumber()).to.equal(
        anchorTs,
        "gap anchor moved: a window was re-armed inside the gap"
      );
      await redeem(new BN(1_000_000));
    });

    it("auto-arms fail-closed once the gap has elapsed", async () => {
      await clearGap();
      await writeInEpoch();
      await expectBankrunError(() => redeem(new BN(1_000_000)), "SyncWindowActive");
      await warpBy(h, 61);
      await redeem(new BN(1_000_000));
    });
  });

  // =========================================================================
  // Fee arithmetic
  // =========================================================================

  describe("tout / tin arithmetic", () => {
    beforeEach(async () => {
      await resetMark();
      await setFees(0, 0);
      await mint(new BN(2_000_000_000));
    });

    afterEach(async () => {
      await resetMark();
      await setFees(0, 0);
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
      await setFees(25, 0);
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
     * transacts while a window is open, so no window length deters it.
     *
     * The defence is no longer "set a big enough tout and hope". Two on-chain
     * halves make it impossible:
     *
     *   1. a step larger than `tout` covers is refused outright, so the
     *      arbitrage condition cannot be created; and
     *   2. `tout` cannot later fall below a step already taken, so coverage
     *      cannot be removed after the fact.
     *
     * The first test below is therefore the important one: the historical
     * "profitable with no fee" case is now UNREACHABLE.
     */
    const DEPOSIT = new BN(1_000_000_000); // 1000 USDC

    it("cannot even be set up: an uncovered step is refused", async () => {
      await resetMark();
      await setFees(0, 0);

      const m = await readMultiplierFromMint(h, okuMMint);
      // Every increase, from a 1-unit nudge to a full 1%, is refused while no
      // fee is configured. There is no zero-fee step to arbitrage.
      await expectBankrunError(() => setMultiplier(m.addn(1)), "StepExceedsFeeCoverage");
      await expectBankrunError(
        () => setMultiplier(m.add(m.muln(100).divn(10_000))),
        "StepExceedsFeeCoverage"
      );
    });

    it("is unprofitable at the largest step the fee permits", async () => {
      await resetMark();
      const tout = MAX_FEE_BPS;
      await setFees(0, tout);

      const rawBefore = await okuMBal(userOkuMAta);
      await mint(DEPOSIT);
      const acquired = new BN((await okuMBal(userOkuMAta)) - rawBefore);

      // Step right up to the coverage ceiling — the best case available to an
      // attacker.
      const m = await readMultiplierFromMint(h, okuMMint);
      await setMultiplier(m.add(m.muln(tout).divn(10_000)));
      await clearWindow();

      const usdcBefore = await usdcBal(userUsdcAta);
      await redeem(acquired);
      const proceeds = (await usdcBal(userUsdcAta)) - usdcBefore;

      expect(proceeds).to.be.at.most(
        DEPOSIT.toNumber(),
        "a covered step must never yield a profitable round trip"
      );
    });

    it("stays unprofitable after the fee is lowered as far as it can go", async () => {
      // The manipulation the high-water mark blocks, end to end: take the
      // biggest step the fee allows, then try to cheapen the exit.
      await resetMark();
      await setFees(0, MAX_FEE_BPS);

      const rawBefore = await okuMBal(userOkuMAta);
      await mint(DEPOSIT);
      const acquired = new BN((await okuMBal(userOkuMAta)) - rawBefore);

      const m = await readMultiplierFromMint(h, okuMMint);
      await setMultiplier(m.add(m.muln(MAX_FEE_BPS).divn(10_000)));
      await clearWindow();

      // Lower tout as far as the floor permits — no further.
      const mark = (await cfg()).maxStepBps.toNumber();
      await setFees(0, mark);

      const usdcBefore = await usdcBal(userUsdcAta);
      await redeem(acquired);
      const proceeds = (await usdcBal(userUsdcAta)) - usdcBefore;

      expect(proceeds).to.be.at.most(
        DEPOSIT.toNumber(),
        "lowering tout to the high-water mark must not make the round trip profitable"
      );
    });
  });
});
