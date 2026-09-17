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

// PRECISION / MAX_RATE / SECONDS_PER_YEAR moved to `./multiplier` when this
// file joined the shared package — that module is also consumed by SVM and
// is differential-tested against the Solidity/Rust implementations, so it is
// the single place these constants are defined now. Re-exported here so
// existing EVM call sites (`import { PRECISION } from "./yieldRate"`) do not
// need to change.
export { PRECISION, MAX_RATE, SECONDS_PER_YEAR } from './multiplier';
import { PRECISION, MAX_RATE, SECONDS_PER_YEAR } from './multiplier';

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
 * Result of {@link realisedYieldToRatePerSecond}: the rate to publish, plus the
 * signed dollar carry that must be threaded into the NEXT call to this function
 * (as `carryInUsd`) so no realised yield is ever silently gained or lost.
 */
export interface RateWithCarry {
  /** Per-second rate to pass to `setOkuMYieldRate` / `setNextOkuMYieldRate`. */
  ratePerSecond: bigint;
  /**
   * Signed USD to fold into the next epoch's `carryInUsd`.
   * Positive: this epoch under-paid (clamped at MAX_RATE, or rounding, or
   * deliberate `conservativeFactor` withholding), pay the rest next epoch.
   * Negative: this epoch over-paid relative to what was requested (clamped at
   * PRECISION because requested growth was negative, or rounding), deduct it
   * from what gets requested next epoch.
   *
   * IMPORTANT — this is a BOOKKEEPING reconciliation against the measurement
   * basis (`measuredAvgValueUsd`), not a guarantee about literal future
   * dollars. See "Two V's" in the function doc, and use
   * {@link reconcileActualPayout} for TRUE reconciliation against what was
   * actually paid on-chain.
   */
  carryForwardUsd: number;
}

/**
 * Derive the rate that expresses a known realised dollar yield as a per-second
 * rate — the REAR-FACING entry point: epoch N's confirmed proceeds are
 * converted to a rate that streams smoothly across a later window (see the
 * epoch pipeline in EVM/README.md § Rear-Facing Epoch Accounting).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO V's — READ THIS BEFORE CHANGING THE DENOMINATOR
 * ═══════════════════════════════════════════════════════════════════════════
 * There are two conceptually different "global value" quantities in this
 * pipeline, and conflating them is the single most common way to get this
 * wrong:
 *
 *   1. `measuredAvgValueUsd` (this function's parameter) — the TIME-WEIGHTED
 *      AVERAGE dollar value of OkuM across ALL chains, integrated over the
 *      MEASUREMENT epoch whose `realisedYieldUsd` this call is converting into
 *      a rate. This must be time-weighted, not a spot value at epoch start —
 *      supply can change mid-epoch (mints/redemptions), and a spot
 *      denominator mis-measures the realised RATE by exactly the same factor
 *      supply moved. Use {@link timeWeightedAverage} to compute it from
 *      periodic on-chain samples.
 *
 *   2. The PAYING epoch's average value (unknown at call time) — whatever the
 *      rate this function returns will actually be multiplied against once
 *      it's live on-chain. This is NOT an input to this function, because it
 *      cannot be known in advance; the rate accrues per-token, uniformly,
 *      regardless of how much future supply exists.
 *
 * Getting (1) right (time-weighted, not spot) makes this function correctly
 * express "the yield rate realised during the measurement epoch" as a
 * rate — decoupled from that epoch's own AUM path. It does NOT make actual
 * future dollars paid equal to `realisedYieldUsd`: that gap is driven by (2),
 * specifically by how much the REALISED RATE moves between the measurement
 * epoch and the paying epoch (rate drift), not by AUM growth. Rate drift is
 * small because T-bill yields move slowly; AUM can move arbitrarily fast via
 * mint/redeem. This is why "one multiplier, decoupled from supply" is a
 * feature of the rate-based design, not an approximation of a fixed-dollar
 * target — see EVM/README.md § Rear-Facing Epoch Accounting for the full
 * argument (`Y_dist = rate · V̄_paying · W`, and why fixing a nominal USD
 * amount is impossible for a fungible token without per-holder equalisation).
 *
 * The bookkeeping `carryForwardUsd` this function returns is a reconciliation
 * against basis (1) only — it captures deliberate `conservativeFactor`
 * withholding plus PRECISION/MAX_RATE clamping plus rounding dust, all
 * measured against `measuredAvgValueUsd`. It does NOT know about (2). If you
 * need TRUE cumulative conservation against what was actually paid on-chain
 * (not just internal bookkeeping), close the loop with
 * {@link reconcileActualPayout} once the paying epoch has closed and its own
 * time-weighted average is measurable, and feed ITS result into the next
 * `carryInUsd` instead of (or in addition to) this function's
 * `carryForwardUsd`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Publishes `realisedYieldUsd * conservativeFactor` this epoch (plus any
 * carried-in balance from prior epochs), deferring the withheld
 * `realisedYieldUsd * (1 - conservativeFactor)` into `carryForwardUsd` for the
 * NEXT epoch's `carryInUsd`. Pure rear-facing accrual is `conservativeFactor =
 * 1` (the default) — no deliberate withholding, only clamping/rounding dust
 * carries forward. There is no discrete "true-up event" on-chain — any
 * deferred amount is folded into next epoch's rate and smeared continuously
 * over that window, exactly like any other realised yield. In steady state
 * (constant realised yield per epoch, constant `conservativeFactor`), the
 * carry converges to a stable per-epoch residual rather than growing
 * unboundedly — see the "steady state" test in
 * `test/hardhat/unit/yieldRate.test.ts`.
 *
 * Because `okuMMultiplier` is monotonic, an over-publish in a prior epoch
 * (`carryInUsd < 0`) can only be corrected by publishing a SLOWER rate this
 * epoch, never by moving the multiplier backwards.
 *
 * Note the division is by GLOBAL dollar value across all chains — never a
 * single chain's local supply. That is precisely why `distributeYield` (which
 * divided by local `totalSupply()`) was removed: it produced a different
 * multiplier delta on every chain.
 *
 * @param realisedYieldUsd Confirmed dollar yield for the closed epoch. Must be
 *        >= 0 — off-chain T-bill income is never negative; use `carryInUsd` to
 *        express a prior epoch's over-payment instead.
 * @param measuredAvgValueUsd TIME-WEIGHTED AVERAGE dollar value of OkuM across
 *        ALL chains, integrated over the MEASUREMENT epoch (the one whose
 *        yield `realisedYieldUsd` reports) — NOT a spot value, and NOT the
 *        future paying epoch's value. See "Two V's" above.
 * @param windowSeconds Seconds over which to stream the resulting rate.
 * @param carryInUsd Signed USD carried forward from the previous epoch (either
 *        this function's `carryForwardUsd`, or — for true reconciliation —
 *        {@link reconcileActualPayout}'s result). 0 for the first epoch.
 * @param conservativeFactor Fraction of `realisedYieldUsd` to publish this epoch,
 *        in `(0, 1]`. `1` (default) publishes the full realised yield — pure
 *        rear-facing accrual with no deliberate withholding, only
 *        clamping/rounding dust carries forward. `< 1` withholds the rest as a
 *        deliberate conservative buffer that becomes next epoch's `carryInUsd`.
 */
