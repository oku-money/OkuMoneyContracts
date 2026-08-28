/**
 * Set subscription/redemption fees on SubscriptionModule (`SUB_FEE_MANAGER`).
 *
 * These are COMMERCIAL parameters, not a safety mechanism. There is no
 * permissionless round trip left to price against, so the old step-coverage
 * floor is gone; the only bound is `MAX_FEE_BPS` (100 = 1%) as anti-confiscation.
 *
 * Fees apply at FULFILMENT, and the rate in force at fulfilment is the one
 * charged — a pending request is protected by its `minOut`, not by a snapshot.
 * Raising fees can therefore cause in-flight requests to revert `SlippageExceeded`.
 *
 * Fees are WITHHELD, not forwarded: the full gross reaches treasury while less
 * OkuM is minted, which raises the collateral ratio.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setFees.ts --network base --tin=10 --tout=10
 */

import { operatorContext, submit, arg, run, logger } from "./_shared";

const MAX_FEE_BPS = 100n;

run(async () => {
  const ctx = await operatorContext("setFees");
  const module = await ctx.at("SubscriptionModule");

  const tin = BigInt(arg("tin") ?? "0");
  const tout = BigInt(arg("tout") ?? "0");

  if (tin > MAX_FEE_BPS || tout > MAX_FEE_BPS) {
    throw new Error(`Fees exceed MAX_FEE_BPS (${MAX_FEE_BPS}): tin=${tin} tout=${tout}`);
  }

  logger.info(`Current tin/tout:  ${await (module as any).tinBps()} / ${await (module as any).toutBps()}`);
  logger.info(`New tin/tout:      ${tin} / ${tout}`);
  logger.warning("Applies at fulfilment — in-flight requests may revert SlippageExceeded.");

  await submit("setFees", () => (module as any).setFees(tin, tout));
});
