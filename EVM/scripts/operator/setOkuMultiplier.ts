/**
 * Write a new `M_oku` mark on OkuM (`OKU_RATE_SETTER`).
 *
 * This is an ORACLE WRITE. Anything pricing off `uiMultiplier()` — lending
 * markets, the OkuMultiplierAdapter, every wallet balance — moves with it.
 * The contract bounds a single step at `MAX_STEP_BPS`, but that is a sanity
 * bound against a compromised key, not a substitute for checking the number.
 *
 * The epoch must strictly increase and is recorded on both chains, so
 * `syncEpoch()` can be compared across EVM and SVM to assert both wrote for
 * the same mark. It proves both wrote, NOT that both wrote the same value.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setOkuMultiplier.ts --network base \
 *       --multiplier=1010000000000000000        # 1.01, i.e. +1%
 *   DRY_RUN=true MULTIPLIER=1010000000000000000 NETWORK=base npx hardhat run ...
 *
 * Flags:
 *   --multiplier=<18-dec>   new M_oku (required)
 *   --epoch=<n>             mark number (default: syncEpoch() + 1)
 *   DRY_RUN=true            simulate without submitting
 *   --yes-mainnet           bypass the mainnet guard
 */

import { operatorContext, submit, requireArg, arg, run, logger, ethers } from "./_shared";

run(async () => {
  const ctx = await operatorContext("setOkuMultiplier");
  const okuM = await ctx.at("OkuM");

  const newMultiplier = BigInt(requireArg("multiplier", "18-dec M_oku"));

  const current: bigint = await (okuM as any).uiMultiplier();
  const currentEpoch: bigint = await (okuM as any).syncEpoch();
  const epoch = arg("epoch") ? BigInt(arg("epoch")!) : currentEpoch + 1n;

  if (newMultiplier <= current) {
    throw new Error(
      `M_oku is monotone: new (${ethers.formatUnits(newMultiplier, 18)}) must exceed current (${ethers.formatUnits(current, 18)})`
    );
  }
  if (epoch <= currentEpoch) {
    throw new Error(`epoch must strictly increase: got ${epoch}, current is ${currentEpoch}`);
  }

  const stepBps = ((newMultiplier - current) * 10_000n) / current;

  logger.info(`Current M_oku:  ${ethers.formatUnits(current, 18)}`);
  logger.info(`New M_oku:      ${ethers.formatUnits(newMultiplier, 18)}`);
  logger.info(`Step:           ${stepBps} bps`);
  logger.info(`Epoch:          ${currentEpoch} -> ${epoch}`);

  if (await (okuM as any).accrualHalted()) {
    throw new Error("Accrual is halted. Call resumeAccrual (OKU_ACCRUAL_RESUMER, cold) first.");
  }

  // Mirror the on-chain bound so a bad number fails here rather than on-chain.
  if (stepBps > 100n) {
    throw new Error(`Step ${stepBps} bps exceeds MAX_STEP_BPS (100). Split across multiple marks.`);
  }

  logger.warning("This is an oracle write. Confirm the value against the attestation.");

  await submit("setOkuMultiplier", () => (okuM as any).setOkuMultiplier(newMultiplier, epoch));

  if (!process.env.DRY_RUN) {
    logger.success(`Confirmed M_oku:  ${ethers.formatUnits(await (okuM as any).uiMultiplier(), 18)}`);
    logger.success(`Confirmed epoch:  ${await (okuM as any).syncEpoch()}`);
  }
});
