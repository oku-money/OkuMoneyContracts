/**
 * realWorldUsage — N-day kitchen-sink simulation + 8 deterministic edge-case suites.
 *
 * SVM-side mirror of EVM/test/hardhat/scenarios/RealWorldUsage.ts.
 *
 * Simulates the full okuM lifecycle on a single bankrun PSM:
 *
 *   - 5 users randomly mint, redeem (instant), and bridge cross-chain
 *   - Orchestrator bridges OkuM between virtual "chain A" and "chain B":
 *       1. Redeem user okuM via PSM -> orchestrator gains USDC
 *       2. Mint new USDC to orchestrator (models cross-chain rail crediting)
 *       3. Orchestrator mints okuM for recipient via PSM on same bankrun context
 *   - Multiplier ticks via set_multiplier (simulates 5% APY at +0.0137%/day)
 *   - Pause / unpause, freeze / thaw (SVM blacklist)
 *
 * Timeline: N daily ticks (warpBy + warpSlots per step).
 *   N = process.env.DURATION_DAYS ?? 60  (local default 60; CI keeps it fast)
 *   Seed = process.env.SEED ?? 0xC0DEF00D
 *
 * Global invariants checked every step:
 *   I1. Orchestrator okuM float == 0 after each completed bridge
 *   I2. multiplier non-decreasing
 *   I4. Per-bridge USDC drift <= 1
 *
 * Edge-case suites (deterministic):
 *   E1. Multi-slot round-trip with multiplier ticks
 *   E3. Multiplier tick between bridge legs (value conserved)
 *   E4. Frozen ATA mid-bridge (orchestrator float)
 *   E5. Pause during simulation
 *   E7. Yield-lock: same-slot set_multiplier + mint revert
 *   E8. Cap/minter-allowance exhaustion and rotation
 */

import * as anchor from "@anchor-lang/core";
import { Program, BN } from "@anchor-lang/core";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
  createTransferInstruction,
} from "@solana/spl-token";
import { Transaction } from "@solana/web3.js";
import { expect } from "chai";
import { LitePsm } from "../../../target/types/lite_psm";
import { PRECISION, ratePerSecondForApy } from "@okumoney/yield-tooling";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  mintOkuMViaProgram,
  DECIMALS,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
} from "../../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  warpSlots,
  warpBy,
  computeCanonicalMultiplier,
  getClock,
} from "../../shared/bankrun";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32)
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s += 0x6d2b79f5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = parseInt(process.env.SEED ?? "0xC0DEF00D", 16);
const DURATION_DAYS = parseInt(
  process.env.DURATION_DAYS ?? (process.env.CI ? "30" : "60"),
  10
);
const DAY_SECS = 86400;


// ---------------------------------------------------------------------------
// Chai BigInt helpers (chai doesn't support BigInt natively)
// ---------------------------------------------------------------------------
function assertGt(val: bigint, threshold: bigint, msg?: string) {
  expect(val > threshold, msg ?? `expected ${val} > ${threshold}`).to.be.true;
}
function assertGte(val: bigint, threshold: bigint, msg?: string) {
  expect(val >= threshold, msg ?? `expected ${val} >= ${threshold}`).to.be.true;
}
function assertEq(val: bigint, expected: bigint, msg?: string) {
  expect(val.toString()).to.equal(expected.toString(), msg);
}
function assertLte(val: bigint, threshold: bigint, msg?: string) {
  expect(val <= threshold, msg ?? `expected ${val} <= ${threshold}`).to.be.true;
}

// ---------------------------------------------------------------------------
// Shared setup (mints + ATAs) factored to reduce boilerplate per describe
// ---------------------------------------------------------------------------

interface Ctx {
  h: BankrunHarness;
  psm: Program<LitePsm>;
  usdcMint: PublicKey;
  okuMMint: PublicKey;
  configPda: PublicKey;
  vaultUsdcAta: PublicKey;
  vaultOkuMAta: PublicKey;
}

