/**
 * Set the continuous accrual rate on OkuDollar (`OKU_RATE_SETTER`).
 *
 * Calls `OkuDollar.setYieldRate(ratePerSecond, endTimestamp)`.
 *
 * THIS IS AN ORACLE WRITE. The moment a lending market prices off
 * `uiMultiplier()`, a wrong value here mints borrowing power directly, and
 * `totalAssets()` is derived from the multiplier rather than measured — so
 * there is no on-chain referent to catch a mistake. The contract bounds the
 * damage (APR cap, duration cap, monotonicity, MAX_MULTIPLIER); this script
 * additionally prints the projected trajectory before submitting.
 *
 * Two ways to specify the rate — `--apr-bps` is strongly preferred, because a
 * hand-typed 1e18-scaled per-second value is unreviewable:
 *
 *   --apr-bps=450          nominal 4.50% APR (script converts)
 *   --rate=1000000001426...  raw per-second, 1e18-scaled
 *
 * `--end-timestamp` is MANDATORY on-chain: accrual halts there. That is a
 * safety mechanism, not scheduling — if the setter stops functioning the
 * multiplier stops growing rather than accruing against assets that are not
 * there. Prefer `--duration-days` and let the script compute it.
 *
 * OPERATIONAL CONSEQUENCE of the 30-day cap: a missed renewal freezes yield
 * until someone acts, and because the APR cap also binds the catch-up rate a
 * long outage cannot be fully compensated afterwards (~0.82 days at the cap per
 * day of outage, at 1000bps against a 450bps target). Set a calendar reminder.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setYieldRate.ts --network base \
 *       --apr-bps 450 --duration-days 30
 *   DRY_RUN=true APR_BPS=450 DURATION_DAYS=30 npx hardhat run \
 *       scripts/operator/setYieldRate.ts --network base
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
  DRY_RUN,
  MAX_IMPLIED_APR_BPS,
  MAX_RATE_DURATION_SECONDS,
  PRECISION,
  impliedAprBps,
  parseArg,
  ratePerSecondForAprBps,
  runScript,
  setup,
  submit,
} from "./_shared";

async function main() {
  const { contract: token } = await setup("setYieldRate", "OkuDollar");

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
      `rate ${ratePerSecond} < PRECISION ${PRECISION}: the multiplier is monotonic, ` +
        `so the contract reverts with MultiplierCannotDecrease.`
    );
  }
  const apr = impliedAprBps(ratePerSecond);
  if (apr > MAX_IMPLIED_APR_BPS) {
    throw new Error(
      `implied APR ${apr}bps exceeds MAX_IMPLIED_APR ${MAX_IMPLIED_APR_BPS}bps; ` +
        `the contract reverts with RateAboveMaximum.`
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
      `end (${endTimestamp}) must be strictly after now (${now}); ` +
        `the contract reverts with RateEndNotInFuture. rateEnd is mandatory — ` +
        `there is no open-ended sentinel in v0.3.`
    );
  }
  const duration = endTimestamp - now;
  if (duration > MAX_RATE_DURATION_SECONDS) {
    throw new Error(
      `duration ${duration}s exceeds MAX_RATE_DURATION ${MAX_RATE_DURATION_SECONDS}s; ` +
        `the contract reverts with RateDurationTooLong.`
    );
  }

  // ---- Show the trajectory ----
  const currentRate: bigint = await (token as any).ratePerSecond();
  const currentMult: bigint = await (token as any).uiMultiplier();
  const currentEnd: bigint = await (token as any).rateEnd();
  const pending: bigint = await (token as any).newUIMultiplier();

  logger.info(`Current uiMultiplier:   ${ethers.formatEther(currentMult)}`);
  logger.info(`Current rate:           ${currentRate} (${impliedAprBps(currentRate)}bps APR)`);
  logger.info(
    `Current rateEnd:        ${new Date(Number(currentEnd) * 1000).toISOString()}` +
      `${now >= currentEnd ? "  [ACCRUAL HALTED]" : ""}`
  );
  logger.info(`Current newUIMultiplier:${ethers.formatEther(pending)}`);
  logger.info("");
  logger.info(`New rate:               ${ratePerSecond} (${apr}bps nominal APR)`);
  logger.info(`New rateEnd:            ${new Date(Number(endTimestamp) * 1000).toISOString()}`);
  logger.info(`Duration:               ${Number(duration) / 86_400} days`);

  // Projected terminal multiplier, mirroring the contract's own pre-commit check.
  // Simple approximation for display only; the contract uses rpow.
  const approxTerminal =
    currentMult + (currentMult * (ratePerSecond - PRECISION) * duration) / PRECISION;
  logger.info(`Projected at rateEnd:   ~${ethers.formatEther(approxTerminal)} (approx)`);

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("setYieldRate", () => (token as any).setYieldRate(ratePerSecond, endTimestamp));

  const confirmedRate: bigint = await (token as any).ratePerSecond();
  const confirmedEnd: bigint = await (token as any).rateEnd();
  logger.success(
    `Confirmed: rate=${confirmedRate} (${impliedAprBps(confirmedRate)}bps) ` +
      `rateEnd=${new Date(Number(confirmedEnd) * 1000).toISOString()}`
  );
  logger.warning(
    `REMINDER: accrual halts at the above timestamp. Renew before then or yield stops.`
  );
}

runScript(main);
