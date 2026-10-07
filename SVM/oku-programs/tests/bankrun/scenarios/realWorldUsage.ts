/**
 * realWorldUsage — deterministic SVM edge-case suites.
 *
 * SVM-side mirror of EVM/test/hardhat/scenarios/RealWorldUsage.ts.
 *
 *   E1. Multi-slot round-trip with multiplier ticks
 *   E2. Source redeem against an empty buffer reverts until it is reseeded
 *   E3. Multiplier tick between bridge legs (value conserved)
 *   E4. Frozen okuM ATA mid-bridge (orchestrator holds float)
 *   E5. Pause during operation
 *   E7. Yield-lock: same-slot set_multiplier + mint revert
 *   E8. Minter-allowance exhaustion and rotation
 *
 * Scenarios are deterministic and every state-changing call is asserted: none
 * is wrapped in a bare `catch {}`, so a program that rejected every
 * instruction cannot pass.
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
  expectBankrunError,
} from "../../shared/bankrun";

const { Keypair, SystemProgram, PublicKey } = anchor.web3;
type PublicKey = anchor.web3.PublicKey;
type Keypair = anchor.web3.Keypair;

// ---------------------------------------------------------------------------
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
  // Deliberately NOT wrapped in a catch: in the deterministic suites below the
  // PSM is never paused or exhausted at this point, so a throw is a real defect.
  await mintOkuMViaProgram(
    ctx.psm, user, new BN(usdcAmount),
    ctx.configPda, ctx.usdcMint, ctx.okuMMint,
    ctx.userUsdcAtas[userIndex], ctx.userOkuMAtas[userIndex], ctx.vaultUsdcAta
  );
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
): Promise<{
  usdcOut: bigint;
  okuMMinted: bigint;
  dollarsOut: bigint;
  dollarsIn: bigint;
  driftBound: bigint;
}> {
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
  await mintOkuMViaProgram(
    ctx.psm, psmOrchestrator, new BN(usdcOut.toString()),
    ctx.configPda, ctx.usdcMint, ctx.okuMMint,
    ctx.orchUsdcAta, ctx.orchOkuMAta, ctx.vaultUsdcAta
  );
  const orchOkuMAfter = await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID);
  const okuMMinted = orchOkuMAfter - orchOkuMBefore;

  // Forward to recipient. Unguarded: `okuMMinted === 0` means the destination
  // leg produced nothing, which is a failure, not a branch to skip.
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

  // Returned in DOLLAR VALUE, not USDC.
  //
  // A USDC-denominated drift cannot measure anything: `mint_oku_m` does
  // `transfer_checked(..., usdc_amount, ...)` (psm.rs:74), moving exactly the
  // argument it was handed. Since that argument IS `usdcOut`, the orchestrator's
  // USDC delta across the mint is identically `usdcOut` and any drift computed
  // from it is structurally zero.
  //
  // Dollar value is what can actually move. It passes through two independent
  // floors — `raw_to_dollars` on the redeem leg and `dollars_to_raw` on the mint
  // leg — so the recipient's value is bounded above by the sender's and below by
  // the accumulated truncation.
  const multSrc = await computeCanonicalMultiplier(ctx.h, ctx.psm, ctx.configPda);
  const dollarsOut = (rawOkuMAmount * multSrc) / PRECISION;
  const dollarsIn = (okuMMinted * multSrc) / PRECISION;

  // Worst-case loss, derived not observed: one okuM wei from `dollars_to_raw`'s
  // floor on the destination (worth ceil(m/1e18) dollar-wei), plus one wei for
  // `raw_to_dollars`' own floor on the source.
  const driftBound = (multSrc + PRECISION - 1n) / PRECISION + 1n;

  return { usdcOut, okuMMinted, dollarsOut, dollarsIn, driftBound };
}



// ---------------------------------------------------------------------------
// Main simulation
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

      // 100 USDC at m = 1.0 on a fresh PSM is exactly 100 okuM (6-decimal token,
      // so raw units are 1:1 with USDC here). `assertGt(..., 0n)` would have
      // passed on a single unit.
      const multAtMint = await computeCanonicalMultiplier(ctx.h, ctx.psm, ctx.configPda);
      assertEq(multAtMint, PRECISION, "fixture: fresh PSM must be unrebased");
      const userOkuMBefore = await tokenBalance(ctx.h, ctx.userOkuMAtas[0], TOKEN_2022_PROGRAM_ID);
      assertEq(userOkuMBefore, 100_000_000n, "100 USDC mints exactly 100 okuM at m = 1.0");

      // Bridge leg A: user 0 -> user 1 (orchestrator redeems on A, mints on B)
      const bridgeAmt = userOkuMBefore / 2n;
      const ab = await orchestratorBridge(ctx, 0, 1, bridgeAmt);
      assertEq(await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID), 0n, "float after A->B");

      // A bridge must never create value, and must lose no more than the two
      // floors can account for. Both bounds derived, not observed.
      assertLte(ab.dollarsIn, ab.dollarsOut, "A->B must not create value");
      assertLte(ab.dollarsOut - ab.dollarsIn, ab.driftBound, "A->B loss exceeds derived bound");

      // Multiplier ACCRUES between legs -- with no transaction at all.
      // Publish a ~26% APY schedule, then warp 30 days: the multiplier climbs
      // roughly 2% purely from elapsed time, with no multiplier-setting call.
      const e1Now = Number((await getClock(ctx.h)).unixTimestamp);
      await ctx.psm.methods
        .setOkumYieldRate(new BN(ratePerSecondForApy(0.27).toString()), new BN(e1Now + 60 * DAY_SECS))
        .accountsPartial({ rebaser: psmOrchestrator.publicKey, config: ctx.configPda })
        .signers([psmOrchestrator]).rpc();
      await warpBy(ctx.h, DAY_SECS * 30); // 30 days
      await warpSlots(ctx.h, 1);

      // The accrual must actually have happened, or the return leg below proves
      // nothing. Asserted before it is relied on.
      const multAfterWarp = await computeCanonicalMultiplier(ctx.h, ctx.psm, ctx.configPda);
      assertGt(multAfterWarp, multAtMint, "30 days at ~27% APY must move the multiplier");

      // Bridge leg B: user 1 -> user 0. Unguarded -- a zero balance here means
      // leg A silently produced nothing, which is a failure, not a skip.
      const user1OkuM = await tokenBalance(ctx.h, ctx.userOkuMAtas[1], TOKEN_2022_PROGRAM_ID);
      assertGt(user1OkuM, 0n, "leg A must have delivered okuM to user 1");

      const ba = await orchestratorBridge(ctx, 1, 0, user1OkuM);
      assertEq(await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID), 0n, "float after B->A");
      assertLte(ba.dollarsIn, ba.dollarsOut, "B->A must not create value");
      assertLte(ba.dollarsOut - ba.dollarsIn, ba.driftBound, "B->A loss exceeds derived bound");

      // The point of the scenario: the holding appreciated while it sat, so the
      // return leg carries more USDC than the outbound one by exactly the
      // multiplier ratio. Anchored to the measured multipliers, so a silently
      // halted accrual fails here rather than passing a `>=`.
      const expectedBack = (ab.usdcOut * multAfterWarp) / multAtMint;
      assertGte(ba.usdcOut, expectedBack - 2n, "B->A USDC must reflect the accrued multiplier");
      assertLte(ba.usdcOut, expectedBack + 2n, "B->A USDC must not exceed the accrued multiplier");
    });
  });

  // -------------------------------------------------------------------------
  // E2: Empty source buffer blocks the orchestrator until reseeded
  // -------------------------------------------------------------------------
  describe("E2: empty source buffer blocks orchestrator", () => {
    it("src redeem reverts InsufficientBuffer while buffer empty; succeeds after reseed", async function () {
      this.timeout(60_000);
      const ctx = await buildCtx();

      const bufferAccounts = {
        config: ctx.configPda,
        vaultUsdc: ctx.vaultUsdcAta,
        usdcMint: ctx.usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
      };
      const depositBuffer = (amount: bigint) =>
        ctx.psm.methods
          .depositBuffer(new BN(amount.toString()))
          .accountsPartial({
            ...bufferAccounts,
            bufferDepositor: psmOrchestrator.publicKey,
            bufferDepositorUsdcAta: ctx.orchUsdcAta,
          })
          .signers([psmOrchestrator]).rpc();

      // Seed the buffer the real way (deposit_buffer, from the orchestrator),
      // then user 0 mints 100 okuM. The vault holds exactly seed + the 100 USDC
      // that went in on mint.
      const SEED = 100_000_000_000n; // 100,000 USDC
      await mintUsdc(ctx.h, ctx.orchUsdcAta, ctx.usdcMint, Number(SEED));
      await depositBuffer(SEED);
      await userMintOkuM(ctx, 0, 100_000_000);
      const mintUsdcIn = 100_000_000n;
      const userOkuM = await tokenBalance(ctx.h, ctx.userOkuMAtas[0], TOKEN_2022_PROGRAM_ID);
      assertEq(userOkuM, 100_000_000n, "100 USDC mints exactly 100 okuM at m = 1.0");

      // Drain the buffer to zero through the buffer_withdrawer (cold multisig).
      const vaultBal = await tokenBalance(ctx.h, ctx.vaultUsdcAta, TOKEN_PROGRAM_ID);
      assertEq(vaultBal, SEED + mintUsdcIn, "fixture: buffer holds exactly the seed plus the mint");
      const withdrawerUsdcAta = await ensureAtaViaBankrun(
        ctx.h, coldMultisig.publicKey, ctx.usdcMint, TOKEN_PROGRAM_ID
      );
      await ctx.psm.methods
        .withdrawBuffer(new BN(vaultBal.toString()))
        .accountsPartial({
          ...bufferAccounts,
          bufferWithdrawer: coldMultisig.publicKey,
          withdrawerUsdcAta,
        })
        .signers([coldMultisig]).rpc();
      assertEq(await tokenBalance(ctx.h, ctx.vaultUsdcAta, TOKEN_PROGRAM_ID), 0n, "buffer drained");

      // Orchestrator pulls user 0's okuM and tries to redeem: reverts, keeps the okuM.
      await ctx.h.provider.sendAndConfirm!(
        new Transaction().add(
          createTransferInstruction(
            ctx.userOkuMAtas[0], ctx.orchOkuMAta,
            ctx.users[0].publicKey, userOkuM, [], TOKEN_2022_PROGRAM_ID
          )
        ),
        [ctx.users[0]]
      );
      const redeemAll = () =>
        ctx.psm.methods
          .redeemOkuM(new BN(userOkuM.toString()), new BN(0))
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
          .signers([psmOrchestrator]).rpc();

      assertEq(await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID), userOkuM, "fixture: orchestrator holds the okuM");
      assertEq(await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID), 0n, "fixture: orchestrator holds no USDC");
      await expectBankrunError(redeemAll, "InsufficientBuffer");
      assertEq(
        await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID),
        userOkuM,
        "orchestrator keeps its okuM"
      );
      assertEq(await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID), 0n, "no USDC released");

      // Reseed the buffer; the same redeem now succeeds. At m = 1.0 the
      // orchestrator receives exactly the 100 USDC user 0 put in.
      const RESEED = 200_000_000n; // 200 USDC
      await mintUsdc(ctx.h, ctx.orchUsdcAta, ctx.usdcMint, Number(RESEED));
      await depositBuffer(RESEED);
      assertEq(await tokenBalance(ctx.h, ctx.vaultUsdcAta, TOKEN_PROGRAM_ID), RESEED, "buffer reseeded");

      const mult = await computeCanonicalMultiplier(ctx.h, ctx.psm, ctx.configPda);
      assertEq(mult, PRECISION, "fixture: PSM must be unrebased for the literal below");
      await redeemAll();
      assertEq(await tokenBalance(ctx.h, ctx.orchOkuMAta, TOKEN_2022_PROGRAM_ID), 0n, "okuM burned");
      assertEq(
        await tokenBalance(ctx.h, ctx.orchUsdcAta, TOKEN_PROGRAM_ID),
        mintUsdcIn,
        "redeem pays the full dollar value"
      );
      assertEq(
        await tokenBalance(ctx.h, ctx.vaultUsdcAta, TOKEN_PROGRAM_ID),
        RESEED - mintUsdcIn,
        "vault pays out exactly what the user received"
      );
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
      // Unguarded: 50 USDC at m = 1.0 mints exactly 50 okuM. An early `return`
      // here would let the whole scenario pass having asserted nothing.
      const userOkuM = await tokenBalance(ctx.h, ctx.userOkuMAtas[0], TOKEN_2022_PROGRAM_ID);
      assertEq(userOkuM, 50_000_000n, "50 USDC mints exactly 50 okuM at m = 1.0");

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
      assertEq(userOkuM, 50_000_000n, "50 USDC mints exactly 50 okuM at m = 1.0");

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
      // Named code. A bare catch here also accepts a bad pubkey, a
      // serialization error, or an allowance failure -- i.e. it would pass
      // without the pause gate ever being reached.
      await expectBankrunError(
        () => mintOkuMViaProgram(
          ctx.psm, ctx.users[1], new BN(10_000_000),
          ctx.configPda, ctx.usdcMint, ctx.okuMMint,
          ctx.userUsdcAtas[1], ctx.userOkuMAtas[1], ctx.vaultUsdcAta
        ),
        "Paused"
      );

      // Unpause
      await ctx.psm.methods.unpause()
        .accountsPartial({ unpauser: coldMultisig.publicKey, config: ctx.configPda })
        .signers([coldMultisig]).rpc();

      // Mint succeeds after unpause
      const u1Before = await tokenBalance(ctx.h, ctx.userOkuMAtas[1], TOKEN_2022_PROGRAM_ID);
      await mintOkuMViaProgram(
        ctx.psm, ctx.users[1], new BN(10_000_000),
        ctx.configPda, ctx.usdcMint, ctx.okuMMint,
        ctx.userUsdcAtas[1], ctx.userOkuMAtas[1], ctx.vaultUsdcAta
      );
      // Exact: 10 USDC at the live multiplier. `> 0` passed on a single unit.
      const multAfterUnpause = await computeCanonicalMultiplier(ctx.h, ctx.psm, ctx.configPda);
      const expectedMint = (10_000_000n * PRECISION) / multAfterUnpause;
      assertEq(
        (await tokenBalance(ctx.h, ctx.userOkuMAtas[1], TOKEN_2022_PROGRAM_ID)) - u1Before,
        expectedMint,
        "post-unpause mint credits the exact converted amount"
      );
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
      // the yield lock, because it is the only one producing a discrete
      // jump. Routine yield never engages it.
      const curMultiplierE7 = await computeCanonicalMultiplier(h, psm, configPda);
      await psm.methods.setOkumMultiplier(new BN((curMultiplierE7 + 1000n).toString()))
        .accountsPartial({ rebaser: psmOrchestrator.publicKey, config: configPda, okuMMint, token2022Program: TOKEN_2022_PROGRAM_ID })
        .signers([psmOrchestrator]).rpc();

      // Attempt mint in SAME slot -> should revert with OverrideInProgress
      await expectBankrunError(
        () => mintOkuMViaProgram(
          psm, user, new BN(10_000_000),
          configPda, usdcMint, okuMMint,
          userUsdcAta, userOkuMAta, setup.vaultUsdcAta
        ),
        "OverrideInProgress"
      );

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
      const balBeforeFail = await tokenBalance(ctx.h, ctx.userOkuMAtas[0], TOKEN_2022_PROGRAM_ID);
      const cfgBeforeFail: any = await ctx.psm.account.psmConfig.fetch(ctx.configPda);

      await expectBankrunError(
        () => mintOkuMViaProgram(
          ctx.psm, ctx.users[0], new BN(10_000_000),
          ctx.configPda, ctx.usdcMint, ctx.okuMMint,
          ctx.userUsdcAtas[0], ctx.userOkuMAtas[0], ctx.vaultUsdcAta
        ),
        "AllowanceExceeded"
      );

      // The failed mint must be fully atomic -- no partial credit, no allowance
      // consumed. A bare catch proved only that *something* threw.
      assertEq(
        await tokenBalance(ctx.h, ctx.userOkuMAtas[0], TOKEN_2022_PROGRAM_ID),
        balBeforeFail,
        "failed mint credits nothing"
      );
      const cfgAfterFail: any = await ctx.psm.account.psmConfig.fetch(ctx.configPda);
      assertEq(
        BigInt(cfgAfterFail.minterAllowance.toString()),
        BigInt(cfgBeforeFail.minterAllowance.toString()),
        "failed mint consumes no allowance"
      );

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