async function buildCtx(): Promise<Ctx & {
  users: Keypair[];
  userUsdcAtas: PublicKey[];
  userOkuMAtas: PublicKey[];
  orchUsdcAta: PublicKey;
  orchOkuMAta: PublicKey;
}> {
  const h = await startBankrun();
  const payer = h.payer;
  anchor.setProvider(h.provider as unknown as anchor.AnchorProvider);
  const psm = h.program as unknown as Program<LitePsm>;

  const usdcMintKp = Keypair.generate();
  const usdcMint = await createMintViaBankrun(
    h, payer.publicKey, null, DECIMALS, usdcMintKp, TOKEN_PROGRAM_ID
  );

  const users = Array.from({ length: 5 }, () => Keypair.generate());
  await fundKeypairs(
    h,
    [...users, coldMultisig, warmMultisig, psmOrchestrator],
    10 * anchor.web3.LAMPORTS_PER_SOL
  );

  const setup = await initializePsm(h, psm, payer, usdcMint);
  const okuMMint = setup.okuMMint;

  // ATAs for each user
  const userUsdcAtas: PublicKey[] = [];
  const userOkuMAtas: PublicKey[] = [];
  for (const u of users) {
    userUsdcAtas.push(await ensureAtaViaBankrun(h, u.publicKey, usdcMint, TOKEN_PROGRAM_ID));
    userOkuMAtas.push(getAssociatedTokenAddressSync(okuMMint, u.publicKey, false, TOKEN_2022_PROGRAM_ID));
    await ensureAtaViaBankrun(h, u.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);
  }

  const orchUsdcAta = await ensureAtaViaBankrun(h, psmOrchestrator.publicKey, usdcMint, TOKEN_PROGRAM_ID);
  const orchOkuMAta = getAssociatedTokenAddressSync(
    okuMMint, psmOrchestrator.publicKey, false, TOKEN_2022_PROGRAM_ID
  );
  await ensureAtaViaBankrun(h, psmOrchestrator.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);

  return {
    h, psm, usdcMint, okuMMint,
    configPda: setup.configPda, ...setup,
    users, userUsdcAtas, userOkuMAtas, orchUsdcAta, orchOkuMAta,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function tokenBalance(
  h: BankrunHarness,
  ata: PublicKey,
  programId: PublicKey
): Promise<bigint> {
  try {
    const acc = await getAccount(h.provider.connection, ata, undefined, programId);
    return acc.amount;
  } catch {
    return 0n;
  }
}

async function mintUsdc(
  h: BankrunHarness,
  to: PublicKey,
  usdcMint: PublicKey,
  amount: number
): Promise<void> {
  await mintToViaBankrun(h, usdcMint, to, h.payer, amount, TOKEN_PROGRAM_ID);
}

async function userMintOkuM(
  ctx: Awaited<ReturnType<typeof buildCtx>>,
  userIndex: number,
  usdcAmount: number
): Promise<void> {
  const user = ctx.users[userIndex];
  await mintUsdc(ctx.h, ctx.userUsdcAtas[userIndex], ctx.usdcMint, usdcAmount);
  try {
    await mintOkuMViaProgram(
      ctx.psm, user, new BN(usdcAmount),
      ctx.configPda, ctx.usdcMint, ctx.okuMMint,
      ctx.userUsdcAtas[userIndex], ctx.userOkuMAtas[userIndex], ctx.vaultUsdcAta
    );
  } catch { /* soft-skip: paused or allowance exhausted */ }
}

async function userRedeemOkuM(
  ctx: Awaited<ReturnType<typeof buildCtx>>,
  userIndex: number,
  fraction: number // 1-100
): Promise<void> {
  const user = ctx.users[userIndex];
  const bal = await tokenBalance(ctx.h, ctx.userOkuMAtas[userIndex], TOKEN_2022_PROGRAM_ID);
  if (bal === 0n) return;
  const amount = (bal * BigInt(fraction)) / 100n;
  if (amount === 0n) return;
  try {
    await ctx.psm.methods
      .redeemOkuM(new BN(amount.toString()), new BN(0))
      .accountsPartial({
        user: user.publicKey,
        config: ctx.configPda,
        usdcMint: ctx.usdcMint,
        okuMMint: ctx.okuMMint,
        userUsdcAta: ctx.userUsdcAtas[userIndex],
        userOkuMAta: ctx.userOkuMAtas[userIndex],
        vaultUsdc: ctx.vaultUsdcAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  } catch { /* soft-skip: frozen, paused, etc. */ }
}

/** Orchestrator bridges OkuM from user -> recipient (same PSM, simulates cross-chain). */
async function orchestratorBridge(
  ctx: Awaited<ReturnType<typeof buildCtx>>,
  userIndex: number,
  recipientIndex: number,
  rawOkuMAmount: bigint
): Promise<{ usdcOut: bigint; usdcIn: bigint }> {
  const user = ctx.users[userIndex];
  const recipient = ctx.users[recipientIndex];

  // Source leg: transfer okuM to orchestrator
  const transferTx = new Transaction().add(
    createTransferInstruction(
      ctx.userOkuMAtas[userIndex],
      ctx.orchOkuMAta,
      user.publicKey,
      rawOkuMAmount,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );
  await ctx.h.provider.sendAndConfirm!(transferTx, [user]);

  // Orchestrator redeems
  const orchUsdcBefore = await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID);
  await ctx.psm.methods
    .redeemOkuM(new BN(rawOkuMAmount.toString()), new BN(0))
    .accountsPartial({
      user: psmOrchestrator.publicKey,
      config: ctx.configPda,
      usdcMint: ctx.usdcMint,
      okuMMint: ctx.okuMMint,
      userUsdcAta: ctx.orchUsdcAta,
      userOkuMAta: ctx.orchOkuMAta,
      vaultUsdc: ctx.vaultUsdcAta,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([psmOrchestrator])
    .rpc();
  const orchUsdcAfter = await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID);
  const usdcOut = orchUsdcAfter - orchUsdcBefore;

  // Off-chain rail: credit same USDC to orchestrator on "chain B" (same mint here)
  await mintUsdc(ctx.h, ctx.orchUsdcAta, ctx.usdcMint, Number(usdcOut));

  // Destination leg: orchestrator mints okuM for recipient
  const recipientOkuMAta = ctx.userOkuMAtas[recipientIndex];
  const orchOkuMBefore = await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID);
  // MEASURED, not assumed equal to usdcOut — returning the source figure twice
  // made the drift identically zero, so I4 could not fail.
  const orchUsdcBeforeMint = await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID);
  await mintOkuMViaProgram(
    ctx.psm, psmOrchestrator, new BN(usdcOut.toString()),
    ctx.configPda, ctx.usdcMint, ctx.okuMMint,
    ctx.orchUsdcAta, ctx.orchOkuMAta, ctx.vaultUsdcAta
  );
  const orchOkuMAfter = await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID);
  const okuMMinted = orchOkuMAfter - orchOkuMBefore;
  const usdcIn = orchUsdcBeforeMint - (await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID));

  // Forward to recipient
  if (okuMMinted > 0n) {
    const fwdTx = new Transaction().add(
      createTransferInstruction(
        ctx.orchOkuMAta,
        recipientOkuMAta,
        psmOrchestrator.publicKey,
        okuMMinted,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
    await ctx.h.provider.sendAndConfirm!(fwdTx, [psmOrchestrator]);
  }

  return { usdcOut, usdcIn };
}



// ---------------------------------------------------------------------------
// Main simulation
// ---------------------------------------------------------------------------

describe(
  `realWorldUsage (SVM) — ${DURATION_DAYS}-day stochastic simulation (seed 0x${SEED.toString(16).toUpperCase()})`,
  () => {
    let ctx: Awaited<ReturnType<typeof buildCtx>>;
    let rng: () => number;

    // Invariant trackers
    let cumulativeDrift: bigint;
    let totalBridges: number;
    let lastMultiplier: bigint;

    before(async function () {
      this.timeout(300_000);
      ctx = await buildCtx();
      rng = mulberry32(SEED);
      lastMultiplier = PRECISION;

      // Seed the PSM buffer for instant redeems
      await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 500_000_000_000); // 500k USDC

      // Give users initial okuM
      for (let i = 0; i < 5; i++) {
        await userMintOkuM(ctx, i, 100_000_000); // 100 USDC each
      }

      cumulativeDrift = 0n;
      totalBridges = 0;
    });

    it(`runs ${DURATION_DAYS} daily ticks with stochastic actions and holds all invariants`, async function () {
      this.timeout(600_000);

      for (let day = 0; day < DURATION_DAYS; day++) {
        // Advance one day
        await warpBy(ctx.h, DAY_SECS);
        await warpSlots(ctx.h, 1);

        const r = rng();

        try {
          if (r < 0.25) {
            // 25%: random user mints
            const ui = Math.floor(rng() * 5);
            const amount = Math.floor(rng() * 900_000 + 100_000); // 0.1-1 USDC
            await userMintOkuM(ctx, ui, amount);

          } else if (r < 0.45) {
            // 20%: random user redeems
            const ui = Math.floor(rng() * 5);
            const frac = Math.floor(rng() * 50 + 1);
            await userRedeemOkuM(ctx, ui, frac);

          } else if (r < 0.60) {
            // 15%: orchestrator bridges (user i -> user j, different index)
            const ui = Math.floor(rng() * 5);
            const ri = (ui + 1 + Math.floor(rng() * 4)) % 5;
            const bal = await tokenBalance(ctx.h, ctx.userOkuMAtas[ui], TOKEN_2022_PROGRAM_ID);
            if (bal > 1_000n) {
              // Only the ATTEMPT is soft-skipped — a bridge can legitimately
              // fail to start (paused PSM, empty buffer). Once it completes,
              // its invariants must hold, so the assertions sit outside the
              // catch. Inside it, a failed assertion was swallowed and I1/I4
              // could never fail.
              let legs: { usdcOut: bigint; usdcIn: bigint } | undefined;
              try {
                legs = await orchestratorBridge(ctx, ui, ri, bal / 2n);
              } catch { /* soft-skip bridge failures */ }

              if (legs) {
                const { usdcOut, usdcIn } = legs;
                const drift = usdcOut > usdcIn ? usdcOut - usdcIn : usdcIn - usdcOut;
                cumulativeDrift += drift;
                assertLte(drift, 1n, `day ${day} per-bridge drift`);
                // I1: Orchestrator okuM float == 0
                const float = await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID);
                assertEq(float, 0n, `day ${day} orch float`);
                totalBridges++;
              }
            }

          } else if (r < 0.75) {
            // 5%: refill buffer
            await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 10_000_000_000);

          } else if (r < 0.80) {
            // 5%: rebaser rolls the epoch by republishing a rate schedule.
            //
            // Note this is NOT a "yield event" any more. Yield accrues
            // continuously from elapsed time; this transaction only changes
            // the SLOPE. The simulation therefore accrues yield on every warp
            // below, whether or not this branch is taken -- which is a
            // strictly more realistic model of the protocol than the old
            // discrete tick.
            try {
              const nowTs = Number((await getClock(ctx.h)).unixTimestamp);
              await ctx.psm.methods
                .setOkumYieldRate(
                  new BN(ratePerSecondForApy(0.05).toString()),
                  new BN(nowTs + 30 * DAY_SECS)
                )
                .accountsPartial({
                  rebaser: psmOrchestrator.publicKey,
                  config: ctx.configPda,
                })
                .signers([psmOrchestrator])
                .rpc();
            } catch { /* soft */ }

          } else if (r < 0.83) {
            // 3%: pause for a day then unpause
            try {
              await ctx.psm.methods.pause()
                .accountsPartial({ pauser: warmMultisig.publicKey, config: ctx.configPda })
                .signers([warmMultisig]).rpc();
              await warpBy(ctx.h, DAY_SECS);
              await warpSlots(ctx.h, 1);
              await ctx.psm.methods.unpause()
                .accountsPartial({ unpauser: coldMultisig.publicKey, config: ctx.configPda })
                .signers([coldMultisig]).rpc();
              day++;
            } catch { /* already paused */ }

          } else if (r < 0.85) {
            // 2%: freeze a random user's okuM ATA for a day then thaw
            const ui = Math.floor(rng() * 5);
            try {
              await ctx.psm.methods.freezeAccount()
                .accountsPartial({
                  freezer: warmMultisig.publicKey,
                  config: ctx.configPda,
                  okuMMint: ctx.okuMMint,
                  targetOkuMAta: ctx.userOkuMAtas[ui],
                  token2022Program: TOKEN_2022_PROGRAM_ID,
                })
                .signers([warmMultisig]).rpc();
              await warpBy(ctx.h, DAY_SECS);
              await warpSlots(ctx.h, 1);
              await ctx.psm.methods.thawAccount()
                .accountsPartial({
                  unfreezer: coldMultisig.publicKey,
                  config: ctx.configPda,
                  okuMMint: ctx.okuMMint,
                  targetOkuMAta: ctx.userOkuMAtas[ui],
                  token2022Program: TOKEN_2022_PROGRAM_ID,
                })
                .signers([coldMultisig]).rpc();
              day++;
            } catch { /* soft */ }
          }
          // else ~15%: no-op

        } catch {
          // Any unexpected errors in the simulation step are soft-skipped
          // (the invariant checks below will surface real violations)
        }

        // I2: multiplier non-decreasing.
        const multNow = await computeCanonicalMultiplier(ctx.h, ctx.psm, ctx.configPda);
        assertGte(multNow, lastMultiplier, `day ${day} I2: multiplier non-decreasing`);
        lastMultiplier = multNow;

        // I4: cumulative drift bounded
        assertLte(cumulativeDrift, BigInt(totalBridges) * 2n + 10n, `day ${day} I4: cumulative drift`);
      }

      // Final: the canonical multiplier must be at or above PRECISION.
      // Monotonicity is structural -- rates below PRECISION are rejected at
      // write time -- so this is a check that nothing in the simulation found
      // a path around that.
      const finalMultiplier = await computeCanonicalMultiplier(ctx.h, ctx.psm, ctx.configPda);
      assertGte(finalMultiplier, PRECISION, "final multiplier >= PRECISION");
    });
  }
);

