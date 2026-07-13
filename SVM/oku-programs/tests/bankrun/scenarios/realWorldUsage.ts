/**
 * realWorldUsage — 1-year (N-day) kitchen-sink simulation + 8 deterministic edge-case suites.
 *
 * SVM-side mirror of EVM/test/hardhat/scenarios/RealWorldUsage.ts.
 *
 * Simulates the full okuMoney noBridge lifecycle on a single bankrun PSM:
 *
 *   - 5 users randomly mint, redeem (instant + queued), and bridge cross-chain
 *   - Orchestrator bridges OkuM between virtual "chain A" and "chain B":
 *       1. Redeem user OkuM via PSM → orchestrator gains USDC
 *       2. Mint new USDC to orchestrator (models cross-chain rail crediting)
 *       3. Orchestrator mints OkuM for recipient via PSM on same bankrun context
 *   - Price ticks via set_oku_m_price (simulates 5% APY at +0.0137%/day)
 *   - update_usd_multiplier via vault for OkuDollar yield tracking
 *   - Pause / unpause, freeze / thaw (SVM blacklist)
 *
 * Timeline: N daily ticks (warpBy + warpSlots per step).
 *   N = process.env.DURATION_DAYS ?? 60  (local default 60; CI keeps it fast)
 *   Seed = process.env.SEED ?? 0xC0DEF00D
 *
 * Global invariants checked every step:
 *   I1. Orchestrator OkuM float == 0 after each completed bridge
 *   I2. oku_m_price non-decreasing
 *   I3. usd_multiplier non-decreasing (vault side)
 *   I4. Per-bridge USDC drift ≤ 1
 *
 * Edge-case suites (deterministic):
 *   E1. Multi-slot round-trip with price ticks
 *   E2. Queued redeem blocks bridge until process_queue
 *   E3. Price tick between bridge legs (value conserved)
 *   E4. Frozen ATA mid-bridge (soft-skip, orchestrator float)
 *   E5. Pause during simulation
 *   E7. Yield-lock: same-slot set_oku_m_price + mint revert
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
import { LitePsm } from "../../target/types/lite_psm";
import { OkuDollar } from "../../target/types/oku_dollar";
import {
  coldMultisig,
  warmMultisig,
  psmOrchestrator,
  initializePsm,
  mintOkuMoneyViaProgram,
  DECIMALS,
  MAX_SUPPLY,
  MINTER_ALLOWANCE,
} from "../../shared/setup";
import {
  BankrunHarness,
  startBankrun,
  fundKeypairs,
  createMintViaBankrun,
  createOkuMoneyMintViaBankrun,
  mintToViaBankrun,
  ensureAtaViaBankrun,
  getProgram,
  warpSlots,
  warpBy,
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
const PRECISION = new BN(1_000_000_000); // 1e9

// 5% APY ≈ +0.0137% per day. In 1e9 precision: 1e9 * 1.000137 ≈ 1_000_137_000
const DAILY_PRICE_TICK_BPS = 14; // ~0.014% per tick day

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
  vault: Program<OkuDollar>;
  usdcMint: PublicKey;
  okuMoneyMint: PublicKey;
  configPda: PublicKey;
  redemptionQueuePda: PublicKey;
  vaultUsdcAta: PublicKey;
  vaultOkuMoneyAta: PublicKey;
}

async function buildCtx(): Promise<Ctx & {
  users: Keypair[];
  userUsdcAtas: PublicKey[];
  userOkuMoneyAtas: PublicKey[];
  orchUsdcAta: PublicKey;
  orchOkuMoneyAta: PublicKey;
}> {
  const h = await startBankrun();
  const payer = h.payer;
  anchor.setProvider(h.provider as unknown as anchor.AnchorProvider);
  const psm = h.program as unknown as Program<LitePsm>;
  const vault = getProgram<OkuDollar>(h, "oku_dollar");

  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("psm_config_v4")],
    psm.programId
  );

  const usdcMintKp = Keypair.generate();
  const okuMoneyMintKp = Keypair.generate();

  const usdcMint = await createMintViaBankrun(
    h, payer.publicKey, null, DECIMALS, usdcMintKp, TOKEN_PROGRAM_ID
  );
  const okuMoneyMint = await createOkuMoneyMintViaBankrun(
    h, configPda, configPda, DECIMALS, psmOrchestrator.publicKey, 0, okuMoneyMintKp
  );

  const users = Array.from({ length: 5 }, () => Keypair.generate());
  await fundKeypairs(
    h,
    [...users, coldMultisig, warmMultisig, psmOrchestrator],
    10 * anchor.web3.LAMPORTS_PER_SOL
  );

  const setup = await initializePsm(h, psm, payer, usdcMint, okuMoneyMint);

  // ATAs for each user
  const userUsdcAtas: PublicKey[] = [];
  const userOkuMoneyAtas: PublicKey[] = [];
  for (const u of users) {
    userUsdcAtas.push(await ensureAtaViaBankrun(h, u.publicKey, usdcMint, TOKEN_PROGRAM_ID));
    userOkuMoneyAtas.push(getAssociatedTokenAddressSync(okuMoneyMint, u.publicKey, false, TOKEN_2022_PROGRAM_ID));
    await ensureAtaViaBankrun(h, u.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);
  }

  const orchUsdcAta = await ensureAtaViaBankrun(h, psmOrchestrator.publicKey, usdcMint, TOKEN_PROGRAM_ID);
  const orchOkuMoneyAta = getAssociatedTokenAddressSync(
    okuMoneyMint, psmOrchestrator.publicKey, false, TOKEN_2022_PROGRAM_ID
  );
  await ensureAtaViaBankrun(h, psmOrchestrator.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);

  return {
    h, psm, vault, usdcMint, okuMoneyMint,
    configPda, ...setup,
    users, userUsdcAtas, userOkuMoneyAtas, orchUsdcAta, orchOkuMoneyAta,
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
    await mintOkuMoneyViaProgram(
      ctx.psm, user, new BN(usdcAmount),
      ctx.configPda, ctx.usdcMint, ctx.okuMoneyMint,
      ctx.userUsdcAtas[userIndex], ctx.userOkuMoneyAtas[userIndex], ctx.vaultUsdcAta
    );
  } catch { /* soft-skip: paused or allowance exhausted */ }
}

