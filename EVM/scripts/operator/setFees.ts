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
 * The STEP-COVERAGE INVARIANT is STATIC and PER-LEG:
 *
 *     MAX_STEP_BPS <= tin  <= MAX_FEE_BPS
 *     MAX_STEP_BPS <= tout <= MAX_FEE_BPS
 *
 * and `OkuM.setOkuMultiplier` independently refuses any step above
 * `MAX_STEP_BPS`. Composed, every admissible step is covered on each leg for
 * all time. This function can therefore only ever RAISE fees above a floor that
 * `initialize` already seeded; it cannot create or remove coverage.
 *
 * PER-LEG RATHER THAN COMBINED, because a cross-chain round trip pays `tin` on
 * the chain it mints on and `tout` on the chain it redeems on. Fees of `(0, 2N)`
 * here and `(2N, 0)` on the peer chain would each satisfy a combined check while
 * that pairing paid nothing at all.
 *
 * WHAT USED TO BE HERE. The old design read `tin + tout` back into the token at
 * multiplier-write time (`StepNotCovered`), ratcheted a `stepHighWaterMark`,
 * floored this function against that mark (`FeesBelowStepFloor`), and offered a
 * cold `resetStepHighWaterMark` escape hatch. All of it is gone. Setting fees is
 * now an ordinary bounded parameter write with no coupling to step history and
 * no way to break the invariant.
 *
 * SIZING. `MAX_STEP_BPS` is the number that matters and it is a compile-time
 * constant, not something this script sets: it is simultaneously the cadence
 * bound and the fee floor. At a 5% annual mark a step is ~1.4bps daily, ~9.6bps
 * weekly, ~40.7bps monthly. Raising fees ABOVE the floor buys no extra cadence —
 * it is purely a revenue//haircut decision.
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
  logger.info("");
  logger.info(`tin:            ${oldTin}bps -> ${newTin}bps`);
  logger.info(`tout:           ${oldTout}bps -> ${newTout}bps`);
  logger.info(`round trip:     ${oldTin + oldTout}bps -> ${newTin + newTout}bps`);
  logger.info(
    `per-leg floor:  ${MAX_STEP_BPS}bps (MAX_STEP_BPS, a compile-time constant)`
  );
  logger.info(`per-leg cap:    ${MAX_FEE_BPS}bps (MAX_FEE_BPS)`);

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

  // Mirror the on-chain per-leg floor so the failure is legible rather than a
  // bare selector.
  for (const [label, v] of [
    ["tin", newTin],
    ["tout", newTout],
  ] as const) {
    if (v < MAX_STEP_BPS) {
      throw new Error(
        `PRE-CONDITION FAILED: ${label}=${v}bps is below MAX_STEP_BPS ` +
          `(${MAX_STEP_BPS}bps); the contract reverts FeeBelowStepFloor(${v}, ` +
          `${MAX_STEP_BPS}).\n` +
          `  WHY: each leg must independently cover the largest step ` +
          `setOkuMultiplier can take, which is exactly MAX_STEP_BPS. Per-leg ` +
          `rather than combined because a cross-chain round trip pays tin on one ` +
          `chain and tout on the other, so a zero leg anywhere is a free leg for ` +
          `that pairing.\n` +
          `  There is no escape hatch and no way to lower this. Changing it means ` +
          `changing MAX_STEP_BPS in Constants.sol, which is a code change with a ` +
          `matching cadence decision — deliberately not an operator action.`
      );
    }
  }

  if (newTin > MAX_STEP_BPS || newTout > MAX_STEP_BPS) {
    logger.info(
      `Fees above the ${MAX_STEP_BPS}bps floor buy no additional mark cadence — ` +
        `the cadence bound is MAX_STEP_BPS on the step side, not the fee side. ` +
        `Anything above the floor is a revenue/haircut decision.`
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
