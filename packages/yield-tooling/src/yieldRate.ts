/**
 * APY <-> per-second rate conversion for OkuMoney's streaming multiplier.
 *
 * SINGLE SOURCE OF TRUTH. Every chain MUST receive the byte-identical `bigint`
 * rate: cross-chain multiplier agreement rests entirely on the operator pushing
 * the same schedule everywhere, nothing on-chain enforces it.
 *
 * MODEL
 *   multiplier(t) = base * rate^(t - anchor)   [rpow, 1e18 fixed point]
 *   rate = APY^(1 / SECONDS_PER_YEAR)
 *
 * The on-chain `MathLib.rpow` is integer exponentiation-by-squaring with half-up
 * rounding, so the realised APY differs from the target by a few wei-relative
 * ULPs over a year — far below the ~1e-8 precision of any yield decision.
 *
 * SECONDS_PER_YEAR is 365 days exactly. This is a PROTOCOL CONVENTION, not a
 * calendar fact — SVM's Token-2022 `InterestBearingConfig` uses 365.24 days, one
 * of several reasons that extension is unsuitable for EVM parity.
 */

// PRECISION / MAX_RATE / SECONDS_PER_YEAR are defined in `./multiplier` (also
// consumed by SVM, differential-tested against the Solidity/Rust
// implementations). Re-exported here so EVM call sites can import either.
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
 * signed dollar carry that MUST be threaded into the NEXT call (as
 * `carryInUsd`) so no realised yield is silently gained or lost.
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
   * IMPORTANT — a BOOKKEEPING reconciliation against the measurement basis
   * (`measuredAvgValueUsd`), not a guarantee about literal future dollars.
   * See "Two V's" in the function doc; use {@link reconcileActualPayout} for
   * TRUE reconciliation against what was actually paid on-chain.
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
 * Two conceptually different "global value" quantities exist in this pipeline,
 * and conflating them is the most common way to get this wrong:
 *
 *   1. `measuredAvgValueUsd` (this function's parameter) — the TIME-WEIGHTED
 *      AVERAGE dollar value of OkuM across ALL chains, integrated over the
 *      MEASUREMENT epoch whose `realisedYieldUsd` this call converts into a
 *      rate. Must be time-weighted, not a spot value at epoch start: supply
 *      can change mid-epoch (mints/redemptions), and a spot denominator
 *      mis-measures the realised RATE by exactly the factor supply moved. Use
 *      {@link timeWeightedAverage} to compute it from periodic on-chain samples.
 *
 *   2. The PAYING epoch's average value (unknown at call time) — what the
 *      returned rate is actually multiplied against once live on-chain. NOT an
 *      input here: it cannot be known in advance, and the rate accrues
 *      per-token uniformly regardless of how much future supply exists.
 *
 * Getting (1) right expresses "the yield rate realised during the measurement
 * epoch" as a rate, decoupled from that epoch's own AUM path. It does NOT make
 * actual future dollars paid equal `realisedYieldUsd`: that gap is driven by
 * (2) — rate drift between the measurement and paying epochs, not AUM growth.
 * See EVM/README.md § Rear-Facing Epoch Accounting (`Y_dist = rate · V̄_paying · W`).
 *
 * `carryForwardUsd` reconciles against basis (1) only. For TRUE cumulative
 * conservation against what was actually paid on-chain, close the loop with
 * {@link reconcileActualPayout} once the paying epoch has closed and its own
 * time-weighted average is measurable, and feed ITS result into the next
 * `carryInUsd`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Publishes `realisedYieldUsd * conservativeFactor` this epoch (plus any
 * carried-in balance), deferring the withheld remainder into
 * `carryForwardUsd`. There is no discrete "true-up event" on-chain — deferred
 * amounts fold into the next epoch's rate and smear continuously over that
 * window. In steady state the carry converges to a stable per-epoch residual
 * rather than growing unboundedly (see the "steady state" test in
 * `test/hardhat/unit/yieldRate.test.ts`).
 *
 * Because `okuMMultiplier` is monotonic, an over-publish in a prior epoch
 * (`carryInUsd < 0`) can only be corrected by publishing a SLOWER rate this
 * epoch, never by moving the multiplier backwards.
 *
 * The division is by GLOBAL dollar value across all chains — never a single
 * chain's local supply, which would produce a different multiplier delta on
 * every chain.
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
 * @param conservativeFactor Fraction of `realisedYieldUsd` to publish this
 *        epoch, in `(0, 1]`. `1` (default) publishes the full realised yield;
 *        only clamping/rounding dust carries forward. `< 1` withholds the rest
 *        as a conservative buffer that becomes next epoch's `carryInUsd`.
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

  // Full obligation this call is responsible for eventually paying: this
  // epoch's realised yield plus whatever prior epochs left unpaid.
  // `carryForwardUsd` is computed against THIS baseline.
  const totalObligationUsd = realisedYieldUsd + carryInUsd;

  // What we attempt to publish this epoch: the conservative slice of realised
  // yield, plus the carried-in balance (not subject to further withholding —
  // it was already deferred once).
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

  // Clamp to the on-chain-enforced range rather than throwing: whatever the
  // clamp prevents from being paid this epoch is computed below and returned
  // as `carryForwardUsd`, so it is never lost.
  if (scaled < PRECISION) scaled = PRECISION;
  if (scaled > MAX_RATE) scaled = MAX_RATE;

  // Reconcile against the FULL obligation, not just what we tried to publish,
  // using the SAME measurement basis throughout. Handles every basis-(1)
  // residual uniformly: conservative withholding, PRECISION clamping (full
  // deficit carries forward), MAX_RATE clamping (overflow carries forward),
  // and float/rounding dust. Does NOT capture basis-(2) (paying-epoch AUM) —
  // see "Two V's" above and {@link reconcileActualPayout}.
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
 * Closes the gap {@link realisedYieldToRatePerSecond} cannot close alone (see
 * "Two V's" in that function's doc): `targetUsd` is the obligation that rate
 * was derived from (`realisedYieldUsd + carryInUsd` at the time), and
 * `actualPaidUsd` is what the published rate delivered once multiplied against
 * the paying epoch's REAL (not assumed) time-weighted average value:
 *
 * ```
 * actualPaidUsd = ((1 + publishedRate)^windowSeconds - 1) * payingEpochAvgValueUsd
 * ```
 *
 * Feed the returned residual into the NEXT epoch's `carryInUsd` (in place of,
 * or summed with, the paying epoch's own `carryForwardUsd`) for cumulative
 * conservation against observed on-chain reality.
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
 * Time-weighted average of a step function defined by timestamped samples, via
 * trapezoidal integration. Computes the `measuredAvgValueUsd` /
 * `payingEpochAvgValueUsd` inputs above from periodic on-chain
 * `totalSupply() * okuMMultiplier()` samples — `scripts/utils/globalValue.ts`
 * is the cross-chain sampling harness that produces them.
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
