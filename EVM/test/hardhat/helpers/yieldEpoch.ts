/**
 * Yield-epoch helpers for the Hardhat integration/fork suites.
 *
 * `okuMMultiplier` accrues continuously over an epoch and can no longer be
 * written directly. These helpers drive it through the only production path —
 * `startYieldEpoch` plus the passage of time — mirroring
 * `EVM/test/Base.t.sol`'s Solidity equivalents.
 *
 * See `EVM/README.md § Continuous yield epochs` for why the multiplier streams
 * rather than steps.
 */

import { network } from "hardhat";

export const PRECISION = 10n ** 18n;
export const BASIS_POINTS = 10_000n;
export const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
export const MAX_IMPLIED_APR_BPS = 2000n;
export const MIN_EPOCH_DURATION = 3600n;
export const MAX_EPOCH_DURATION = 365n * 24n * 60n * 60n;

/** Advance chain time by `seconds` and mine, so accrual is realised. */
export async function warp(seconds: bigint | number): Promise<void> {
  await network.provider.send("evm_increaseTime", [Number(seconds)]);
  await network.provider.send("evm_mine", []);
}

/**
 * Shortest duration over which `yieldAmount` satisfies `MAX_IMPLIED_APR_BPS`
 * at the current supply and multiplier.
 *
 * Inverts the on-chain APR check. If a distribution is rejected the fix is to
 * stream it over LONGER, not to shrink the amount — this computes how long.
 */
export async function minLegalDuration(okuMoney: any, yieldAmount: bigint): Promise<bigint> {
  const supply: bigint = await okuMoney.totalSupply();
  if (supply === 0n) return MIN_EPOCH_DURATION;
  const current: bigint = await okuMoney.okuMMultiplier();
  const delta = (yieldAmount * PRECISION) / supply;
  const needed =
    (delta * SECONDS_PER_YEAR * BASIS_POINTS) / (current * MAX_IMPLIED_APR_BPS) + 2n;
  if (needed < MIN_EPOCH_DURATION) return MIN_EPOCH_DURATION;
  if (needed > MAX_EPOCH_DURATION) {
    throw new Error(
      `yieldAmount ${yieldAmount} cannot be streamed within MAX_EPOCH_DURATION ` +
        `(needs ${needed}s). Reduce the amount.`
    );
  }
  return needed;
}

/**
 * Distribute `yieldAmount` over the shortest legal duration, then warp to the
 * epoch's end so the full amount is realised.
 *
 * Drop-in replacement for the old `distributeYield(amount)` call.
 */
export async function distributeYield(
  okuMoney: any,
  rebaser: any,
  yieldAmount: bigint
): Promise<void> {
  const duration = await minLegalDuration(okuMoney, yieldAmount);
  await okuMoney.connect(rebaser).startYieldEpoch(yieldAmount, duration);
  await warp(duration);
}

/**
 * Drive `okuMMultiplier()` to exactly `target`, running as many epochs as the
 * APR cap requires (a single epoch may gain at most 20%, so e.g. a doubling
 * needs four).
 *
 * Drop-in replacement for the old `setOkuMMultiplier(target)` call.
 *
 * The smallest reachable increment is `MIN_EPOCH_DURATION` wei, because the
 * shortest legal epoch runs for that many seconds at >= 1 wei/second. Targets
 * nearer than that are unreachable by construction; this snaps to the minimum
 * and returns.
 */
export async function setMultiplierTo(
  okuMoney: any,
  rebaser: any,
  minter: any,
  target: bigint
): Promise<void> {
  let current: bigint = await okuMoney.okuMMultiplier();
  if (target <= current) {
    throw new Error(`target ${target} must exceed current multiplier ${current}`);
  }

  // An epoch derives its per-token increment from totalSupply, so a non-zero
  // supply must exist.
  if ((await okuMoney.totalSupply()) === 0n) {
    await okuMoney.connect(minter).mint(await minter.getAddress(), PRECISION);
  }

  for (let i = 0; i < 64; i++) {
    current = await okuMoney.okuMMultiplier();
    if (current === target) return;

    let delta = target - current;
    const maxDelta =
      (current * MAX_IMPLIED_APR_BPS * MAX_EPOCH_DURATION) / (BASIS_POINTS * SECONDS_PER_YEAR);
    if (delta > maxDelta) delta = maxDelta;

    let duration: bigint;
    let ratePerSecond: bigint;
    if (delta >= MIN_EPOCH_DURATION && delta <= MAX_EPOCH_DURATION) {
      duration = delta;
      ratePerSecond = 1n;
    } else if (delta > MAX_EPOCH_DURATION) {
      duration = MAX_EPOCH_DURATION;
      ratePerSecond = delta / duration;
    } else {
      duration = MIN_EPOCH_DURATION;
      ratePerSecond = 1n;
    }

    const achieved = ratePerSecond * duration;
    const supply: bigint = await okuMoney.totalSupply();
    const dollars = (achieved * supply + PRECISION - 1n) / PRECISION;

    await okuMoney.connect(rebaser).startYieldEpoch(dollars, duration);
    await warp(duration);

    if (delta < MIN_EPOCH_DURATION) return; // snapped to the minimum increment
  }

  throw new Error("epoch walk did not reach target");
}
