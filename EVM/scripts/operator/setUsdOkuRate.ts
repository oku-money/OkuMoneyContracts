/**
 * Set the continuous declared rate `M_usd` on USDOku (`OKU_RATE_SETTER`).
 *
 * Calls `USDOku.setUsdOkuRate(ratePerSecond, endTimestamp)`. This is the other
 * half of v0.3's `setYieldRate.ts` — the semantics moved wholesale from the
 * single token to USDOku, so if you ran that script before, this is its
 * successor. The stepwise realized mark is `setOkuMultiplier.ts`.
 *
 * THIS IS AN ORACLE WRITE. `M_usd` is what makes every USDOku balance grow, and
 * a rebasing balance moves with no transaction and no event to inspect — a wrong
 * rate quietly inflates every holder's balance and, with it, the protocol's
 * declared liability. There is no on-chain referent for off-chain T-Bill
 * performance, so the bounds below plus this script's projection are the only
 * things standing between a typo and an over-promise.
 *
 * WHAT `M_usd` IS, AND EMPHATICALLY IS NOT. It is the *declared, forward-looking,
 * smoothed* payout rate — the Aave liquidity-index / sDAI `chi` pattern. It is
 * NOT a conversion rate and it NEVER prices a wrap or an unwrap: the wrapper
 * converts OkuM <-> USDOku at `M_oku`, the realized index. That separation is
 * the load-bearing rule of the two-token design. If unwrap priced at `M_usd`,
 * USDOku holders could extract the smoothing gap straight out of the OkuM
 * backing pool.
 *
 * BECAUSE IT IS FORWARD-LOOKING, IT CAN OUT-RUN REALITY — deliberately, and
 * bounded. Declared liability (`USDOku.totalSupply()`) may exceed the wrapper's
 * realized backing by up to MAX_SOLVENCY_GAP_BPS (100 bps). A USDOku holder
 * whose balance grew above realized CAN unwrap for more OkuM than they wrapped;
 * that extraction IS the gap, it is funded by the wrapper's OkuM buffer, and it
 * is the mechanism rather than a bug. `setUsdOkuRate` is where the promise is
 * checked: it projects the liability to `rateEnd` and refuses if the projection
 * breaches the bound against CURRENT backing.
 *
 * FOUR ON-CHAIN BOUNDS:
 *   IndexCannotDecrease    rate < 1e18 refused; the index is monotone
 *   RateAboveMaximum       nominal APR above MAX_IMPLIED_APR (1000 bps)
 *   RateEndNotInFuture /
 *     RateDurationTooLong  `rateEnd` mandatory, future, within 30 days
 *   IndexAboveMaximum      projection to `rateEnd` above MAX_MULTIPLIER
 *   SolvencyGapExceeded    projected liability out-runs backing by > 100 bps
 *
 * THE SOLVENCY CHECK IS CUMULATIVE, NOT PER-WRITE, and that is not obvious from
 * the revert. Worst-case accrual inside one maximum-length segment (1000 bps for
 * 30 days) is ~79 bps, BELOW the 100 bps bound — so no single write starting from
 * a zero gap can ever be refused. The check only bites once several consecutive
 * segments have out-run realized marks. Practical reading: a
 * `SolvencyGapExceeded` here does not mean "this rate is too high", it means
 * "you have been declaring faster than you have been marking for a while".
 * The fix is a realized `M_oku` step or an OkuM top-up to the wrapper buffer,
 * not a smaller rate.
 *
 * NOT SYNC-GATED, and it does not need to be: the projection reads
 * `M_oku`-derived backing, and because `M_oku` is monotone any in-flight step
 * only INCREASES backing. The check is conservative mid-tick.
 *
 * Two ways to specify the rate — `--apr-bps` is strongly preferred, because a
 * hand-typed 1e18-scaled per-second value is unreviewable:
 *
 *   --apr-bps=450            nominal 4.50% APR (script converts)
 *   --rate=1000000001426...  raw per-second, 1e18-scaled
 *
 * `--end-timestamp` is MANDATORY on-chain: accrual halts there. That is a safety
 * mechanism, not scheduling — if the setter stops functioning the index stops
 * growing rather than accruing against assets that are not there. Prefer
 * `--duration-days`.
 *
 * OPERATIONAL CONSEQUENCE of the 30-day cap: a missed renewal freezes USDOku
 * yield until someone acts, and because the APR cap also binds the catch-up
 * rate, a long outage cannot be fully compensated afterwards. Set a reminder.
 *
 * Usage:
 *   npx hardhat run scripts/operator/setUsdOkuRate.ts --network base \
 *       --apr-bps 450 --duration-days 30
 *   DRY_RUN=true APR_BPS=450 DURATION_DAYS=30 npx hardhat run \
 *       scripts/operator/setUsdOkuRate.ts --network base
 *
 * Flags:
 *   --apr-bps=<bps>          nominal APR in basis points (mutually exclusive with --rate)
 *   --rate=<1e18-scaled>     raw per-second rate
 *   --duration-days=<n>      days until accrual halts (<= 30)
 *   --end-timestamp=<unix>   explicit halt timestamp (overrides --duration-days)
 *   DRY_RUN=true             simulate
 *   --yes-mainnet            bypass the mainnet guard
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import {
  BASIS_POINTS,
  DRY_RUN,
  MAX_IMPLIED_APR_BPS,
  MAX_RATE_DURATION_SECONDS,
  MAX_SOLVENCY_GAP_BPS,
  PRECISION,
  attachAlso,
  impliedAprBps,
  parseArg,
  ratePerSecondForAprBps,
  runScript,
  setup,
  submit,
} from "./_shared";

/**
 * `base * rate^elapsed / 1e18`, mirroring `MathLib.rpow` closely enough for a
 * projection. Exact would require reimplementing the contract's binary
 * exponentiation with its intermediate flooring; this is a straight repeated
 * square in bigint, which over 30 days at <=1000 bps agrees to well within the
 * precision anyone reading the output cares about. It is used for DISPLAY and
 * for the local solvency pre-check, never to derive the submitted value.
 */