export function realisedYieldToRatePerSecond(
  realisedYieldUsd: number,
  measuredAvgValueUsd: number,
  windowSeconds: number,
  carryInUsd = 0,
  conservativeFactor = 1
): RateWithCarry {
  if (measuredAvgValueUsd <= 0) throw new Error("measuredAvgValueUsd must be > 0");
  if (windowSeconds <= 0) throw new Error("windowSeconds must be > 0");
  if (realisedYieldUsd < 0) {
    throw new Error(
      "Negative REALISED yield cannot be expressed: the multiplier is monotonic. " +
        "Use a negative carryInUsd to express a prior epoch's over-payment instead."
    );
  }
  if (conservativeFactor <= 0 || conservativeFactor > 1) {
    throw new Error(`conservativeFactor must be in (0, 1], got ${conservativeFactor}`);
  }

  // The full obligation this call is responsible for eventually paying —
  // this epoch's realised yield plus whatever prior epochs left unpaid.
  // `carryForwardUsd` is computed against THIS baseline, so withholding via
  // `conservativeFactor` and clamping/rounding are reconciled uniformly.
  const totalObligationUsd = realisedYieldUsd + carryInUsd;

  // What we actually attempt to publish this epoch: the conservative slice of
  // realised yield, plus the carried-in balance (which is not itself subject
  // to further withholding — it was already deferred once).
  const publishedUsd = realisedYieldUsd * conservativeFactor + carryInUsd;

  const growth = 1 + publishedUsd / measuredAvgValueUsd;
  if (growth <= 0) {
    throw new Error(
      `Published yield + carry (${publishedUsd}) implies a >=100% loss against ` +
        `measuredAvgValueUsd (${measuredAvgValueUsd}); this cannot be expressed by any rate. ` +
        "This should be operationally unreachable — investigate the inputs."
    );
  }

  const ratePerSecondFloat = Math.pow(growth, 1 / windowSeconds);
  let scaled = BigInt(Math.round(ratePerSecondFloat * FLOAT_SCALE));

  // Clamp to the on-chain-enforced range. Clamping (rather than throwing, as a
  // prior version of this function did at MAX_RATE, or silently returning
  // PRECISION with no residual, as it did below PRECISION) is what makes this
  // safe: whatever the clamp prevents from being paid this epoch is computed
  // below and returned as `carryForwardUsd`, so it is never lost.
  if (scaled < PRECISION) scaled = PRECISION;
  if (scaled > MAX_RATE) scaled = MAX_RATE;

  // Reconcile against the FULL obligation, not just what we tried to publish,
  // using the SAME measurement basis throughout so the bookkeeping is
  // internally consistent. This single computation handles every basis-(1)
  // residual source uniformly: deliberate conservative withholding, PRECISION
  // clamping (full deficit carries forward), MAX_RATE clamping (overflow
  // carries forward), and plain float/rounding dust. It does NOT capture
  // basis-(2) (paying-epoch AUM) effects — see "Two V's" above and
  // {@link reconcileActualPayout}.
  const achievedGrowth = Math.pow(Number(scaled) / FLOAT_SCALE, windowSeconds) - 1;
  const achievedYieldUsd = achievedGrowth * measuredAvgValueUsd;
  const carryForwardUsd = totalObligationUsd - achievedYieldUsd;

  return { ratePerSecond: scaled, carryForwardUsd };
}