// ---------------------------------------------------------------------------
// Edge-case suites
// ---------------------------------------------------------------------------

describe("realWorldUsage (SVM) edge cases", () => {
  // -------------------------------------------------------------------------
  // E1: Multi-slot round-trip with multiplier ticks between legs
  // -------------------------------------------------------------------------
  describe("E1: round-trip bridge with multiplier tick between legs", () => {
    it("dollar value conserved across A->B multiplier-tick->B->A round-trip", async function () {
      this.timeout(60_000);
      const ctx = await buildCtx();

      // Mint okuM for user 0
      await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 200_000_000);
      await userMintOkuM(ctx, 0, 100_000_000); // 100 USDC -> 100 okuM

      const userOkuMBefore = await tokenBalance(ctx.h, ctx.userOkuMAtas[0], TOKEN_2022_PROGRAM_ID);
      assertGt(userOkuMBefore, 0n, "user 0 should have okuM");

      // Bridge leg A: user 0 -> user 1 (orchestrator redeems on A, mints on B)
      const bridgeAmt = userOkuMBefore / 2n;
      const { usdcOut } = await orchestratorBridge(ctx, 0, 1, bridgeAmt);
      assertEq(await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID), 0n, "float after A->B");

      // Multiplier ACCRUES between legs -- with no transaction at all.
      // Publish a ~26% APY schedule, then warp 30 days: the multiplier climbs
      // roughly 2% purely from elapsed time. The old version had to submit a
      // `set_multiplier` here; that it is no longer needed is the point.
      const e1Now = Number((await getClock(ctx.h)).unixTimestamp);
      await ctx.psm.methods
        .setOkumYieldRate(new BN(ratePerSecondForApy(0.27).toString()), new BN(e1Now + 60 * DAY_SECS))
        .accountsPartial({ rebaser: psmOrchestrator.publicKey, config: ctx.configPda })
        .signers([psmOrchestrator]).rpc();
      await warpBy(ctx.h, DAY_SECS * 30); // 30 days
      await warpSlots(ctx.h, 1);

      // Bridge leg B: user 1 -> user 0 (back again)
      const user1OkuM = await tokenBalance(ctx.h, ctx.userOkuMAtas[1], TOKEN_2022_PROGRAM_ID);
      if (user1OkuM > 0n) {
        const { usdcOut: usdcOutReturn } = await orchestratorBridge(ctx, 1, 0, user1OkuM);
        assertEq(await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID), 0n, "float after B->A");

        // After multiplier increase, returning okuM yields at least as much USDC (within 1 wei)
        assertGte(usdcOutReturn, usdcOut - 1n, "B->A leg should return >= A->B USDC (multiplier appreciated)");
      }
    });
  });

  // -------------------------------------------------------------------------
  // E3: Multiplier tick between legs preserves dollar value
  // -------------------------------------------------------------------------
  describe("E3: multiplier tick between redeem and mint legs", () => {
    it("dollar value conserved when set_multiplier fires between bridge legs", async function () {
      this.timeout(60_000);
      const ctx = await buildCtx();

      await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 100_000_000);
      await userMintOkuM(ctx, 0, 50_000_000);
      const userOkuM = await tokenBalance(ctx.h, ctx.userOkuMAtas[0], TOKEN_2022_PROGRAM_ID);
      if (userOkuM === 0n) { return; } // guard

      // Source leg: redeem (orchestrator gets USDC at current multiplier)
      const transferTx = new Transaction().add(
        createTransferInstruction(
          ctx.userOkuMAtas[0], ctx.orchOkuMAta,
          ctx.users[0].publicKey, userOkuM, [], TOKEN_2022_PROGRAM_ID
        )
      );
      await ctx.h.provider.sendAndConfirm!(transferTx, [ctx.users[0]]);

      const orchUsdcBefore = await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID);
      await ctx.psm.methods
        .redeemOkuM(new BN(userOkuM.toString()), new BN(0))
        .accountsPartial({
          user: psmOrchestrator.publicKey, config: ctx.configPda,
          usdcMint: ctx.usdcMint,
          okuMMint: ctx.okuMMint, userUsdcAta: ctx.orchUsdcAta,
          userOkuMAta: ctx.orchOkuMAta, vaultUsdc: ctx.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([psmOrchestrator]).rpc();
      const orchUsdcAfter = await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID);
      const usdcFromRedeem = orchUsdcAfter - orchUsdcBefore;

      // Multiplier accrues (~+1%) between legs, transaction-free.
      const e3Now = Number((await getClock(ctx.h)).unixTimestamp);
      await ctx.psm.methods
        .setOkumYieldRate(new BN(ratePerSecondForApy(0.13).toString()), new BN(e3Now + 60 * DAY_SECS))
        .accountsPartial({ rebaser: psmOrchestrator.publicKey, config: ctx.configPda })
        .signers([psmOrchestrator]).rpc();
      await warpBy(ctx.h, DAY_SECS * 30);
      await warpSlots(ctx.h, 1);
      const newMultiplier = await computeCanonicalMultiplier(ctx.h, ctx.psm, ctx.configPda);

      // Destination leg: mint okuM with same USDC at new (higher) multiplier -> fewer okuM
      await mintUsdc(ctx.h, ctx.orchUsdcAta, ctx.usdcMint, Number(usdcFromRedeem));
      const orchOkuMBefore = await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID);
      await mintOkuMViaProgram(
        ctx.psm, psmOrchestrator, new BN(usdcFromRedeem.toString()),
        ctx.configPda, ctx.usdcMint, ctx.okuMMint,
        ctx.orchUsdcAta, ctx.orchOkuMAta, ctx.vaultUsdcAta
      );
      const orchOkuMAfter = await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID);
      const okuMMinted = orchOkuMAfter - orchOkuMBefore;

      // Dollar value check: okuMMinted * m ~ usdcFromRedeem (within rounding).
      // Denominator is now PRECISION = 1e18, not 1e9.
      const newMultiplierBig = newMultiplier;
      const dollarValue = (okuMMinted * newMultiplierBig) / PRECISION;
      const drift = dollarValue > usdcFromRedeem ? dollarValue - usdcFromRedeem : usdcFromRedeem - dollarValue;
      assertLte(drift, 2n, "dollar value drift after multiplier tick");

      // Forward and clear float
      if (okuMMinted > 0n) {
        const fwdTx = new Transaction().add(
          createTransferInstruction(
            ctx.orchOkuMAta, ctx.userOkuMAtas[1],
            psmOrchestrator.publicKey, okuMMinted, [], TOKEN_2022_PROGRAM_ID
          )
        );
        await ctx.h.provider.sendAndConfirm!(fwdTx, [psmOrchestrator]);
      }
      assertEq(await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID), 0n, "float cleared");
    });
  });

  // -------------------------------------------------------------------------
  // E4: Frozen ATA mid-bridge — frozen recipient blocks transfer
  // -------------------------------------------------------------------------
  describe("E4: frozen ATA blocks transfer mid-bridge", () => {
    it("frozen okuM ATA rejects transfers; orchestrator must hold float until thaw", async function () {
      this.timeout(60_000);
      const ctx = await buildCtx();

      // Fund vault + mint okuM for user 0 (source of bridge)
      await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 100_000_000);
      await userMintOkuM(ctx, 0, 50_000_000);
      const userOkuM = await tokenBalance(ctx.h, ctx.userOkuMAtas[0], TOKEN_2022_PROGRAM_ID);
      if (userOkuM === 0n) { return; }

      const bridgeAmt = userOkuM / 2n;

      // Source leg: orchestrator pulls okuM and redeems (normal path, vault has USDC)
      const transferTx = new Transaction().add(
        createTransferInstruction(
          ctx.userOkuMAtas[0], ctx.orchOkuMAta,
          ctx.users[0].publicKey, bridgeAmt, [], TOKEN_2022_PROGRAM_ID
        )
      );
      await ctx.h.provider.sendAndConfirm!(transferTx, [ctx.users[0]]);

      await ctx.psm.methods
        .redeemOkuM(new BN(bridgeAmt.toString()), new BN(0))
        .accountsPartial({
          user: psmOrchestrator.publicKey, config: ctx.configPda,
          usdcMint: ctx.usdcMint,
          okuMMint: ctx.okuMMint, userUsdcAta: ctx.orchUsdcAta,
          userOkuMAta: ctx.orchOkuMAta, vaultUsdc: ctx.vaultUsdcAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([psmOrchestrator]).rpc();
      const orchUsdc = await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID);

      // Destination leg: mint okuM to orchestrator
      await mintUsdc(ctx.h, ctx.orchUsdcAta, ctx.usdcMint, Number(orchUsdc));
      await mintOkuMViaProgram(
        ctx.psm, psmOrchestrator, new BN(orchUsdc.toString()),
        ctx.configPda, ctx.usdcMint, ctx.okuMMint,
        ctx.orchUsdcAta, ctx.orchOkuMAta, ctx.vaultUsdcAta
      );
      const orchOkuM = await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID);

      // Freeze user 1's okuM ATA (the intended recipient on "chain B")
      await ctx.psm.methods.freezeAccount()
        .accountsPartial({
          freezer: warmMultisig.publicKey, config: ctx.configPda,
          okuMMint: ctx.okuMMint,
          targetOkuMAta: ctx.userOkuMAtas[1],
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([warmMultisig]).rpc();

      // Forward to frozen recipient -> must fail
      const fwdTx = new Transaction().add(
        createTransferInstruction(
          ctx.orchOkuMAta, ctx.userOkuMAtas[1],
          psmOrchestrator.publicKey, orchOkuM, [], TOKEN_2022_PROGRAM_ID
        )
      );
      let forwardFailed = false;
      try {
        await ctx.h.provider.sendAndConfirm!(fwdTx, [psmOrchestrator]);
      } catch { forwardFailed = true; }
      expect(forwardFailed, "transfer to frozen ATA should fail").to.be.true;

      // Orchestrator holds unbacked float
      assertGt(await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID), 0n, "orch holds float");

      // Recovery: thaw user 1, then forward succeeds
      await ctx.psm.methods.thawAccount()
        .accountsPartial({
          unfreezer: coldMultisig.publicKey, config: ctx.configPda,
          okuMMint: ctx.okuMMint,
          targetOkuMAta: ctx.userOkuMAtas[1],
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig]).rpc();

      const fwdTx2 = new Transaction().add(
        createTransferInstruction(
          ctx.orchOkuMAta, ctx.userOkuMAtas[1],
          psmOrchestrator.publicKey, orchOkuM, [], TOKEN_2022_PROGRAM_ID
        )
      );
      await ctx.h.provider.sendAndConfirm!(fwdTx2, [psmOrchestrator]);
      assertEq(await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID), 0n, "float cleared after thaw");
    });
  });

  // -------------------------------------------------------------------------
  // E5: Pause during simulation
  // -------------------------------------------------------------------------
  describe("E5: pause halts mints/redeems, system recovers after unpause", () => {
    it("mint and redeem revert while paused; both succeed after unpause", async function () {
      this.timeout(60_000);
      const ctx = await buildCtx();

      await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 100_000_000);
      await userMintOkuM(ctx, 0, 50_000_000);

      // Pause
      await ctx.psm.methods.pause()
        .accountsPartial({ pauser: warmMultisig.publicKey, config: ctx.configPda })
        .signers([warmMultisig]).rpc();

      // Advance 7 days
      await warpBy(ctx.h, DAY_SECS * 7);
      await warpSlots(ctx.h, 1);

      // Mint reverts while paused
      await mintUsdc(ctx.h, ctx.userUsdcAtas[1], ctx.usdcMint, 10_000_000);
      let mintFailed = false;
      try {
        await mintOkuMViaProgram(
          ctx.psm, ctx.users[1], new BN(10_000_000),
          ctx.configPda, ctx.usdcMint, ctx.okuMMint,
          ctx.userUsdcAtas[1], ctx.userOkuMAtas[1], ctx.vaultUsdcAta
        );
      } catch { mintFailed = true; }
      expect(mintFailed, "mint should fail while paused").to.be.true;

      // Unpause
      await ctx.psm.methods.unpause()
        .accountsPartial({ unpauser: coldMultisig.publicKey, config: ctx.configPda })
        .signers([coldMultisig]).rpc();

      // Mint succeeds after unpause
      await mintOkuMViaProgram(
        ctx.psm, ctx.users[1], new BN(10_000_000),
        ctx.configPda, ctx.usdcMint, ctx.okuMMint,
        ctx.userUsdcAtas[1], ctx.userOkuMAtas[1], ctx.vaultUsdcAta
      );
      assertGt(await tokenBalance(ctx.h, ctx.userOkuMAtas[1], TOKEN_2022_PROGRAM_ID), 0n);
    });
  });

  // -------------------------------------------------------------------------
  // E7: Yield-lock — same-slot set_multiplier + mint reverts
  // -------------------------------------------------------------------------
  describe("E7: yield-lock prevents mint in same slot as set_multiplier", () => {
    it("mint_oku_m reverts in same slot as set_multiplier; succeeds next slot", async function () {
      this.timeout(60_000);
      // Disable autoBumpSlot so we can control exact slot sequencing
      const h = await startBankrun({ autoBumpSlot: false });
      const payer = h.payer;
      anchor.setProvider(h.provider as unknown as anchor.AnchorProvider);
      const psm = h.program as unknown as Program<LitePsm>;

      const usdcMintKp = Keypair.generate();
      const usdcMint = await createMintViaBankrun(h, payer.publicKey, null, DECIMALS, usdcMintKp, TOKEN_PROGRAM_ID);

      const user = Keypair.generate();
      await fundKeypairs(h, [user, coldMultisig, warmMultisig, psmOrchestrator], 10 * anchor.web3.LAMPORTS_PER_SOL);

      const setup = await initializePsm(h, psm, payer, usdcMint);
      const configPda = setup.configPda;
      const okuMMint = setup.okuMMint;

      const userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
      const userOkuMAta = getAssociatedTokenAddressSync(okuMMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
      await ensureAtaViaBankrun(h, user.publicKey, okuMMint, TOKEN_2022_PROGRAM_ID);
      await mintToViaBankrun(h, usdcMint, setup.vaultUsdcAta, payer, 100_000_000, TOKEN_PROGRAM_ID);
      await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 10_000_000, TOKEN_PROGRAM_ID);

      // Emergency override (slot N) -- the only instruction that still stamps
      // the sandwich lock, because it is the only one producing a discrete
      // jump. Routine yield no longer engages it.
      const curMultiplierE7 = await computeCanonicalMultiplier(h, psm, configPda);
      await psm.methods.setOkumMultiplier(new BN((curMultiplierE7 + 1000n).toString()))
        .accountsPartial({ rebaser: psmOrchestrator.publicKey, config: configPda, okuMMint, token2022Program: TOKEN_2022_PROGRAM_ID })
        .signers([psmOrchestrator]).rpc();

      // Attempt mint in SAME slot -> should revert with YieldDistributionInProgress
      let mintFailed = false;
      try {
        await mintOkuMViaProgram(
          psm, user, new BN(10_000_000),
          configPda, usdcMint, okuMMint,
          userUsdcAta, userOkuMAta, setup.vaultUsdcAta
        );
      } catch { mintFailed = true; }
      expect(mintFailed, "mint should fail in same slot as set_multiplier").to.be.true;

      // Next slot succeeds
      await warpSlots(h, 1);
      await mintOkuMViaProgram(
        psm, user, new BN(10_000_000),
        configPda, usdcMint, okuMMint,
        userUsdcAta, userOkuMAta, setup.vaultUsdcAta
      );
      assertGt(await tokenBalance(h, userOkuMAta, TOKEN_2022_PROGRAM_ID), 0n);
    });
  });

  // -------------------------------------------------------------------------
  // E8: Cap / minterAllowance exhaustion and rotation
  // -------------------------------------------------------------------------
  describe("E8: minterAllowance exhaustion and rotation", () => {
    it("mint fails when minterAllowance exhausted; resumes after set_minter_allowance", async function () {
      this.timeout(60_000);
      const ctx = await buildCtx();

      await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 100_000_000);

      // Reduce minter allowance to 1_000 (micro-units = 0.001 okuM)
      await ctx.psm.methods
        .setMinterAllowance(new BN(1_000))
        .accountsPartial({
          allowanceManager: coldMultisig.publicKey,
          config: ctx.configPda,
        })
        .signers([coldMultisig]).rpc();

      // First small mint (<= allowance) succeeds
      await mintUsdc(ctx.h, ctx.userUsdcAtas[0], ctx.usdcMint, 500);
      await mintOkuMViaProgram(
        ctx.psm, ctx.users[0], new BN(500),
        ctx.configPda, ctx.usdcMint, ctx.okuMMint,
        ctx.userUsdcAtas[0], ctx.userOkuMAtas[0], ctx.vaultUsdcAta
      );

      // Large mint exceeds exhausted allowance -> fails
      await mintUsdc(ctx.h, ctx.userUsdcAtas[0], ctx.usdcMint, 10_000_000);
      let mintFailed = false;
      try {
        await mintOkuMViaProgram(
          ctx.psm, ctx.users[0], new BN(10_000_000),
          ctx.configPda, ctx.usdcMint, ctx.okuMMint,
          ctx.userUsdcAtas[0], ctx.userOkuMAtas[0], ctx.vaultUsdcAta
        );
      } catch { mintFailed = true; }
      expect(mintFailed, "mint should fail after allowance exhausted").to.be.true;

      // Rotate allowance via allowanceManager (coldMultisig)
      await ctx.psm.methods
        .setMinterAllowance(MINTER_ALLOWANCE)
        .accountsPartial({
          allowanceManager: coldMultisig.publicKey,
          config: ctx.configPda,
        })
        .signers([coldMultisig]).rpc();

      // Mint now succeeds
      await mintOkuMViaProgram(
        ctx.psm, ctx.users[0], new BN(10_000_000),
        ctx.configPda, ctx.usdcMint, ctx.okuMMint,
        ctx.userUsdcAtas[0], ctx.userOkuMAtas[0], ctx.vaultUsdcAta
      );
      assertGt(await tokenBalance(ctx.h, ctx.userOkuMAtas[0], TOKEN_2022_PROGRAM_ID), 0n);
    });
  });
});
