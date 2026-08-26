/**
 * Set the SubscriptionModule `tin` / `tout` fee schedule
 * (`PSM_FEE_MANAGER`, cold multisig).
 *
 * Calls `SubscriptionModule.setFees(tin, tout)`. Fee parameters and names are
 * inherited from `makerdao/dss-lite-psm`, which this module was ported from.
 *
 * ---------------------------------------------------------------------------
 * THIS IS NOT A REVENUE DIAL. `tin + tout` IS THE STEP-COVERAGE BUDGET.
 * ---------------------------------------------------------------------------
 *
 * `M_oku` steps, so the round trip mint-at-M0 / redeem-at-M1 extracts the step
 * out of the USDC buffer unless the round-trip fee covers it:
 *
 *     profit per unit = M1/M0 - 1 - (tin + tout)/10_000
 *
 * The STEP-COVERAGE INVARIANT is `tin + tout >= stepBps` for every step taken,
 * and it is enforced from both ends:
 *
 *   - `OkuM.setOkuMultiplier` reverts `StepNotCovered` if the proposed step
 *     exceeds what the CURRENT fees cover. Consequence: at tin = tout = 0 no
 *     step of any size is possible, so a deployment with zero fees can never
 *     mark yield.
 *   - This function reverts `FeesBelowStepFloor` if the new combined value would
 *     drop below `OkuM.stepHighWaterMark()` — the largest step ever taken.
 *     Coverage is a RATCHET: it cannot retroactively evaporate from under a step
 *     that already landed. Only the cold-gated `OkuM.resetStepHighWaterMark()`
 *     clears the floor, and it emits an alarmed event because its honest
 *     precondition (the supply outstanding at the time of the big step has
 *     substantially turned over) is not verifiable on-chain.
 *
 * SIZING. Size to the intended MARK CADENCE, not to a revenue target. At a 5%
 * annual mark: ~1.4bps daily, ~9.6bps weekly, ~40.7bps monthly. Each side is
 * bounded by MAX_FEE_BPS (100 = 1%), so the maximum achievable coverage is
 * 200bps and the maximum single step is MAX_STEP_BPS (100bps) regardless.
 *
 * THE WINDOW IS NOT THE DEFENCE. The post-step sync window fences cross-chain
 * propagation; it does nothing about step arbitrage, because holding raw across
 * a step requires no transaction while the window is open. Fees are the only
 * control here. Do not reach for a longer window instead.
 *
 * WHERE THE FEE GOES. Nowhere — it is withheld, not forwarded. `tin` is
 * deposited without being credited; `tout` is owed without being paid out. Both
 * stay in the USDC buffer, so a fee raises the collateral ratio rather than
 * being extracted. There is no recipient and no sweep.
 *
 * QUEUED REDEMPTIONS ARE PROTECTED. Each entry snapshots the `tout` prevailing
 * when it was enqueued, so raising the fee cannot retroactively tax users
 * already waiting — and settlement charges `min(snapshot, live)`, so a CUT is
 * passed on to them too.
 *
 * Usage:
 *   TIN=0 TOUT=50 npx hardhat run scripts/operator/setFees.ts --network base --yes-mainnet
 *   DRY_RUN=true TIN=0 TOUT=15 npx hardhat run scripts/operator/setFees.ts --network base
 *
 * Environment:
 *   TIN            Required. Mint fee in basis points.
 *   TOUT           Required. Redeem fee in basis points.
 *   DRY_RUN=true   Simulate without submitting
 *   --yes-mainnet  Required to broadcast on a mainnet network
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import {
  DRY_RUN,
  MAX_FEE_BPS,
  MAX_STEP_BPS,
  attachAlso,
  requireArg,
  runScript,
  setup,
  submit,
} from "./_shared";

async function main() {
  const { contract: moduleContract, signer, bookKey } =
    await setup("setFees", "SubscriptionModule");
  const okuM = await attachAlso("OkuM", bookKey, signer);

  const newTin = BigInt(requireArg("tin"));
  const newTout = BigInt(requireArg("tout"));

  const oldTin: bigint = await (moduleContract as any).tin();
  const oldTout: bigint = await (moduleContract as any).tout();
  const floorBps: bigint = await (okuM as any).stepHighWaterMark();
  const feeSource: string = await (okuM as any).stepFeeSource();
  const moduleAddress = await moduleContract.getAddress();

  logger.info("");
  logger.info(`tin:               ${oldTin}bps -> ${newTin}bps`);
  logger.info(`tout:              ${oldTout}bps -> ${newTout}bps`);
  logger.info(
    `coverage tin+tout: ${oldTin + oldTout}bps -> ${newTin + newTout}bps ` +
      `(cap on any single M_oku step)`
  );
  logger.info(`stepHighWaterMark: ${floorBps}bps (hard floor under the combined value)`);
  logger.info(`okuM.stepFeeSource:${feeSource}`);

  for (const [label, v] of [
    ["tin", newTin],
    ["tout", newTout],
  ] as const) {
    if (v > MAX_FEE_BPS) {
      throw new Error(
        `${label}=${v}bps exceeds MAX_FEE_BPS (${MAX_FEE_BPS}bps). This bound is a ` +
          `compile-time constant and cannot be raised by any key.`
      );
    }
  }

  // Mirror the on-chain ratchet so the failure is legible rather than a selector.
  if (newTin + newTout < floorBps) {
    throw new Error(
      `PRE-CONDITION FAILED: combined ${newTin + newTout}bps is below ` +
        `stepHighWaterMark ${floorBps}bps; the contract reverts ` +
        `FeesBelowStepFloor(${newTin + newTout}, ${floorBps}).\n` +
        `  WHY: a ${floorBps}bps step has already been taken, and it relied on ` +
        `${floorBps}bps of round-trip coverage. Letting fees fall below that would ` +
        `retroactively open the mint-hold-redeem round trip on a step that already ` +
        `landed.\n` +
        `  If the supply outstanding at the time of that step has genuinely turned ` +
        `over, OKU_CAP_MANAGER (cold) can clear the floor with ` +
        `OkuM.resetStepHighWaterMark() — but that emits StepHighWaterMarkReset, ` +
        `which should be alarmed on, and it reopens historical exposure.`
    );
  }

  if (feeSource.toLowerCase() !== moduleAddress.toLowerCase()) {
    logger.warning(
      `okuM.stepFeeSource is ${feeSource}, not this module (${moduleAddress}). ` +
        `Changing fees here will therefore NOT change what OkuM's step-coverage ` +
        `check reads. Fix the wiring (OKU_CAP_MANAGER: okuM.setStepFeeSource) or ` +
        `this call has no effect on stepping.`
    );
  }

  if (newTin + newTout === 0n) {
    logger.warning(
      "Setting combined fees to ZERO. This does not merely make the module free — " +
        "it makes MULTIPLIER STEPS IMPOSSIBLE. Step coverage requires " +
        "tin + tout >= stepBps, so setOkuMultiplier will revert StepNotCovered for " +
        "any step of any size, and the product will deliver no yield until fees are " +
        "restored. Only correct if you are deliberately parking the deployment."
    );
  } else if (newTin + newTout < 10n) {
    logger.warning(
      `Combined coverage of ${newTin + newTout}bps only supports a DAILY mark ` +
        `cadence (~1.4bps) at a 5% annual target. A weekly mark needs ~9.6bps and a ` +
        `monthly one ~40.7bps; anything larger will revert StepNotCovered.`
    );
  }
  if (newTin + newTout > MAX_STEP_BPS) {
    logger.info(
      `Coverage ${newTin + newTout}bps exceeds MAX_STEP_BPS (${MAX_STEP_BPS}bps), so ` +
        `the per-step ceiling — not coverage — is now the binding constraint. Extra ` +
        `coverage beyond ${MAX_STEP_BPS}bps buys no additional cadence.`
    );
  }

  if (newTout < oldTout) {
    logger.warning(
      "Lowering tout. Entries already in the redemption queue will settle at the " +
        "LOWER of their snapshotted fee and the new one, so this is passed on to " +
        "queued users as well as new ones."
    );
  }
  if (newTout > oldTout) {
    logger.info(
      "Raising tout. Entries already in the redemption queue keep their snapshotted " +
        "rate and are unaffected."
    );
  }

  // The concrete effect on a user, since bps on a signing screen is abstract.
  const multiplier: bigint = await (okuM as any).uiMultiplier();
  const sample = ethers.parseUnits("1000", 6); // 1000 USDC
  logger.info("");
  logger.info(`At M_oku = ${ethers.formatEther(multiplier)}, on a 1,000 USDC round trip:`);
  logger.info(
    `  tin  withholds ${ethers.formatUnits((sample * newTin) / 10_000n, 6)} USDC on the way in`
  );
  logger.info(
    `  tout withholds ~${ethers.formatUnits((sample * newTout) / 10_000n, 6)} USDC on the way out`
  );

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("setFees", () => (moduleContract as any).setFees(newTin, newTout));

  const gotTin: bigint = await (moduleContract as any).tin();
  const gotTout: bigint = await (moduleContract as any).tout();
  if (gotTin !== newTin || gotTout !== newTout) {
    throw new Error(
      `POST-CONDITION FAILED: on-chain fees are tin=${gotTin} tout=${gotTout}, ` +
        `expected tin=${newTin} tout=${newTout}`
    );
  }
  logger.success(
    `Fees set: tin=${gotTin}bps tout=${gotTout}bps — step coverage now ${gotTin + gotTout}bps.`
  );
  logger.warning("Apply the SAME schedule on every chain so the fee surface is symmetric.");
}

runScript(main);
