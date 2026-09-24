/**
 * TypeScript mirror of the streaming-accrual math.
 *
 * One of THREE implementations of the same function:
 *
 *   - `EVM/src/lib/MathLib.sol`                      (Solidity, uint256)
 *   - `SVM/oku-programs/crates/oku-shared/src/rate.rs` (Rust, u128 + 256-bit mul_div)
 *   - this file                                      (TypeScript, bigint)
 *
 * All three MUST agree bit-for-bit: the protocol's cross-chain determinism
 * rests entirely on every deployment returning the same multiplier at the same
 * wall-clock second, and no on-chain layer on either stack can detect a
 * divergence (`EVM/README.md` § Accepted Risks (10)).
 *
 * They are held honest by the differential harness: `EVM/test/differential`
 * generates vectors from the Solidity, and both this file and the Rust replay
 * them asserting exact equality. Run `npm run test:tooling` here and
 * `cargo test --package oku-shared differential` there. If you change any one
 * of the three, regenerate the vectors and run all three.
 *
 * A TS implementation is needed because Solana has no view functions: anything
 * off-chain needing the canonical value — drift monitoring, the epoch
 * orchestrator's V(t) sampler, integrators — recomputes it from `PsmConfig`.
 *
 * Every value here is a `bigint`, never `number`: `number` cannot hold a
 * WAD-scaled multiplier (1e24 > 2^53) and float rounding would break exactness.
 */

/** Fixed-point scale. Identical to EVM `Constants.PRECISION` and Rust `PRECISION`. */
export const PRECISION = 1_000_000_000_000_000_000n;

/** Maximum per-second rate (~2242% APY). EVM `Constants.MAX_RATE`. */
export const MAX_RATE = PRECISION + 100_000_000_000n;

/** Multiplier ceiling ($1,000,000 per whole token). EVM `Constants.MAX_MULTIPLIER`. */
export const MAX_MULTIPLIER = 1_000_000_000_000_000_000_000_000n;

/** Half of PRECISION — the half-up rounding increment used by `rpow`. */
const HALF_WAD = PRECISION / 2n;

/**
 * The six-field rate schedule, as stored on `PsmConfig` (SVM) or in the
 * `OkuMoneyStorage` accrual slots (EVM).
 */
export interface Schedule {
  /** Multiplier snapshot taken at `lastAccrualTime`, WAD-scaled. */
  baseMultiplier: bigint;
  /** Active per-second rate, WAD-scaled. `PRECISION` means halted. */
  ratePerSecond: bigint;
  /** Timestamp `baseMultiplier` was snapshotted at. */
  lastAccrualTime: bigint;
  /** Active rate expiry. `0n` ONLY when halted. */
  rateEnd: bigint;
  /** Pre-staged successor rate. `PRECISION` means none armed. */
  pendingRatePerSecond: bigint;
  /** Successor's own expiry, bounding the overhang. `0n` = none armed. */
  pendingRateEnd: bigint;
}

/**
 * `x^n / PRECISION^(n-1)` — exponentiation by squaring with MakerDAO's
 * half-up rounding.
 *
 * Port of `MathLib.sol:36-67`. JS `bigint` is arbitrary-precision, so unlike
 * the Solidity and Rust versions there is no overflow to guard — which means
 * this implementation will happily return values the other two would reject.
 * Callers that care about parity must bound their inputs the same way the
 * chains do; `computeMultiplier` below applies the `MAX_MULTIPLIER` clamp,
 * which covers the reachable domain.
 */
export function rpow(x: bigint, n: bigint): bigint {
  if (x === 0n) return n === 0n ? PRECISION : 0n;

  let z = n % 2n === 0n ? PRECISION : x;
  let base = x;
  let exp = n / 2n;

  while (exp !== 0n) {
    base = (base * base + HALF_WAD) / PRECISION;
    if (exp % 2n !== 0n) {
      z = (z * base + HALF_WAD) / PRECISION;
    }
    exp /= 2n;
  }

  return z;
}

/**
 * Compound `base` by `rate^elapsed`, clamped at `MAX_MULTIPLIER`.
 * Port of `MathLib.sol:87-101`. Identity when `elapsed === 0n`.
 */
export function compoundFor(base: bigint, rate: bigint, elapsed: bigint): bigint {
  if (elapsed === 0n) return base;
  const result = (base * rpow(rate, elapsed)) / PRECISION;
  return result > MAX_MULTIPLIER ? MAX_MULTIPLIER : result;
}

/**
 * The canonical multiplier at `nowTs`.
 *
 * Port of `MathLib.sol:135-190`, branch-for-branch. See the Solidity or the
 * Rust for the rationale behind each branch — this is a transcription, and
 * should be read alongside one of them rather than on its own.
 *
 * Throws where the other two implementations would revert / return `None`:
 * a negative timestamp, or `nowTs` before `lastAccrualTime` in branch 3.
 */
