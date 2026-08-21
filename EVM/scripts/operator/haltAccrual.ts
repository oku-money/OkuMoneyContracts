/**
 * Freeze the UI multiplier immediately (`OKU_GUARDIAN`).
 *
 * THE EMERGENCY LEVER against a compromised rate setter. No timelock.
 *
 * Monotone-safe by construction: it stops growth without reducing anything
 * already accrued, so the worst a compromised guardian key can do is withhold
 * future yield until the cold multisig overrides. That asymmetry is why the role
 * sits on the warm multisig.
 *
 * Also pulls `rateEnd` to `block.timestamp`, so after the call
 * `uiMultiplier() == newUIMultiplier()` and `effectiveAt() == now`. An
 * integrator therefore reads "halted, nothing pending" rather than the
 * ambiguous "live rate that yields nothing" state.
 *
 * Recovery: `OKU_RATE_SETTER` calls `setYieldRate` again. The halt is not sticky.
 *
 * Usage:
 *   npx hardhat run scripts/operator/haltAccrual.ts --network base --yes-mainnet
 *   DRY_RUN=true npx hardhat run scripts/operator/haltAccrual.ts --network base
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import { DRY_RUN, impliedAprBps, runScript, setup, submit } from "./_shared";

async function main() {
  const { contract: token } = await setup("haltAccrual", "OkuDollar");

  const before: bigint = await (token as any).uiMultiplier();
  const rate: bigint = await (token as any).ratePerSecond();
  const end: bigint = await (token as any).rateEnd();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

  logger.info(`uiMultiplier:  ${ethers.formatEther(before)}`);
  logger.info(`ratePerSecond: ${rate} (${impliedAprBps(rate)}bps APR)`);
  logger.info(
    `rateEnd:       ${new Date(Number(end) * 1000).toISOString()}` +
      `${now >= end ? "  [already halted]" : ""}`
  );

  if (now >= end) {
    logger.warning("Accrual is already stopped — this call will be a no-op in effect.");
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("haltAccrual", () => (token as any).haltAccrual());

  const after: bigint = await (token as any).uiMultiplier();
  const pending: bigint = await (token as any).newUIMultiplier();
  const newEnd: bigint = await (token as any).rateEnd();

  logger.success(`Frozen at ${ethers.formatEther(after)}`);
  if (after !== before) {
    logger.warning(
      `Multiplier moved between the read and the write (${ethers.formatEther(before)} -> ` +
        `${ethers.formatEther(after)}); expected under continuous accrual.`
    );
  }
  if (after !== pending) {
    throw new Error(
      `POST-CONDITION FAILED: uiMultiplier (${after}) != newUIMultiplier (${pending}) ` +
        `after a halt. The halted state should be unambiguous.`
    );
  }
  logger.success(
    `effectiveAt pulled to ${new Date(Number(newEnd) * 1000).toISOString()} — nothing pending.`
  );
  logger.info("Recovery: OKU_RATE_SETTER calls setYieldRate to resume.");
}

runScript(main);
