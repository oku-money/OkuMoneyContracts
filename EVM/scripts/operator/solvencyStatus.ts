/**
 * Read-only: print the USDOku solvency position.
 *
 * THE SERIES TO ALARM ON. `solvencyGapBps` is the one number that summarises
 * whether the declared dollar leg is keeping its promise, and the wrapper emits
 * `SolvencyGapUpdated` on every wrap and unwrap so it can be monitored from
 * events alone. This script is the manual read of the same quantities.
 *
 * WHAT THE GAP IS, AND WHY IT IS SUPPOSED TO BE NONZERO. `M_usd` is a declared,
 * smoothed, forward-looking rate; `M_oku` is the realized mark. Between marks
 * the declared liability (`USDOku.totalSupply()`) can run ahead of realized
 * backing (the wrapper's OkuM holding valued at `M_oku`). A USDOku holder whose
 * balance grew above realized CAN unwrap for more OkuM than they wrapped, and
 * that extraction IS the gap. It is funded by the wrapper's OkuM buffer —
 * donations and issuer top-ups — and bounded at 100 bps by the projection check
 * in `setUsdOkuRate`. A gap of zero forever would mean the smoothing is not
 * doing anything.
 *
 * HOW TO READ IT:
 *   gapBps < 0            over-backed. Normal right after a realized M_oku step.
 *   0 <= gapBps <= ~50     healthy smoothing.
 *   ~50 < gapBps <= 100    the CUMULATIVE bound is close. The next
 *                          `setUsdOkuRate` may be refused even at a modest rate,
 *                          because the bound is cumulative rather than
 *                          per-write. Mark realized yield or fund the buffer.
 *   gapBps > 100           the rate authority is already locked out
 *                          (SolvencyGapExceeded). Reachable by the passage of
 *                          time after a write, since the check runs only at
 *                          write time.
 *   int256.max sentinel    liability against ZERO backing. Every unwrap is
 *                          reverting InsufficientBacking. This is an incident.
 *
 * THE FIX IS ALMOST NEVER "LOWER THE RATE". A high gap means declared has
 * out-run realized for several segments; lowering the rate slows further
 * divergence but leaves the accumulated shortfall in place. The two fixes that
 * actually close it are a realized `M_oku` step (raises backing for everyone) or
 * an OkuM transfer into the wrapper (funds the buffer directly — a plain
 * transfer counts, which is the intended mechanism).
 *
 * Read-only and role-free: safe against any deployment, including mainnet.
 *
 * Usage:
 *   npx hardhat run scripts/operator/solvencyStatus.ts --network base
 *   NETWORK=base npx hardhat run scripts/operator/solvencyStatus.ts --network localhost
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import {
  BASIS_POINTS,
  MAX_SOLVENCY_GAP_BPS,
  PRECISION,
  attachAlso,
  impliedAprBps,
  runScript,
  setup,
} from "./_shared";

const INT256_MAX = 2n ** 255n - 1n;
const UINT256_MAX = 2n ** 256n - 1n;

async function main() {
  const { contract: wrapper, signer, bookKey } = await setup("solvencyStatus", "USDOkuWrapper");
  const okuM = await attachAlso("OkuM", bookKey, signer);
  const usdOku = await attachAlso("USDOku", bookKey, signer);

  const wrapperAddress = await wrapper.getAddress();

  // Cross-check the wrapper is bound to the tokens we just loaded from the same
  // book. `RedemptionQueue` and `OkuM`-adjacent keys survived the v0.3 -> v0.4
  // rename with the same names in places, so a stale entry can attach cleanly to
  // the wrong contract and produce a plausible-looking but meaningless gap.
  const boundOkuM: string = await (wrapper as any).okuM();
  const boundUsdOku: string = await (wrapper as any).usdOku();
  const okuMAddress = await okuM.getAddress();
  const usdOkuAddress = await usdOku.getAddress();
  if (
    boundOkuM.toLowerCase() !== okuMAddress.toLowerCase() ||
    boundUsdOku.toLowerCase() !== usdOkuAddress.toLowerCase()
  ) {
    throw new Error(
      `Wrapper binding disagrees with the address book: wrapper.okuM()=${boundOkuM} ` +
        `(book ${okuMAddress}), wrapper.usdOku()=${boundUsdOku} (book ${usdOkuAddress}). ` +
        `The figures below would be meaningless.`
    );
  }

  const liability: bigint = await (wrapper as any).declaredLiability();
  const backing: bigint = await (wrapper as any).realizedBacking();
  const gapBps: bigint = await (wrapper as any).solvencyGapBps();
  const ratioBps: bigint = await (wrapper as any).backingRatioBps();
  const wrapEnabled: boolean = await (wrapper as any).wrapEnabled();
  const paused: boolean = await (wrapper as any).paused();

  const mOku: bigint = await (okuM as any).uiMultiplier();
  const okuMHeld: bigint = await (okuM as any).balanceOf(wrapperAddress);
  const mUsd: bigint = await (usdOku as any).usdOkuIndex();
  const rate: bigint = await (usdOku as any).ratePerSecond();
  const rateEnd: bigint = await (usdOku as any).rateEnd();
  const totalShares: bigint = await (usdOku as any).totalShares();
  const solvencySource: string = await (usdOku as any).solvencySource();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

  logger.section("Indices");
  logger.info(`M_oku (realized, stepwise):    ${ethers.formatEther(mOku)}`);
  logger.info(`M_usd (declared, continuous):  ${ethers.formatEther(mUsd)}`);
  logger.info(
    `  declared rate:               ${rate} (${impliedAprBps(rate)}bps nominal APR)`
  );
  logger.info(
    `  rateEnd:                     ${new Date(Number(rateEnd) * 1000).toISOString()}` +
      `${now >= rateEnd ? "  [ACCRUAL STOPPED]" : ""}`
  );
  if (mUsd > mOku) {
    logger.info(
      `  M_usd is AHEAD of M_oku by ${((mUsd - mOku) * BASIS_POINTS) / mOku}bps of ` +
        `M_oku — expected between realized marks. Note neither index prices a ` +
        `conversion at the other: wrap and unwrap both quote at M_oku.`
    );
  }

  logger.section("Position");
  logger.info(`declaredLiability (USDOku supply): $${ethers.formatEther(liability)}`);
  logger.info(`realizedBacking (OkuM @ M_oku):    $${ethers.formatEther(backing)}`);
  logger.info(`  wrapper OkuM holding:            ${ethers.formatEther(okuMHeld)} raw`);
  logger.info(`totalShares:                       ${ethers.formatEther(totalShares)}`);
  logger.info(
    `backingRatioBps:                   ` +
      `${ratioBps === UINT256_MAX ? "uint256.max (no liability)" : `${ratioBps} (${Number(ratioBps) / 100}%)`}`
  );

  logger.section("Gap");
  if (gapBps === INT256_MAX) {
    logger.error(
      `solvencyGapBps = int256.max — there is liability against ZERO backing. ` +
        `Every unwrap is reverting InsufficientBacking and setUsdOkuRate is locked ` +
        `out. Transfer OkuM to ${wrapperAddress} immediately; a plain transfer ` +
        `counts as backing.`
    );
  } else if (gapBps < 0n) {
    logger.success(
      `solvencyGapBps = ${gapBps} — OVER-BACKED by ${-gapBps}bps. Typical right ` +
        `after a realized M_oku step.`
    );
  } else if (gapBps === 0n) {
    logger.success(`solvencyGapBps = 0 — declared and realized are level.`);
  } else if (gapBps * 2n <= MAX_SOLVENCY_GAP_BPS) {
    logger.success(
      `solvencyGapBps = ${gapBps} of ${MAX_SOLVENCY_GAP_BPS} allowed — healthy ` +
        `smoothing.`
    );
  } else if (gapBps <= MAX_SOLVENCY_GAP_BPS) {
    logger.warning(
      `solvencyGapBps = ${gapBps} of ${MAX_SOLVENCY_GAP_BPS} allowed — over half the ` +
        `ceiling. The bound is CUMULATIVE, so the next setUsdOkuRate may be refused ` +
        `even at a modest rate. Mark realized yield (setOkuMultiplier.ts) or fund ` +
        `the buffer.`
    );
  } else {
    logger.error(
      `solvencyGapBps = ${gapBps}, ABOVE the ${MAX_SOLVENCY_GAP_BPS}bps bound. ` +
        `setUsdOkuRate is currently locked out (SolvencyGapExceeded) — the check ` +
        `runs at write time, so time alone can carry the position past it. Close it ` +
        `with a realized M_oku step or an OkuM top-up; a lower rate will not.`
    );
  }

  // What it would take to get back to level, expressed in the two units an
  // operator can actually act in.
  if (liability > backing) {
    const shortfallUsd = liability - backing;
    const shortfallRaw = (shortfallUsd * PRECISION) / mOku;
    logger.info("");
    logger.info(
      `To reach zero gap: transfer ${ethers.formatEther(shortfallRaw)} raw OkuM ` +
        `($${ethers.formatEther(shortfallUsd)} at the current M_oku) to the wrapper,`
    );
    if (okuMHeld > 0n) {
      const neededMultiplier = (liability * PRECISION) / okuMHeld;
      const neededStepBps = ((neededMultiplier - mOku) * BASIS_POINTS) / mOku;
      logger.info(
        `or step M_oku to ${ethers.formatEther(neededMultiplier)} ` +
          `(+${neededStepBps}bps). Note MAX_STEP_BPS is 100 per write, and a step ` +
          `revalues ALL OkuM holders, not just the wrapper's buffer — it is the ` +
          `right lever only when the yield is genuinely realized.`
      );
    }
  }

  logger.section("Wrapper controls");
  logger.info(`wrapEnabled:      ${wrapEnabled}${wrapEnabled ? "" : "  [SUNSET STEP 1 APPLIED]"}`);
  logger.info(`paused:           ${paused}${paused ? "  [BOTH DIRECTIONS BLOCKED]" : ""}`);
  logger.info(`usdOku.solvencySource: ${solvencySource}`);
  if (solvencySource.toLowerCase() !== wrapperAddress.toLowerCase()) {
    logger.error(
      `usdOku.solvencySource is NOT this wrapper. The on-chain projection check in ` +
        `setUsdOkuRate reads backing from ${solvencySource === ethers.ZeroAddress ? "nowhere (reads as zero)" : solvencySource}, ` +
        `so the gap shown above is not the gap the contract will enforce.`
    );
  }
  if (paused) {
    logger.warning(
      "The wrapper is PAUSED, which blocks unwrap as well as wrap. That is incident " +
        "response, not a sunset — holders cannot exit. Unpause as soon as the " +
        "incident allows (pause.ts / unpause.ts --target=wrapper)."
    );
  }
}

runScript(main);