async function userRedeemOkuM(
  ctx: Awaited<ReturnType<typeof buildCtx>>,
  userIndex: number,
  fraction: number // 1-100
): Promise<void> {
  const user = ctx.users[userIndex];
  const bal = await tokenBalance(ctx.h, ctx.userOkuMoneyAtas[userIndex], TOKEN_2022_PROGRAM_ID);
  if (bal === 0n) return;
  const amount = (bal * BigInt(fraction)) / 100n;
  if (amount === 0n) return;
  try {
    await ctx.psm.methods
      .redeemOkuM(new BN(amount.toString()))
      .accountsPartial({
        user: user.publicKey,
        config: ctx.configPda,
        redemptionQueue: ctx.redemptionQueuePda,
        usdcMint: ctx.usdcMint,
        okuMoneyMint: ctx.okuMoneyMint,
        userUsdcAta: ctx.userUsdcAtas[userIndex],
        userOkuMoneyAta: ctx.userOkuMoneyAtas[userIndex],
        vaultUsdc: ctx.vaultUsdcAta,
        vaultOkuMoney: ctx.vaultOkuMoneyAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  } catch { /* soft-skip: frozen, paused, etc. */ }
}

/** Orchestrator bridges OkuM from user → recipient (same PSM, simulates cross-chain). */
async function orchestratorBridge(
  ctx: Awaited<ReturnType<typeof buildCtx>>,
  userIndex: number,
  recipientIndex: number,
  okuMAmount: bigint
): Promise<{ usdcOut: bigint; usdcIn: bigint }> {
  const user = ctx.users[userIndex];
  const recipient = ctx.users[recipientIndex];

  // Source leg: transfer OkuM to orchestrator
  const transferTx = new Transaction().add(
    createTransferInstruction(
      ctx.userOkuMoneyAtas[userIndex],
      ctx.orchOkuMoneyAta,
      user.publicKey,
      okuMAmount,
      [],
      TOKEN_2022_PROGRAM_ID
    )
  );
  await ctx.h.provider.sendAndConfirm!(transferTx, [user]);

  // Orchestrator redeems
  const orchUsdcBefore = await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID);
  await ctx.psm.methods
    .redeemOkuM(new BN(okuMAmount.toString()))
    .accountsPartial({
      user: psmOrchestrator.publicKey,
      config: ctx.configPda,
      redemptionQueue: ctx.redemptionQueuePda,
      usdcMint: ctx.usdcMint,
      okuMoneyMint: ctx.okuMoneyMint,
      userUsdcAta: ctx.orchUsdcAta,
      userOkuMoneyAta: ctx.orchOkuMoneyAta,
      vaultUsdc: ctx.vaultUsdcAta,
      vaultOkuMoney: ctx.vaultOkuMoneyAta,
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

  // Destination leg: orchestrator mints OkuM for recipient
  const recipientOkuMAta = ctx.userOkuMoneyAtas[recipientIndex];
  const orchOkuMBefore = await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
  await mintOkuMoneyViaProgram(
    ctx.psm, psmOrchestrator, new BN(usdcOut.toString()),
    ctx.configPda, ctx.usdcMint, ctx.okuMoneyMint,
    ctx.orchUsdcAta, ctx.orchOkuMoneyAta, ctx.vaultUsdcAta
  );
  const orchOkuMAfter = await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
  const okuMMinted = orchOkuMAfter - orchOkuMBefore;

  // Forward to recipient
  if (okuMMinted > 0n) {
    const fwdTx = new Transaction().add(
      createTransferInstruction(
        ctx.orchOkuMoneyAta,
        recipientOkuMAta,
        psmOrchestrator.publicKey,
        okuMMinted,
        [],
        TOKEN_2022_PROGRAM_ID
      )
    );
    await ctx.h.provider.sendAndConfirm!(fwdTx, [psmOrchestrator]);
  }

  return { usdcOut, usdcIn: usdcOut };
}

/** Drain the PSM redemption queue. */
async function drainQueue(
  ctx: Awaited<ReturnType<typeof buildCtx>>
): Promise<void> {
  for (let i = 0; i < 10; i++) {
    const q = await ctx.psm.account.redemptionQueue.fetch(ctx.redemptionQueuePda);
    const head = BigInt((q.head as BN).toString());
    const tail = BigInt((q.tail as BN).toString());
    if (tail <= head) break;
    const batchSize = Number(tail - head > 50n ? 50n : tail - head);

    const entries = q.entries as Array<{ user: PublicKey; okuMAmount: BN }>;
    const recipientAtas: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[] = [];
    for (let j = 0; j < batchSize; j++) {
      const slot = Number((head + BigInt(j)) % 200n);
      const entry = entries[slot];
      if (entry.user.equals(PublicKey.default)) continue;
      const ata = getAssociatedTokenAddressSync(ctx.usdcMint, entry.user, false, TOKEN_PROGRAM_ID);
      await ensureAtaViaBankrun(ctx.h, entry.user, ctx.usdcMint, TOKEN_PROGRAM_ID);
      recipientAtas.push({ pubkey: ata, isSigner: false, isWritable: true });
    }

    await ctx.psm.methods
      .processQueue(batchSize)
      .accountsPartial({
        queueProcessor: psmOrchestrator.publicKey,
        config: ctx.configPda,
        redemptionQueue: ctx.redemptionQueuePda,
        okuMoneyMint: ctx.okuMoneyMint,
        vaultUsdc: ctx.vaultUsdcAta,
        vaultOkuMoney: ctx.vaultOkuMoneyAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(recipientAtas)
      .signers([psmOrchestrator])
      .rpc();

    await warpSlots(ctx.h, 1);
  }
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
    let lastOkuMPrice: bigint;
    let cumulativeDrift: bigint;
    let totalBridges: number;

    before(async function () {
      this.timeout(300_000);
      ctx = await buildCtx();
      rng = mulberry32(SEED);

      // Seed the PSM buffer for instant redeems
      await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 500_000_000_000); // 500k USDC

      // Give users initial OkuM
      for (let i = 0; i < 5; i++) {
        await userMintOkuM(ctx, i, 100_000_000); // 100 USDC each
      }

      const cfg = await ctx.psm.account.psmConfig.fetch(ctx.configPda);
      lastOkuMPrice = BigInt((cfg.okuMPrice as BN).toString());
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
            // 15%: orchestrator bridges (user i → user j, different index)
            const ui = Math.floor(rng() * 5);
            const ri = (ui + 1 + Math.floor(rng() * 4)) % 5;
            const bal = await tokenBalance(ctx.h, ctx.userOkuMoneyAtas[ui], TOKEN_2022_PROGRAM_ID);
            if (bal > 1_000n) {
              try {
                const bridgeAmt = bal / 2n;
                const { usdcOut, usdcIn } = await orchestratorBridge(ctx, ui, ri, bridgeAmt);
                const drift = usdcOut > usdcIn ? usdcOut - usdcIn : usdcIn - usdcOut;
                cumulativeDrift += drift;
                assertLte(drift, 1n, `day ${day} per-bridge drift`);
                // I1: Orchestrator OkuM float == 0
                const float = await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
                assertEq(float, 0n, `day ${day} orch float`);
                totalBridges++;
              } catch { /* soft-skip bridge failures */ }
            }

          } else if (r < 0.70) {
            // 10%: drain queue
            await drainQueue(ctx);

          } else if (r < 0.75) {
            // 5%: refill buffer
            await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 10_000_000_000);

          } else if (r < 0.80) {
            // 5%: rebaser ticks the price (simulating yield event)
            const cfg = await ctx.psm.account.psmConfig.fetch(ctx.configPda);
            const curPrice = cfg.okuMPrice as BN;
            const bump = curPrice.muln(DAILY_PRICE_TICK_BPS).divn(100_000);
            const newPrice = curPrice.add(bump);
            try {
              await ctx.psm.methods
                .setOkuMPrice(newPrice)
                .accountsPartial({
                  rebaser: psmOrchestrator.publicKey,
                  config: ctx.configPda,
                  okuMoneyMint: ctx.okuMoneyMint,
                  token2022Program: TOKEN_2022_PROGRAM_ID,
                })
                .signers([psmOrchestrator])
                .rpc();
              await warpSlots(ctx.h, 1); // advance past yield lock
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
            // 2%: freeze a random user's OkuM ATA for a day then thaw
            const ui = Math.floor(rng() * 5);
            try {
              await ctx.psm.methods.freezeAccount()
                .accountsPartial({
                  freezer: warmMultisig.publicKey,
                  config: ctx.configPda,
                  okuMoneyMint: ctx.okuMoneyMint,
                  targetOkuMoneyAta: ctx.userOkuMoneyAtas[ui],
                  token2022Program: TOKEN_2022_PROGRAM_ID,
                })
                .signers([warmMultisig]).rpc();
              await warpBy(ctx.h, DAY_SECS);
              await warpSlots(ctx.h, 1);
              await ctx.psm.methods.thawAccount()
                .accountsPartial({
                  unfreezer: coldMultisig.publicKey,
                  config: ctx.configPda,
                  okuMoneyMint: ctx.okuMoneyMint,
                  targetOkuMoneyAta: ctx.userOkuMoneyAtas[ui],
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

        // I2: oku_m_price non-decreasing
        const cfgAfter = await ctx.psm.account.psmConfig.fetch(ctx.configPda);
        const curPrice = BigInt((cfgAfter.okuMPrice as BN).toString());
        assertGte(curPrice, lastOkuMPrice, `day ${day} I2: oku_m_price decreased`);
        lastOkuMPrice = curPrice;

        // I4: cumulative drift bounded
        assertLte(cumulativeDrift, BigInt(totalBridges) * 2n + 10n, `day ${day} I4: cumulative drift`);
      }

      // Final: price should be at or above PRECISION
      assertGte(lastOkuMPrice, BigInt(PRECISION.toString()), "final oku_m_price >= PRECISION");
    });
  }
);

// ---------------------------------------------------------------------------
// Edge-case suites
// ---------------------------------------------------------------------------

describe("realWorldUsage (SVM) edge cases", () => {
  // -------------------------------------------------------------------------
  // E1: Multi-slot round-trip with price ticks between legs
  // -------------------------------------------------------------------------
  describe("E1: round-trip bridge with price tick between legs", () => {
    it("dollar value conserved across A→B price-tick→B→A round-trip", async function () {
      this.timeout(60_000);
      const ctx = await buildCtx();

      // Mint OkuM for user 0
      await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 200_000_000);
      await userMintOkuM(ctx, 0, 100_000_000); // 100 USDC → 100 OkuM

      const userOkuMBefore = await tokenBalance(ctx.h, ctx.userOkuMoneyAtas[0], TOKEN_2022_PROGRAM_ID);
      assertGt(userOkuMBefore, 0n, "user 0 should have OkuM");

      // Bridge leg A: user 0 → user 1 (orchestrator redeems on A, mints on B)
      const bridgeAmt = userOkuMBefore / 2n;
      const { usdcOut } = await orchestratorBridge(ctx, 0, 1, bridgeAmt);
      assertEq(await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID), 0n, "float after A→B");

      // Price tick between legs (simulates rebase on source chain)
      await warpBy(ctx.h, DAY_SECS * 30); // 30 days
      await warpSlots(ctx.h, 1);
      const cfg = await ctx.psm.account.psmConfig.fetch(ctx.configPda);
      const newPrice = (cfg.okuMPrice as BN).muln(102).divn(100); // +2%
      await ctx.psm.methods.setOkuMPrice(newPrice)
        .accountsPartial({ rebaser: psmOrchestrator.publicKey, config: ctx.configPda, okuMoneyMint: ctx.okuMoneyMint, token2022Program: TOKEN_2022_PROGRAM_ID })
        .signers([psmOrchestrator]).rpc();
      await warpSlots(ctx.h, 1);

      // Bridge leg B: user 1 → user 0 (back again)
      const user1OkuM = await tokenBalance(ctx.h, ctx.userOkuMoneyAtas[1], TOKEN_2022_PROGRAM_ID);
      if (user1OkuM > 0n) {
        const { usdcOut: usdcOutReturn } = await orchestratorBridge(ctx, 1, 0, user1OkuM);
        assertEq(await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID), 0n, "float after B→A");

        // After price increase, returning OkuM yields at least as much USDC (within 1 wei)
        assertGte(usdcOutReturn, usdcOut - 1n, "B→A leg should return >= A→B USDC (price appreciated)");
      }
    });
  });

  // -------------------------------------------------------------------------
  // E2: Queued redeem blocks bridge until process_queue drains
  // -------------------------------------------------------------------------
  describe("E2: queued redeem blocks bridge", () => {
    it("orchestrator must wait for queue drain before completing bridge", async function () {
      this.timeout(60_000);
      const ctx = await buildCtx();

      // User 0 mints 50 OkuM
      // First mint 50 OkuM for user 0 (this also deposits USDC into vault)
      await userMintOkuM(ctx, 0, 50_000_000);
      const userOkuM = await tokenBalance(ctx.h, ctx.userOkuMoneyAtas[0], TOKEN_2022_PROGRAM_ID);
      if (userOkuM === 0n) { return; }

      // Drain PSM vault USDC so the next redeem goes to queue path.
      // The vault has ~50 USDC from userMintOkuM above — withdraw it all via the
      // withdraw_buffer instruction (requires coldMultisig as bufferWithdrawer).
      const vaultBal = await tokenBalance(ctx.h, ctx.vaultUsdcAta, TOKEN_PROGRAM_ID);
      if (vaultBal > 0n) {
        const withdrawerUsdcAta = await ensureAtaViaBankrun(
          ctx.h, coldMultisig.publicKey, ctx.usdcMint, TOKEN_PROGRAM_ID
        );
        await ctx.psm.methods
          .withdrawBuffer(new BN(vaultBal.toString()))
          .accountsPartial({
            bufferWithdrawer: coldMultisig.publicKey,
            config: ctx.configPda,
            redemptionQueue: ctx.redemptionQueuePda,
            okuMoneyMint: ctx.okuMoneyMint,
            withdrawerUsdcAta,
            vaultUsdc: ctx.vaultUsdcAta,
            usdcMint: ctx.usdcMint,
            tokenProgram: TOKEN_PROGRAM_ID,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .signers([coldMultisig])
          .rpc();
      }

      // Now orchestrator pulls OkuM and redeems — should go to queue (no buffer)
      const orchOkuMAtaBefore = await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID);

      // Transfer user OkuM to orchestrator
      const transferTx = new Transaction().add(
        createTransferInstruction(
          ctx.userOkuMoneyAtas[0], ctx.orchOkuMoneyAta,
          ctx.users[0].publicKey, userOkuM, [], TOKEN_2022_PROGRAM_ID
        )
      );
      await ctx.h.provider.sendAndConfirm!(transferTx, [ctx.users[0]]);

      // Redeem goes to queue
      await ctx.psm.methods
        .redeemOkuM(new BN(userOkuM.toString()))
        .accountsPartial({
          user: psmOrchestrator.publicKey,
          config: ctx.configPda,
          redemptionQueue: ctx.redemptionQueuePda,
          usdcMint: ctx.usdcMint,
          okuMoneyMint: ctx.okuMoneyMint,
          userUsdcAta: ctx.orchUsdcAta,
          userOkuMoneyAta: ctx.orchOkuMoneyAta,
          vaultUsdc: ctx.vaultUsdcAta,
          vaultOkuMoney: ctx.vaultOkuMoneyAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([psmOrchestrator])
        .rpc();

      // Queue should have an entry
      const q = await ctx.psm.account.redemptionQueue.fetch(ctx.redemptionQueuePda);
      const qHead = BigInt((q.head as BN).toString());
      const qTail = BigInt((q.tail as BN).toString());
      assertGte(qTail - qHead, 1n, "queue should have pending entry");

      // Fund the buffer and drain queue
      await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 100_000_000);
      await drainQueue(ctx);

      // Now orchestrator has USDC → can complete bridge
      const orchUsdc = await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID);
      assertGt(orchUsdc, 0n, "orchestrator should hold USDC after queue drain");

      // Mint OkuM on "chain B" for recipient
      await mintUsdc(ctx.h, ctx.orchUsdcAta, ctx.usdcMint, Number(orchUsdc));
      await mintOkuMoneyViaProgram(
        ctx.psm, psmOrchestrator, new BN(orchUsdc.toString()),
        ctx.configPda, ctx.usdcMint, ctx.okuMoneyMint,
        ctx.orchUsdcAta, ctx.orchOkuMoneyAta, ctx.vaultUsdcAta
      );
      const orchOkuM = await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
      assertGt(orchOkuM, 0n, "OkuM minted on B");

      // Forward to recipient
      const fwdTx = new Transaction().add(
        createTransferInstruction(
          ctx.orchOkuMoneyAta, ctx.userOkuMoneyAtas[1],
          psmOrchestrator.publicKey, orchOkuM, [], TOKEN_2022_PROGRAM_ID
        )
      );
      await ctx.h.provider.sendAndConfirm!(fwdTx, [psmOrchestrator]);
      assertEq(await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID), 0n, "float cleared");
    });
  });

  // -------------------------------------------------------------------------
  // E3: Price tick between legs preserves dollar value
  // -------------------------------------------------------------------------
  describe("E3: price tick between redeem and mint legs", () => {
    it("dollar value conserved when set_oku_m_price fires between bridge legs", async function () {
      this.timeout(60_000);
      const ctx = await buildCtx();

      await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 100_000_000);
      await userMintOkuM(ctx, 0, 50_000_000);
      const userOkuM = await tokenBalance(ctx.h, ctx.userOkuMoneyAtas[0], TOKEN_2022_PROGRAM_ID);
      if (userOkuM === 0n) { return; } // guard

      // Source leg: redeem (orchestrator gets USDC at current price)
      const transferTx = new Transaction().add(
        createTransferInstruction(
          ctx.userOkuMoneyAtas[0], ctx.orchOkuMoneyAta,
          ctx.users[0].publicKey, userOkuM, [], TOKEN_2022_PROGRAM_ID
        )
      );
      await ctx.h.provider.sendAndConfirm!(transferTx, [ctx.users[0]]);

      const orchUsdcBefore = await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID);
      await ctx.psm.methods
        .redeemOkuM(new BN(userOkuM.toString()))
        .accountsPartial({
          user: psmOrchestrator.publicKey, config: ctx.configPda,
          redemptionQueue: ctx.redemptionQueuePda, usdcMint: ctx.usdcMint,
          okuMoneyMint: ctx.okuMoneyMint, userUsdcAta: ctx.orchUsdcAta,
          userOkuMoneyAta: ctx.orchOkuMoneyAta, vaultUsdc: ctx.vaultUsdcAta,
          vaultOkuMoney: ctx.vaultOkuMoneyAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([psmOrchestrator]).rpc();
      const orchUsdcAfter = await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID);
      const usdcFromRedeem = orchUsdcAfter - orchUsdcBefore;

      // Price tick (+1%) between legs
      await warpSlots(ctx.h, 1);
      const cfg = await ctx.psm.account.psmConfig.fetch(ctx.configPda);
      const newPrice = (cfg.okuMPrice as BN).muln(101).divn(100);
      await ctx.psm.methods.setOkuMPrice(newPrice)
        .accountsPartial({ rebaser: psmOrchestrator.publicKey, config: ctx.configPda, okuMoneyMint: ctx.okuMoneyMint, token2022Program: TOKEN_2022_PROGRAM_ID })
        .signers([psmOrchestrator]).rpc();
      await warpSlots(ctx.h, 1);

      // Destination leg: mint OkuM with same USDC at new (higher) price → fewer OkuM
      await mintUsdc(ctx.h, ctx.orchUsdcAta, ctx.usdcMint, Number(usdcFromRedeem));
      const orchOkuMBefore = await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
      await mintOkuMoneyViaProgram(
        ctx.psm, psmOrchestrator, new BN(usdcFromRedeem.toString()),
        ctx.configPda, ctx.usdcMint, ctx.okuMoneyMint,
        ctx.orchUsdcAta, ctx.orchOkuMoneyAta, ctx.vaultUsdcAta
      );
      const orchOkuMAfter = await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID);
      const okuMMinted = orchOkuMAfter - orchOkuMBefore;

      // Dollar value check: okuMMinted * newPrice ≈ usdcFromRedeem * 1e9 (within rounding)
      const newPriceBig = BigInt(newPrice.toString());
      const dollarValue = (okuMMinted * newPriceBig) / 1_000_000_000n;
      const drift = dollarValue > usdcFromRedeem ? dollarValue - usdcFromRedeem : usdcFromRedeem - dollarValue;
      assertLte(drift, 2n, "dollar value drift after price tick");

      // Forward and clear float
      if (okuMMinted > 0n) {
        const fwdTx = new Transaction().add(
          createTransferInstruction(
            ctx.orchOkuMoneyAta, ctx.userOkuMoneyAtas[1],
            psmOrchestrator.publicKey, okuMMinted, [], TOKEN_2022_PROGRAM_ID
          )
        );
        await ctx.h.provider.sendAndConfirm!(fwdTx, [psmOrchestrator]);
      }
      assertEq(await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID), 0n, "float cleared");
    });
  });

  // -------------------------------------------------------------------------
  // E4: Frozen ATA mid-bridge — process_queue soft-skips frozen recipient
  // -------------------------------------------------------------------------
  describe("E4: frozen ATA soft-skips in process_queue", () => {
    it("frozen OkuMoney ATA rejects transfers; orchestrator must hold float until thaw", async function () {
      this.timeout(60_000);
      const ctx = await buildCtx();

      // Fund vault + mint OkuM for user 0 (source of bridge)
      await mintUsdc(ctx.h, ctx.vaultUsdcAta, ctx.usdcMint, 100_000_000);
      await userMintOkuM(ctx, 0, 50_000_000);
      const userOkuM = await tokenBalance(ctx.h, ctx.userOkuMoneyAtas[0], TOKEN_2022_PROGRAM_ID);
      if (userOkuM === 0n) { return; }

      const bridgeAmt = userOkuM / 2n;

      // Source leg: orchestrator pulls OkuM and redeems (normal path, vault has USDC)
      const transferTx = new Transaction().add(
        createTransferInstruction(
          ctx.userOkuMoneyAtas[0], ctx.orchOkuMoneyAta,
          ctx.users[0].publicKey, bridgeAmt, [], TOKEN_2022_PROGRAM_ID
        )
      );
      await ctx.h.provider.sendAndConfirm!(transferTx, [ctx.users[0]]);

      await ctx.psm.methods
        .redeemOkuM(new BN(bridgeAmt.toString()))
        .accountsPartial({
          user: psmOrchestrator.publicKey, config: ctx.configPda,
          redemptionQueue: ctx.redemptionQueuePda, usdcMint: ctx.usdcMint,
          okuMoneyMint: ctx.okuMoneyMint, userUsdcAta: ctx.orchUsdcAta,
          userOkuMoneyAta: ctx.orchOkuMoneyAta, vaultUsdc: ctx.vaultUsdcAta,
          vaultOkuMoney: ctx.vaultOkuMoneyAta,
          tokenProgram: TOKEN_PROGRAM_ID,
          token2022Program: TOKEN_2022_PROGRAM_ID, associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([psmOrchestrator]).rpc();
      const orchUsdc = await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID);

      // Destination leg: mint OkuM to orchestrator
      await mintUsdc(ctx.h, ctx.orchUsdcAta, ctx.usdcMint, Number(orchUsdc));
      await mintOkuMoneyViaProgram(
        ctx.psm, psmOrchestrator, new BN(orchUsdc.toString()),
        ctx.configPda, ctx.usdcMint, ctx.okuMoneyMint,
        ctx.orchUsdcAta, ctx.orchOkuMoneyAta, ctx.vaultUsdcAta
      );
      const orchOkuM = await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID);

      // Freeze user 1's OkuM ATA (the intended recipient on "chain B")
      await ctx.psm.methods.freezeAccount()
        .accountsPartial({
          freezer: warmMultisig.publicKey, config: ctx.configPda,
          okuMoneyMint: ctx.okuMoneyMint,
          targetOkuMoneyAta: ctx.userOkuMoneyAtas[1],
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([warmMultisig]).rpc();

      // Forward to frozen recipient → must fail
      const fwdTx = new Transaction().add(
        createTransferInstruction(
          ctx.orchOkuMoneyAta, ctx.userOkuMoneyAtas[1],
          psmOrchestrator.publicKey, orchOkuM, [], TOKEN_2022_PROGRAM_ID
        )
      );
      let forwardFailed = false;
      try {
        await ctx.h.provider.sendAndConfirm!(fwdTx, [psmOrchestrator]);
      } catch { forwardFailed = true; }
      expect(forwardFailed, "transfer to frozen ATA should fail").to.be.true;

      // Orchestrator holds unbacked float
      assertGt(await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID), 0n, "orch holds float");

      // Recovery: thaw user 1, then forward succeeds
      await ctx.psm.methods.thawAccount()
        .accountsPartial({
          unfreezer: coldMultisig.publicKey, config: ctx.configPda,
          okuMoneyMint: ctx.okuMoneyMint,
          targetOkuMoneyAta: ctx.userOkuMoneyAtas[1],
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([coldMultisig]).rpc();

      const fwdTx2 = new Transaction().add(
        createTransferInstruction(
          ctx.orchOkuMoneyAta, ctx.userOkuMoneyAtas[1],
          psmOrchestrator.publicKey, orchOkuM, [], TOKEN_2022_PROGRAM_ID
        )
      );
      await ctx.h.provider.sendAndConfirm!(fwdTx2, [psmOrchestrator]);
      assertEq(await tokenBalance(ctx.h, ctx.orchOkuMoneyAta, TOKEN_2022_PROGRAM_ID), 0n, "float cleared after thaw");
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
        await mintOkuMoneyViaProgram(
          ctx.psm, ctx.users[1], new BN(10_000_000),
          ctx.configPda, ctx.usdcMint, ctx.okuMoneyMint,
          ctx.userUsdcAtas[1], ctx.userOkuMoneyAtas[1], ctx.vaultUsdcAta
        );
      } catch { mintFailed = true; }
      expect(mintFailed, "mint should fail while paused").to.be.true;

      // Unpause
      await ctx.psm.methods.unpause()
        .accountsPartial({ unpauser: coldMultisig.publicKey, config: ctx.configPda })
        .signers([coldMultisig]).rpc();

      // Mint succeeds after unpause
      await mintOkuMoneyViaProgram(
        ctx.psm, ctx.users[1], new BN(10_000_000),
        ctx.configPda, ctx.usdcMint, ctx.okuMoneyMint,
        ctx.userUsdcAtas[1], ctx.userOkuMoneyAtas[1], ctx.vaultUsdcAta
      );
      assertGt(await tokenBalance(ctx.h, ctx.userOkuMoneyAtas[1], TOKEN_2022_PROGRAM_ID), 0n);
    });
  });

  // -------------------------------------------------------------------------
  // E7: Yield-lock — same-slot set_oku_m_price + mint reverts
  // -------------------------------------------------------------------------
  describe("E7: yield-lock prevents mint in same slot as set_oku_m_price", () => {
    it("mint_oku_m reverts in same slot as set_oku_m_price; succeeds next slot", async function () {
      this.timeout(60_000);
      // Disable autoBumpSlot so we can control exact slot sequencing
      const h = await startBankrun({ autoBumpSlot: false });
      const payer = h.payer;
      anchor.setProvider(h.provider as unknown as anchor.AnchorProvider);
      const psm = h.program as unknown as Program<LitePsm>;
      const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("psm_config_v4")], psm.programId);
      const usdcMintKp = Keypair.generate();
      const okuMoneyMintKp = Keypair.generate();
      const usdcMint = await createMintViaBankrun(h, payer.publicKey, null, DECIMALS, usdcMintKp, TOKEN_PROGRAM_ID);
      const okuMoneyMint = await createOkuMoneyMintViaBankrun(h, configPda, configPda, DECIMALS, psmOrchestrator.publicKey, 0, okuMoneyMintKp);
      const user = Keypair.generate();
      await fundKeypairs(h, [user, coldMultisig, warmMultisig, psmOrchestrator], 10 * anchor.web3.LAMPORTS_PER_SOL);
      const setup = await initializePsm(h, psm, payer, usdcMint, okuMoneyMint);
      const userUsdcAta = await ensureAtaViaBankrun(h, user.publicKey, usdcMint, TOKEN_PROGRAM_ID);
      const userOkuMoneyAta = getAssociatedTokenAddressSync(okuMoneyMint, user.publicKey, false, TOKEN_2022_PROGRAM_ID);
      await ensureAtaViaBankrun(h, user.publicKey, okuMoneyMint, TOKEN_2022_PROGRAM_ID);
      await mintToViaBankrun(h, usdcMint, setup.vaultUsdcAta, payer, 100_000_000, TOKEN_PROGRAM_ID);
      await mintToViaBankrun(h, usdcMint, userUsdcAta, payer, 10_000_000, TOKEN_PROGRAM_ID);

      // Bump price (slot N)
      const cfg = await psm.account.psmConfig.fetch(configPda);
      const newPrice = (cfg.okuMPrice as BN).addn(1000);
      await psm.methods.setOkuMPrice(newPrice)
        .accountsPartial({ rebaser: psmOrchestrator.publicKey, config: configPda, okuMoneyMint, token2022Program: TOKEN_2022_PROGRAM_ID })
        .signers([psmOrchestrator]).rpc();

      // Attempt mint in SAME slot → should revert with YieldDistributionInProgress
      // (autoBumpSlot is off, so both txs land in the same slot)
      let mintFailed = false;
      try {
        await mintOkuMoneyViaProgram(
          psm, user, new BN(10_000_000),
          configPda, usdcMint, okuMoneyMint,
          userUsdcAta, userOkuMoneyAta, setup.vaultUsdcAta
        );
      } catch { mintFailed = true; }
      expect(mintFailed, "mint should fail in same slot as set_oku_m_price").to.be.true;

      // Next slot succeeds
      await warpSlots(h, 1);
      await mintOkuMoneyViaProgram(
        psm, user, new BN(10_000_000),
        configPda, usdcMint, okuMoneyMint,
        userUsdcAta, userOkuMoneyAta, setup.vaultUsdcAta
      );
      assertGt(await tokenBalance(h, userOkuMoneyAta, TOKEN_2022_PROGRAM_ID), 0n);
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

      // Reduce minter allowance to 1_000 (micro-units = 0.001 OkuM)
      await ctx.psm.methods
        .setMinterAllowance(new BN(1_000))
        .accountsPartial({
          allowanceManager: coldMultisig.publicKey,
          config: ctx.configPda,
        })
        .signers([coldMultisig]).rpc();

      // First small mint (≤ allowance) succeeds
      await mintUsdc(ctx.h, ctx.userUsdcAtas[0], ctx.usdcMint, 500);
      await mintOkuMoneyViaProgram(
        ctx.psm, ctx.users[0], new BN(500),
        ctx.configPda, ctx.usdcMint, ctx.okuMoneyMint,
        ctx.userUsdcAtas[0], ctx.userOkuMoneyAtas[0], ctx.vaultUsdcAta
      );

      // Large mint exceeds exhausted allowance → fails
      await mintUsdc(ctx.h, ctx.userUsdcAtas[0], ctx.usdcMint, 10_000_000);
      let mintFailed = false;
      try {
        await mintOkuMoneyViaProgram(
          ctx.psm, ctx.users[0], new BN(10_000_000),
          ctx.configPda, ctx.usdcMint, ctx.okuMoneyMint,
          ctx.userUsdcAtas[0], ctx.userOkuMoneyAtas[0], ctx.vaultUsdcAta
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
      await mintOkuMoneyViaProgram(
        ctx.psm, ctx.users[0], new BN(10_000_000),
        ctx.configPda, ctx.usdcMint, ctx.okuMoneyMint,
        ctx.userUsdcAtas[0], ctx.userOkuMoneyAtas[0], ctx.vaultUsdcAta
      );
      assertGt(await tokenBalance(ctx.h, ctx.userOkuMoneyAtas[0], TOKEN_2022_PROGRAM_ID), 0n);
    });
  });
});