export function computeMultiplier(s: Schedule, nowTs: bigint): bigint {
  const { baseMultiplier: base, ratePerSecond: rate, lastAccrualTime: anchor } = s;
  const { rateEnd, pendingRatePerSecond: pendingRate, pendingRateEnd } = s;

  if (anchor < 0n || rateEnd < 0n || pendingRateEnd < 0n || nowTs < 0n) {
    throw new Error(
      `computeMultiplier: negative timestamp outside the unsigned domain ` +
        `(anchor=${anchor} rateEnd=${rateEnd} pendingRateEnd=${pendingRateEnd} now=${nowTs})`,
    );
  }

  // Branch 1: halted.
  if (rate <= PRECISION) {
    if (rateEnd !== 0n && nowTs > rateEnd && pendingRate > PRECISION) {
      const overhangEnd = pendingRateEnd !== 0n && nowTs > pendingRateEnd ? pendingRateEnd : nowTs;
      if (overhangEnd > rateEnd) {
        return compoundFor(base, pendingRate, overhangEnd - rateEnd);
      }
    }
    return base;
  }

  // Branch 2: active window has closed.
  if (rateEnd !== 0n && nowTs > rateEnd) {
    const elapsedInWindow = anchor < rateEnd ? rateEnd - anchor : 0n;
    let compounded = compoundFor(base, rate, elapsedInWindow);
    if (pendingRate > PRECISION) {
      const overhangStart = anchor > rateEnd ? anchor : rateEnd;
      const overhangEnd = pendingRateEnd !== 0n && nowTs > pendingRateEnd ? pendingRateEnd : nowTs;
      if (overhangEnd > overhangStart) {
        compounded = compoundFor(compounded, pendingRate, overhangEnd - overhangStart);
      }
    }
    return compounded;
  }

  // Branch 3: still running.
  if (nowTs < anchor) {
    throw new Error(`computeMultiplier: nowTs ${nowTs} precedes anchor ${anchor}`);
  }
  return compoundFor(base, rate, nowTs - anchor);
}

/**
 * The rate actually accruing at `nowTs`, which lags the stored
 * `ratePerSecond` once the active window has closed.
 *
 * Port of `OkuMoney.sol:321-331`.
 */
export function effectiveRate(s: Schedule, nowTs: bigint): bigint {
  if (s.rateEnd !== 0n && nowTs > s.rateEnd) {
    if (s.pendingRateEnd !== 0n && nowTs > s.pendingRateEnd) return PRECISION;
    return s.pendingRatePerSecond;
  }
  return s.ratePerSecond;
}

/**
 * Project an Anchor-decoded `PsmConfig` into a {@link Schedule}.
 *
 * Accepts anything BN-like or bigint-like for each field so it works against
 * both Anchor's BN decoding and a raw buffer decode.
 */
export function scheduleFromConfig(config: {
  okumBaseMultiplier: { toString(): string };
  okumRatePerSecond: { toString(): string };
  okumLastAccrualTime: { toString(): string };
  okumRateEnd: { toString(): string };
  okumPendingRatePerSecond: { toString(): string };
  okumPendingRateEnd: { toString(): string };
}): Schedule {
  return {
    baseMultiplier: BigInt(config.okumBaseMultiplier.toString()),
    ratePerSecond: BigInt(config.okumRatePerSecond.toString()),
    lastAccrualTime: BigInt(config.okumLastAccrualTime.toString()),
    rateEnd: BigInt(config.okumRateEnd.toString()),
    pendingRatePerSecond: BigInt(config.okumPendingRatePerSecond.toString()),
    pendingRateEnd: BigInt(config.okumPendingRateEnd.toString()),
  };
}

/**
 * Derive the per-second rate that produces `apy` over `SECONDS_PER_YEAR`.
 *
 * `SECONDS_PER_YEAR` is exactly 365 days — a protocol convention shared with
 * `EVM/scripts/utils/yieldRate.ts`, deliberately NOT the 365.24 that
 * Token-2022's `InterestBearingConfig` uses. That extension is not in the
 * pricing path (the display mirror stores a multiplier, not a rate), so the
 * convention applies uniformly on both stacks.
 *
 * Rounds to the nearest integer and clamps into `[PRECISION, MAX_RATE]`.
 * Any remainder lost to clamping is the caller's problem — on EVM it is
 * carried forward via the carry ledger.
 */
export const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;

export function ratePerSecondForApy(apy: number): bigint {
  if (!Number.isFinite(apy) || apy < 0) {
    throw new Error(`ratePerSecondForApy: APY must be finite and non-negative, got ${apy}`);
  }
  const perSecond = Math.pow(1 + apy, 1 / Number(SECONDS_PER_YEAR));
  // Build the integer via string to avoid an intermediate float that cannot
  // represent 1e18 exactly.
  const scaled = BigInt(Math.round(perSecond * 1e18));
  if (scaled < PRECISION) return PRECISION;
  if (scaled > MAX_RATE) return MAX_RATE;
  return scaled;
}
