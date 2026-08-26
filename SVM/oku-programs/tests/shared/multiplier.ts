/**
 * Multiplier-stepping helpers for tests.
 *
 * # Why these exist
 *
 * The program enforces `step_bps <= MAX_STEP_BPS` (5 = 0.05%), so a single
 * multiplier increase can never exceed 5 bps. Coverage itself no longer enters
 * into it: `set_fees` floors each leg at `MAX_STEP_BPS`, so every step the
 * program admits is already covered and there is no fee to arrange per step.
 *
 * That is a real production property, not a test artifact — you cannot jump the
 * multiplier, you can only walk it. A suite that wants a materially higher
 * multiplier has to take several steps, exactly as an operator would after an
 * outage. `stepMultiplierTo` encodes that walk once so individual tests do not
 * each reinvent it.
 *
 * The walk got 20x longer when `MAX_STEP_BPS` was tightened from 100 to 5, so
 * the iteration guard below is sized accordingly. A suite needing a multiplier
 * far from 1.0 should reconsider whether it needs the real walk at all.
 *
 * Each step also trips two independent guards that have to be cleared between
 * iterations:
 *   - the same-slot yield fence (`last_yield_distribution_slot`)
 *   - the cross-chain sync window, if the inter-window gap has elapsed
 */

import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import type { Keypair } from '@solana/web3.js';
import {
  BankrunHarness,
  readMultiplierFromMint,
  warpBy,
  warpSlots,
} from './bankrun';
import { MAX_FEE_BPS, MAX_STEP_BPS, MIN_MARK_INTERVAL_SECS } from './setup';

const BASIS_POINTS = 10_000;

/**
 * Largest multiplier reachable from `current` in one covered step.
 *
 * Deliberately leaves 1% headroom under the true ceiling. The multiplier is
 * stored on the mint as an `f64` and round-tripped through
 * `(value * PRECISION).round()`, so the integer this client reads back can
 * differ from the program's own view by a unit or two. Stepping to the exact
 * ceiling would intermittently land a hair over it and trip `StepAboveMax`
 * non-deterministically.
 */
export function maxCoveredStep(current: BN, stepBps: number = MAX_STEP_BPS): BN {
  const delta = current.muln(stepBps).divn(BASIS_POINTS);
  return current.add(delta.muln(99).divn(100));
}

/**
 * Write `target` as the new multiplier in as many covered steps as it takes,
 * clearing the yield fence and any armed sync window between iterations.
 *
 * The final step is clamped to `target`, so the multiplier lands on it exactly
 * rather than overshooting. Returns the value reached.
 */
export async function stepMultiplierTo(
  h: BankrunHarness,
  program: Program,
  rebaser: Keypair,
  configPda: PublicKey,
  okuMMint: PublicKey,
  target: BN,
  stepBps: number = MAX_STEP_BPS
): Promise<BN> {
  let current = await readMultiplierFromMint(h, okuMMint);
  let guard = 0;

  while (current.lt(target)) {
    if (++guard > 8192) {
      throw new Error(
        `stepMultiplierTo: ${target.toString()} unreachable from ${current.toString()} ` +
          `in 8192 steps at ${stepBps}bps each`
      );
    }

    const ceiling = maxCoveredStep(current, stepBps);
    const next = target.lt(ceiling) ? target : ceiling;
    if (next.lte(current)) {
      throw new Error(
        `stepMultiplierTo: no progress possible at ${stepBps}bps steps ` +
          `(current=${current.toString()}). A nonzero tout is required to move ` +
          `the multiplier at all.`
      );
    }

    await program.methods
      .setMultiplier(next)
      .accountsPartial({
        rebaser: rebaser.publicKey,
        config: configPda,
        okuMMint,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .signers([rebaser])
      .rpc();

    // Clear the same-slot fence, then any window the write armed, then the
    // MARK CADENCE — `MIN_MARK_INTERVAL_SECS` gates the next mark, so a walk
    // has to advance the wall clock between iterations as well as the slot.
    await warpSlots(h, 1);
    await clearSyncWindow(h, program, configPda);
    await warpBy(h, MIN_MARK_INTERVAL_SECS);

    current = await readMultiplierFromMint(h, okuMMint);
  }

  return current;
}

/**
 * Write one covered multiplier step and settle both guards it trips.
 *
 * The dominant pattern in the suite is "move the multiplier, then transact".
 * Post-hardening that needs two follow-ups every time — a slot bump for the
 * same-slot yield fence, and a wall-clock warp past any sync window the write
 * armed. This bundles them so tests state their intent rather than their
 * plumbing.
 *
 * Rejects a step the current fee cannot cover, rather than letting the program
 * produce a confusing `StepExceedsFeeCoverage` deep inside a test: use
 * `stepMultiplierTo` when the target is more than one step away.
 */
export async function setMultiplierAndSettle(
  h: BankrunHarness,
  program: Program,
  rebaser: Keypair,
  configPda: PublicKey,
  okuMMint: PublicKey,
  next: BN
): Promise<void> {
  await program.methods
    .setMultiplier(next)
    .accountsPartial({
      rebaser: rebaser.publicKey,
      config: configPda,
      okuMMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers([rebaser])
    .rpc();

  await warpSlots(h, 1);
  await clearSyncWindow(h, program, configPda);
}

/**
 * Warp past an armed sync window so price-sensitive instructions are callable.
 *
 * Wall-clock expiry is the ONLY way out: there is no close instruction. Every
 * multiplier write arms the window and nothing but the clock releases it, which
 * is what makes the liveness backstop structural rather than a fallback path.
 */
export async function clearSyncWindow(
  h: BankrunHarness,
  program: Program,
  configPda: PublicKey
): Promise<void> {
  const cfg: any = await program.account.psmConfig.fetch(configPda);
  const lockUntil = Number(cfg.syncLockUntilTs.toString());
  if (lockUntil === 0) return;

  const nowTs = Math.floor(Date.now() / 1000);
  const clockTs = await currentUnixTs(h);
  const reference = Number.isFinite(clockTs) ? clockTs : nowTs;

  if (reference < lockUntil) {
    await warpBy(h, lockUntil - reference + 1);
  }
}

async function currentUnixTs(h: BankrunHarness): Promise<number> {
  const clock = await h.context.banksClient.getClock();
  return Number(clock.unixTimestamp);
}

/**
 * Net USDC a redemption of `raw` at `multiplier` pays after `toutBps`.
 *
 * Mirrors the program exactly: floor the gross conversion, ceil the fee.
 * Tests that assert payout amounts must go through this — a fee-free
 * expectation silently became wrong the moment `tout` was enabled.
 */
export function expectedRedeemNet(
  raw: BN,
  multiplier: BN,
  precision: BN,
  toutBps: number = MAX_FEE_BPS
): BN {
  const gross = raw.mul(multiplier).div(precision);
  if (toutBps === 0) return gross;
  const fee = gross.muln(toutBps).addn(BASIS_POINTS - 1).divn(BASIS_POINTS); // ceil
  return gross.sub(fee);
}

/**
 * Net USDC credited on a mint of `usdcIn` after `tinBps`.
 *
 * The mint-side twin of `expectedRedeemNet`. Defaults to `tin = 0`, which is
 * what ships — so a 1:1 mint expectation is correct again by default, and this
 * helper is only needed by suites that deliberately raise `tin`.
 */
export function expectedMintNet(usdcIn: BN, tinBps: number = 0): BN {
  if (tinBps === 0) return usdcIn;
  const fee = usdcIn.muln(tinBps).addn(BASIS_POINTS - 1).divn(BASIS_POINTS); // ceil
  return usdcIn.sub(fee);
}
