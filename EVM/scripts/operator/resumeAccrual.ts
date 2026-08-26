/**
 * Lift the OkuM guardian halt (`OKU_CAP_MANAGER`, cold multisig).
 *
 * Calls `OkuM.resumeAccrual()`, clearing the `accrualHalted` flag so
 * `setOkuMultiplier` can land again.
 *
 * NEW IN v0.4, and it exists because the OkuM halt became sticky. Under the old
 * continuous-accrual model a halt froze a running rate and recovery was just
 * "set a rate again" — the guardian's action was self-reversing by the rate
 * setter. Now `haltAccrual()` sets a flag that only this cold-gated call can
 * clear.
 *
 * THAT ASYMMETRY IS THE POINT. The guardian sits on the warm multisig precisely
 * because its lever is monotone-safe: it can withhold future yield and nothing
 * else. Making the reversal cold-only is what keeps that trade honest — if warm
 * could both halt and resume, a compromised warm key could oscillate the mark
 * cadence, and the "abuse ceiling is a nuisance pause" argument stops holding.
 *
 * THERE IS NO USDOku EQUIVALENT, deliberately. `haltUsdOkuAccrual()` freezes the
 * index by writing a no-yield rate; resuming is an ordinary `setUsdOkuRate`
 * call, which the rate setter can already do. Adding a cold gate there would
 * mean a warm key could permanently stop the dollar leg's yield, which is a
 * strictly worse position than the one this design accepts on OkuM (where the
 * cold gate protects an ORACLE, not a payout schedule).
 *
 * BEFORE YOU RUN THIS. Resuming does not un-do the reason for the halt. The
 * guardian halted because something looked wrong with the multiplier authority;
 * confirm that the `OKU_RATE_SETTER` holder is the key you expect it to be, and
 * that the next intended mark is covered by the current fee schedule, before
 * handing the mark cadence back.
 *
 * Usage:
 *   npx hardhat run scripts/operator/resumeAccrual.ts --network base --yes-mainnet
 *   DRY_RUN=true npx hardhat run scripts/operator/resumeAccrual.ts --network base
 *
 * Flags:
 *   DRY_RUN=true    simulate
 *   --yes-mainnet   required to broadcast on a mainnet network
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import { DRY_RUN, attachAlso, runScript, setup, submit } from "./_shared";

async function main() {
  const { contract: okuM, signer, bookKey } = await setup("resumeAccrual", "OkuM");
  const moduleContract = await attachAlso("SubscriptionModule", bookKey, signer);

  const halted: boolean = await (okuM as any).accrualHalted();
  const multiplier: bigint = await (okuM as any).uiMultiplier();
  const lastStepped: bigint = await (okuM as any).lastSteppedAt();
  const highWater: bigint = await (okuM as any).stepHighWaterMark();
  const feeSource: string = await (okuM as any).stepFeeSource();
  const tin: bigint = await (moduleContract as any).tin();
  const tout: bigint = await (moduleContract as any).tout();
  const now = BigInt((await ethers.provider.getBlock("latest"))!.timestamp);

  logger.info("");
  logger.info(`accrualHalted:     ${halted}`);
  logger.info(`uiMultiplier:      ${ethers.formatEther(multiplier)}`);
  logger.info(
    `lastSteppedAt:     ${new Date(Number(lastStepped) * 1000).toISOString()} ` +
      `(${(Number(now - lastStepped) / 86_400).toFixed(1)} days ago)`
  );
  logger.info(`stepHighWaterMark: ${highWater}bps`);
  logger.info(`stepFeeSource:     ${feeSource}`);
  logger.info(`Coverage tin+tout: ${tin + tout}bps (tin=${tin} tout=${tout})`);

  if (!halted) {
    logger.warning(
      "accrualHalted is already false — this call is a no-op (the flag write is " +
        "unconditional, so it does not revert). Steps are already permitted."
    );
  }

  // Resuming into a configuration that cannot step is a silent trap: the flag
  // clears, the runbook says "recovered", and the next mark still reverts — with
  // a different selector. Surface it now.
  if (feeSource === ethers.ZeroAddress) {
    logger.warning(
      "stepFeeSource is UNSET. Clearing the halt will not make stepping work: " +
        "coverage reads as zero, so setOkuMultiplier reverts StepNotCovered instead " +
        "of AccrualIsHalted. Wire it (also OKU_CAP_MANAGER) in the same session."
    );
  } else if (tin + tout === 0n) {
    logger.warning(
      "Combined fees are ZERO. Clearing the halt will not make stepping work: " +
        "step coverage requires tin + tout >= stepBps, so no step of any size can " +
        "land. Set fees (scripts/operator/setFees.ts) in the same session."
    );
  }

  const stalenessDays = Number(now - lastStepped) / 86_400;
  if (stalenessDays > 7) {
    logger.warning(
      `The last step was ${stalenessDays.toFixed(1)} days ago, past ` +
        `OkuMultiplierAdapter's 7-day staleness threshold — the published feed is ` +
        `currently reverting for consumers. Marking promptly after this resume will ` +
        `restore it; note the catch-up mark must still fit MAX_STEP_BPS (100bps) ` +
        `per write, so a long halt needs several sequential steps.`
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("resumeAccrual", () => (okuM as any).resumeAccrual());

  const nowHalted: boolean = await (okuM as any).accrualHalted();
  const after: bigint = await (okuM as any).uiMultiplier();

  if (nowHalted) {
    throw new Error("POST-CONDITION FAILED: accrualHalted is still true after resumeAccrual.");
  }
  if (after !== multiplier) {
    throw new Error(
      `POST-CONDITION FAILED: uiMultiplier moved (${multiplier} -> ${after}) across a ` +
        `resume. Clearing the flag must not revalue anything.`
    );
  }

  logger.success(
    `Halt lifted. M_oku unchanged at ${ethers.formatEther(after)}; steps are permitted again.`
  );
  logger.info(
    "Next mark: scripts/operator/setOkuMultiplier.ts. It pre-checks coverage, so a " +
      "misconfigured fee schedule fails locally rather than on the signing device."
  );
}

runScript(main);