function compound(base: bigint, rate: bigint, elapsed: bigint): bigint {
  if (elapsed === 0n || rate <= PRECISION) return base;
  let result = PRECISION;
  let b = rate;
  let e = elapsed;
  while (e > 0n) {
    if (e & 1n) result = (result * b) / PRECISION;
    b = (b * b) / PRECISION;
    e >>= 1n;
  }
  return (base * result) / PRECISION;
}

async function main() {
  const { contract: usdOku, signer, bookKey } = await setup("setUsdOkuRate", "USDOku");
  const wrapper = await attachAlso("USDOkuWrapper", bookKey, signer);

  // ---- Resolve the rate ----
  const aprBpsArg = parseArg("apr-bps");
  const rateArg = parseArg("rate");
  if (aprBpsArg && rateArg) {
    throw new Error("--apr-bps and --rate are mutually exclusive");
  }
  if (!aprBpsArg && !rateArg) {
    throw new Error("Required: --apr-bps=<bps> (preferred) or --rate=<1e18-scaled>");
  }

  const ratePerSecond = aprBpsArg
    ? ratePerSecondForAprBps(BigInt(aprBpsArg))
    : BigInt(rateArg!);

  if (ratePerSecond < PRECISION) {
    throw new Error(
      `rate ${ratePerSecond} < PRECISION ${PRECISION}: M_usd is monotone, so the ` +
        `contract reverts IndexCannotDecrease. To stop yield, set the rate to ` +
        `exactly ${PRECISION} (no growth) or use haltAccrual.ts --target=usdOku.`
    );
  }
  const apr = impliedAprBps(ratePerSecond);
  if (apr > MAX_IMPLIED_APR_BPS) {
    throw new Error(
      `implied APR ${apr}bps exceeds MAX_IMPLIED_APR ${MAX_IMPLIED_APR_BPS}bps; ` +
        `the contract reverts RateAboveMaximum.`
    );
  }

  // ---- Resolve the halt boundary ----
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);
  const endArg = parseArg("end-timestamp");
  const daysArg = parseArg("duration-days");

  let endTimestamp: bigint;
  if (endArg) {
    endTimestamp = BigInt(endArg);
  } else if (daysArg) {
    endTimestamp = now + BigInt(daysArg) * 86_400n;
  } else {
    throw new Error("Required: --duration-days=<n> or --end-timestamp=<unix>");
  }

  if (endTimestamp <= now) {
    throw new Error(
      `end (${endTimestamp}) must be strictly after now (${now}); the contract ` +
        `reverts RateEndNotInFuture. rateEnd is mandatory — there is no ` +
        `open-ended sentinel.`
    );
  }
  const duration = endTimestamp - now;
  if (duration > MAX_RATE_DURATION_SECONDS) {
    throw new Error(
      `duration ${duration}s exceeds MAX_RATE_DURATION ${MAX_RATE_DURATION_SECONDS}s; ` +
        `the contract reverts RateDurationTooLong.`
    );
  }

  // ---- Current state ----
  const currentRate: bigint = await (usdOku as any).ratePerSecond();
  const currentIndex: bigint = await (usdOku as any).usdOkuIndex();
  const baseIndex: bigint = await (usdOku as any).baseIndex();
  const currentEnd: bigint = await (usdOku as any).rateEnd();
  const lastAccrual: bigint = await (usdOku as any).lastAccrualTime();
  const totalShares: bigint = await (usdOku as any).totalShares();
  const solvencySource: string = await (usdOku as any).solvencySource();

  logger.info("");
  logger.info(`Current M_usd (index):  ${ethers.formatEther(currentIndex)}`);
  logger.info(`  baseIndex anchor:     ${ethers.formatEther(baseIndex)} @ ${lastAccrual}`);
  logger.info(`Current rate:           ${currentRate} (${impliedAprBps(currentRate)}bps APR)`);
  logger.info(
    `Current rateEnd:        ${new Date(Number(currentEnd) * 1000).toISOString()}` +
      `${now >= currentEnd ? "  [ACCRUAL HALTED]" : ""}`
  );
  logger.info(`totalShares:            ${ethers.formatEther(totalShares)}`);
  logger.info("");
  logger.info(`New rate:               ${ratePerSecond} (${apr}bps nominal APR)`);
  logger.info(`New rateEnd:            ${new Date(Number(endTimestamp) * 1000).toISOString()}`);
  logger.info(`Duration:               ${Number(duration) / 86_400} days`);

  // NO STEP AND NO GAP. The contract snapshots `baseIndex = usdOkuIndex()` and
  // re-anchors `lastAccrualTime` before applying the new rate, so calling this
  // before `rateEnd` changes only the SLOPE. Nobody's balance jumps. That is
  // also why this write needs no sandwich guard.
  const projectedIndex = compound(currentIndex, ratePerSecond, duration);
  logger.info(
    `Projected index at rateEnd: ~${ethers.formatEther(projectedIndex)} ` +
      `(index moves continuously from ${ethers.formatEther(currentIndex)}; no step)`
  );

  // ---- Solvency projection: mirror `_checkProjectedSolvency` ----
  if (solvencySource === ethers.ZeroAddress) {
    const msg =
      `usdOku.solvencySource is unset, so realized backing reads as ZERO. ` +
      `While totalShares == 0 there is no liability and the write succeeds; the ` +
      `moment anyone wraps, every rate write reverts SolvencyGapExceeded with an ` +
      `infinite gap. Wire it from OKU_CAP_MANAGER: ` +
      `usdOku.setSolvencySource(${await wrapper.getAddress()}) — step 6 of ` +
      `scripts/deploy/index.ts.`;
    if (totalShares === 0n) logger.warning(msg);
    else throw new Error(`PRE-CONDITION FAILED: ${msg}`);
  }

  if (totalShares > 0n) {
    // Ceil, as the contract does — the conservative direction for a liability.
    const projectedLiability = (totalShares * projectedIndex + PRECISION - 1n) / PRECISION;
    const backing: bigint = await (wrapper as any).realizedBacking();
    const liabilityNow: bigint = await (wrapper as any).declaredLiability();
    const gapNowBps: bigint = await (wrapper as any).solvencyGapBps();

    logger.info("");
    logger.info(`declaredLiability now:  $${ethers.formatEther(liabilityNow)}`);
    logger.info(`realizedBacking now:    $${ethers.formatEther(backing)}`);
    logger.info(`solvencyGapBps now:     ${gapNowBps}`);
    logger.info(`Projected liability:    $${ethers.formatEther(projectedLiability)} at rateEnd`);

    if (backing === 0n) {
      throw new Error(
        `PRE-CONDITION FAILED: realized backing is zero against a nonzero ` +
          `liability. The contract reverts SolvencyGapExceeded(uint256.max, ` +
          `${MAX_SOLVENCY_GAP_BPS}). Top up the wrapper's OkuM buffer — a plain ` +
          `transfer of OkuM to the wrapper counts as backing, which is the ` +
          `intended funding mechanism.`
      );
    }

    const projectedGapBps =
      projectedLiability <= backing
        ? 0n
        : ((projectedLiability - backing) * BASIS_POINTS + backing - 1n) / backing;
    logger.info(
      `Projected gap at rateEnd: ${projectedGapBps}bps ` +
        `(bound ${MAX_SOLVENCY_GAP_BPS}bps)`
    );

    if (projectedGapBps > MAX_SOLVENCY_GAP_BPS) {
      throw new Error(
        `PRE-CONDITION FAILED: projected gap ${projectedGapBps}bps exceeds ` +
          `MAX_SOLVENCY_GAP_BPS (${MAX_SOLVENCY_GAP_BPS}bps); the contract reverts ` +
          `SolvencyGapExceeded.\n` +
          `  READ THIS AS: the declared rate has been out-running realized marks ` +
          `for several segments. A single 30-day segment at the 1000bps APR cap ` +
          `only accrues ~79bps, so this bound cannot be tripped by one honest ` +
          `write from a zero gap.\n` +
          `  FIXES, in order of preference:\n` +
          `    (a) mark a realized M_oku step (setOkuMultiplier.ts) — raises ` +
          `backing, closing the gap at its source;\n` +
          `    (b) transfer OkuM to the wrapper to fund the buffer directly;\n` +
          `    (c) declare a lower rate. Reduces the projection but leaves the ` +
          `accumulated divergence in place.`
      );
    }
    if (projectedGapBps * 2n > MAX_SOLVENCY_GAP_BPS) {
      logger.warning(
        `Projected gap ${projectedGapBps}bps is over half the ${MAX_SOLVENCY_GAP_BPS}bps ` +
          `ceiling. The bound is CUMULATIVE, so the next segment may be refused ` +
          `even at a modest rate. Mark realized yield before then.`
      );
    }
  } else {
    logger.info(
      "totalShares == 0: no liability to out-run, so the solvency check is a no-op " +
        "on this write. It becomes live as soon as anyone wraps."
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("setUsdOkuRate", () =>
    (usdOku as any).setUsdOkuRate(ratePerSecond, endTimestamp));

  const confirmedRate: bigint = await (usdOku as any).ratePerSecond();
  const confirmedEnd: bigint = await (usdOku as any).rateEnd();
  const confirmedIndex: bigint = await (usdOku as any).usdOkuIndex();

  if (confirmedRate !== ratePerSecond || confirmedEnd !== endTimestamp) {
    throw new Error(
      `POST-CONDITION FAILED: on-chain rate=${confirmedRate} rateEnd=${confirmedEnd}, ` +
        `expected rate=${ratePerSecond} rateEnd=${endTimestamp}`
    );
  }
  if (confirmedIndex < currentIndex) {
    throw new Error(
      `POST-CONDITION FAILED: index went backwards (${currentIndex} -> ` +
        `${confirmedIndex}). M_usd is supposed to be monotone.`
    );
  }

  logger.success(
    `Confirmed: rate=${confirmedRate} (${impliedAprBps(confirmedRate)}bps) ` +
      `rateEnd=${new Date(Number(confirmedEnd) * 1000).toISOString()}`
  );
  logger.success(
    `Index re-anchored at ${ethers.formatEther(confirmedIndex)} — no holder balance jumped.`
  );
  logger.warning(
    `REMINDER: accrual halts at the above timestamp. Renew before then or USDOku ` +
      `yield stops, and the APR cap means a long outage cannot be fully ` +
      `compensated afterwards.`
  );
  logger.info(
    `Monitor the gap with scripts/operator/solvencyStatus.ts — it is the series ` +
      `to alarm on, not this rate.`
  );
}

runScript(main);
