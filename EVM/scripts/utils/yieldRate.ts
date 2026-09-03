/**
 * APY <-> per-second rate conversion for OkuMoney's streaming multiplier.
 *
 * SINGLE SOURCE OF TRUTH. Every chain MUST receive the byte-identical `bigint`
 * rate, because cross-chain multiplier agreement rests entirely on the operator
 * pushing the same schedule everywhere — nothing on-chain enforces it. Deriving
 * the rate from a declared APY (rather than hand-entering an 19-digit integer)
 * removes the most likely source of a cross-chain mismatch.
 *
 * MODEL
 *   multiplier(t) = base * rate^(t - anchor)   [rpow, 1e18 fixed point]
 *   rate = APY^(1 / SECONDS_PER_YEAR)
 *
 * The on-chain `MathLib.rpow` is integer exponentiation-by-squaring with half-up
 * rounding, so the realised APY differs from the target by a few wei-relative
 * ULPs over a year. That is far below the ~1e-8 precision of any yield decision.
 *
 * SECONDS_PER_YEAR is 365 days exactly. This is a PROTOCOL CONVENTION, not a
 * calendar fact — SVM's Token-2022 `InterestBearingConfig` uses 365.24 days, one
 * of several reasons that extension is unsuitable for EVM parity.
 */

/** 1e18 fixed-point scale, matching `Constants.PRECISION`. */
export const PRECISION = 10n ** 18n;

/** `Constants.MAX_RATE` — PRECISION + 1e11, ~2242% APY ceiling. */
export const MAX_RATE = PRECISION + 10n ** 11n;

/** Protocol convention: 365 days. Must match the off-chain yield model. */
export const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;

/** Working precision for the intermediate float computation. */
const FLOAT_SCALE = 1e18;

/**
 * Convert an APY to the 1e18-scaled per-second compounding rate.
 *
 * @param apy Fractional APY — `0.03` means 3%. Must be >= 0.
 * @returns Per-second rate as a bigint; `PRECISION` exactly means no yield.
 *
 * @example
 *   apyToRatePerSecond(0)     -> 1000000000000000000n  (no accrual)
 *   apyToRatePerSecond(0.03)  -> ~1000000000937303470n (3% APY)
 */
export function apyToRatePerSecond(apy: number): bigint {
  if (!Number.isFinite(apy)) throw new Error(`APY must be finite, got ${apy}`);
  if (apy < 0) throw new Error(`APY must be >= 0 (multiplier is monotonic), got ${apy}`);
  if (apy === 0) return PRECISION;

  // rate = (1 + apy) ^ (1 / SECONDS_PER_YEAR)
  const rate = Math.pow(1 + apy, 1 / Number(SECONDS_PER_YEAR));
  const scaled = BigInt(Math.round(rate * FLOAT_SCALE));

  if (scaled < PRECISION) {
    throw new Error(`Computed rate ${scaled} < PRECISION; APY ${apy} is too small to represent`);
  }
  if (scaled > MAX_RATE) {
    throw new Error(`Computed rate ${scaled} exceeds MAX_RATE ${MAX_RATE}; APY ${apy} too large`);
  }
  return scaled;
}

/**
 * Inverse of {@link apyToRatePerSecond}, for display and verification.
 * @param ratePerSecond 1e18-scaled per-second rate.
 * @returns Fractional APY — `0.03` means 3%.
 */
export function ratePerSecondToApy(ratePerSecond: bigint): number {
  if (ratePerSecond <= PRECISION) return 0;
  const r = Number(ratePerSecond) / FLOAT_SCALE;
  return Math.pow(r, Number(SECONDS_PER_YEAR)) - 1;
}

/**
 * Derive the rate that streams a known realised dollar yield over a window.
 *
 * This is the REAR-FACING entry point: epoch N's confirmed proceeds are converted
 * to a rate that streams smoothly across a later window (see the epoch pipeline in
 * EVM/README.md). Note the division is by GLOBAL dollar value across all chains —
 * never a single chain's local supply. That is precisely why `distributeYield`
 * (which divided by local `totalSupply()`) was removed: it produced a different
 * multiplier delta on every chain.
 *
 * @param realisedYieldUsd Confirmed dollar yield for the closed epoch.
 * @param globalValueUsd Total dollar value of OkuM across ALL chains at epoch start.
 * @param windowSeconds Seconds over which to stream it.
 */
export function realisedYieldToRatePerSecond(
  realisedYieldUsd: number,
  globalValueUsd: number,
  windowSeconds: number
): bigint {
  if (globalValueUsd <= 0) throw new Error("globalValueUsd must be > 0");
  if (windowSeconds <= 0) throw new Error("windowSeconds must be > 0");
  if (realisedYieldUsd < 0) {
    throw new Error(
      "Negative yield cannot be expressed: the multiplier is monotonic. " +
        "Set the rate to PRECISION (0% APY) and hold until losses are absorbed."
    );
  }

  const growth = 1 + realisedYieldUsd / globalValueUsd;
  const ratePerSecond = Math.pow(growth, 1 / windowSeconds);
  const scaled = BigInt(Math.round(ratePerSecond * FLOAT_SCALE));

  if (scaled < PRECISION) return PRECISION;
  if (scaled > MAX_RATE) {
    throw new Error(`Computed rate ${scaled} exceeds MAX_RATE ${MAX_RATE}`);
  }
  return scaled;
}

/** Format a rate for human-readable logging. */
export function describeRate(ratePerSecond: bigint): string {
  const apy = ratePerSecondToApy(ratePerSecond);
  return `${ratePerSecond} (~${(apy * 100).toFixed(4)}% APY)`;
}