/**
 * TRUE ex-post reconciliation: compare what an epoch was intended to pay
 * against what it actually paid on-chain, once the epoch has closed and its
 * own time-weighted average value is measurable.
 *
 * This closes the gap {@link realisedYieldToRatePerSecond} cannot close on its
 * own (see "Two V's" in that function's doc): `targetUsd` is the obligation
 * that rate was derived from (`realisedYieldUsd + carryInUsd` at the time),
 * and `actualPaidUsd` is what the published rate actually delivered once
 * multiplied against the paying epoch's REAL (not assumed) time-weighted
 * average value:
 *
 * ```
 * actualPaidUsd = ((1 + publishedRate)^windowSeconds - 1) * payingEpochAvgValueUsd
 * ```
 *
 * Feed the returned residual into the NEXT epoch's `carryInUsd` (in place of,
 * or summed with, the internal `carryForwardUsd` from the paying epoch's own
 * `realisedYieldToRatePerSecond` call) for cumulative conservation that holds
 * against observed on-chain reality, not just internal bookkeeping.
 *
 * @param targetUsd The obligation the paying epoch's rate was derived to express.
 * @param actualPaidUsd What that rate actually paid, computed from the paying
 *        epoch's OWN measured time-weighted average value (see
 *        {@link timeWeightedAverage}), not the value used to derive the rate.
 * @returns Signed USD residual — positive means under-paid (roll forward as
 *          carry-in), negative means over-paid (roll forward as negative carry-in).
 */
export function reconcileActualPayout(targetUsd: number, actualPaidUsd: number): number {
  return targetUsd - actualPaidUsd;
}

/**
 * Time-weighted average of a step function defined by timestamped samples,
 * via trapezoidal integration. Used to compute the `measuredAvgValueUsd` /
 * `payingEpochAvgValueUsd` inputs above from periodic on-chain
 * `totalSupply() * okuMMultiplier()` samples — see
 * `scripts/utils/globalValue.ts` for the sampling/aggregation harness that
 * produces these samples across chains.
 *
 * @param samples Chronologically sorted `{ timestampSec, valueUsd }` pairs
 *        spanning (at least) the window being averaged. Must have >= 2 samples.
 * @returns Time-weighted average `valueUsd` over
 *          `[samples[0].timestampSec, samples[last].timestampSec]`.
 */
export function timeWeightedAverage(
  samples: { timestampSec: number; valueUsd: number }[]
): number {
  if (samples.length < 2) {
    throw new Error("timeWeightedAverage needs at least 2 samples to integrate over");
  }
  let weightedSum = 0;
  let totalDuration = 0;
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].timestampSec - samples[i - 1].timestampSec;
    if (dt < 0) {
      throw new Error("samples must be chronologically sorted (non-decreasing timestampSec)");
    }
    if (dt === 0) continue; // Coincident timestamps contribute no duration; skip safely.
    const avgOverStep = (samples[i - 1].valueUsd + samples[i].valueUsd) / 2;
    weightedSum += avgOverStep * dt;
    totalDuration += dt;
  }
  if (totalDuration === 0) {
    throw new Error("samples span zero duration — need samples separated in time");
  }
  return weightedSum / totalDuration;
}

/** Format a rate for human-readable logging. */
export function describeRate(ratePerSecond: bigint): string {
  const apy = ratePerSecondToApy(ratePerSecond);
  return `${ratePerSecond} (~${(apy * 100).toFixed(4)}% APY)`;
}

/** Format a signed carry for human-readable logging. */
export function describeCarry(carryUsd: number): string {
  if (carryUsd === 0) return "$0.00 (fully reconciled)";
  const sign = carryUsd > 0 ? "under-paid" : "over-paid";
  return `$${Math.abs(carryUsd).toFixed(2)} ${sign} this epoch, carries to next`;
}
