/**
 * Step `M_oku` — the realized index on OkuM (`OKU_RATE_SETTER`).
 *
 * Calls `OkuM.setOkuMultiplier(newMultiplier)`. Replaces half of v0.3's
 * `setYieldRate.ts`; the CONTINUOUS-rate half moved to `setUsdOkuRate.ts` and
 * now lives on USDOku. If you are looking for "set the APR", that is the other
 * script.
 *
 * THIS IS AN ORACLE WRITE, and the highest-value one in the system. `M_oku`
 * prices every conversion the protocol performs: subscription, redemption, queue
 * settlement, wrap and unwrap all quote through it, and `OkuMultiplierAdapter`
 * republishes it to any lending market that wants it. `totalAssets()` is derived
 * from the multiplier rather than measured, so there is NO on-chain referent
 * that can catch a wrong value — the only defences are the bounds below and
 * whoever is reading this script's output before signing.
 *
 * WHAT A STEP MEANS. `M_oku` is the *realized* mark: dollars per raw OkuM, moved
 * when off-chain T-Bill performance is actually recognised. It is stepwise
 * rather than continuous on purpose — a T-Bill mark is a discrete event, and
 * publishing it as a rate-per-second would make it forward-looking, which is
 * USDOku's job. It is also what Token-2022's `ScaledUiAmount` does on SVM, so
 * both chains carry the same value at the same cadence.
 *
 * FIVE ON-CHAIN BOUNDS, each with its own revert:
 *   MultiplierCannotDecrease  strict monotonicity; a no-op write is also refused
 *                             (it would re-arm the sync window for free)
 *   StepAboveMaximum          a single step may not exceed MAX_STEP_BPS (100)
 *   StepNotCovered            `tin + tout >= stepBps` must hold — see below
 *   MultiplierAboveMaximum    cumulative ceiling, MAX_MULTIPLIER (1e24)
 *   AccrualIsHalted           the guardian's flag is set; cold must
 *                             `resumeAccrual` first (resumeAccrual.ts)
 *
 * STEP COVERAGE IS THE ONE THAT WILL SURPRISE YOU. The round trip
 * mint-at-M0 / redeem-at-M1 extracts the step from the USDC buffer unless the
 * combined fee covers it, so the token refuses any step larger than
 * `SubscriptionModule.tin() + tout()`. Consequences worth internalising:
 *
 *   - At tin = tout = 0, NO step of any size is possible. Fees ship at zero.
 *   - An unwired `stepFeeSource` reads as ZERO coverage, so a deployment that
 *     skipped that wiring cannot step at all (deploy/index.ts step 6).
 *   - Coverage is a ratchet: the largest step ever taken becomes a floor under
 *     `setFees` (`stepHighWaterMark`). Taking a big step today permanently
 *     raises the minimum fee until cold clears it.
 *
 * This script pre-checks all of it and refuses locally, with the arithmetic
 * shown, rather than letting a cold signer discover a selector on a screen.
 *
 * THE SYNC WINDOW ARMS ITSELF. There is no begin/end protocol any more (v0.3's
 * `beginSyncWindow.ts` / `endSyncWindow.ts` are deleted, and the instructions
 * with them). Every successful step auto-arms a bounded lock on everything that
 * prices through the multiplier — module mint/redeem, queue processing, wrapper
 * wrap/unwrap — which expires on its own after `syncWindowDuration()`. Each
 * chain fences itself; cross-chain parity is verified off-chain by comparing
 * multiplier VALUES, which equal epoch counters never actually proved.
 *
 * Two ways to specify the target — `--step-bps` is preferred for a routine mark
 * because it is the number the coverage rule is stated in:
 *
 *   --step-bps=10            step up by 10 bps from the current value
 *   --multiplier=1.0105      absolute target, in whole dollars (18 dp)
 *
 * Usage:
 *   npx hardhat run scripts/operator/setOkuMultiplier.ts --network base --step-bps 10
 *   DRY_RUN=true MULTIPLIER=1.0105 npx hardhat run \
 *       scripts/operator/setOkuMultiplier.ts --network base
 *
 * Flags:
 *   --step-bps=<bps>       step size in basis points of the current multiplier
 *   --multiplier=<dollars> absolute target (e.g. 1.0105), mutually exclusive
 *   DRY_RUN=true           simulate
 *   --yes-mainnet          bypass the mainnet guard
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import {
  BASIS_POINTS,
  DRY_RUN,
  MAX_MULTIPLIER,
  MAX_STEP_BPS,
  PRECISION,
  attachAlso,
  parseArg,
  runScript,
  setup,
  stepBps,
  submit,
} from "./_shared";

async function main() {
  const { contract: okuM, signer, bookKey } = await setup("setOkuMultiplier", "OkuM");
  const moduleContract = await attachAlso("SubscriptionModule", bookKey, signer);

  const current: bigint = await (okuM as any).uiMultiplier();

  // ---- Resolve the target ----
  const stepArg = parseArg("step-bps");
  const multiplierArg = parseArg("multiplier");
  if (stepArg && multiplierArg) {
    throw new Error("--step-bps and --multiplier are mutually exclusive");
  }
  if (!stepArg && !multiplierArg) {
    throw new Error("Required: --step-bps=<bps> (preferred) or --multiplier=<dollars>");
  }

  let target: bigint;
  if (stepArg) {
    const bps = BigInt(stepArg);
    if (bps <= 0n) {
      throw new Error(
        `--step-bps must be > 0; the contract refuses a no-op write ` +
          `(MultiplierCannotDecrease is strict, so an equal value reverts too).`
      );
    }
    // Round the target UP so the realized step is at least the requested bps.
    // Rounding down could land a step of `bps - 1`, which silently under-marks.
    target = current + (current * bps + BASIS_POINTS - 1n) / BASIS_POINTS;
  } else {
    target = ethers.parseEther(multiplierArg!);
  }

  // ---- Local mirror of every on-chain bound ----
  if (target <= current) {
    throw new Error(
      `target ${ethers.formatEther(target)} <= current ${ethers.formatEther(current)}: ` +
        `M_oku is strictly monotone, so the contract reverts MultiplierCannotDecrease. ` +
        `A step down is not recoverable by any key — it would have to be an upgrade.`
    );
  }
  if (target > MAX_MULTIPLIER) {
    throw new Error(
      `target ${target} exceeds MAX_MULTIPLIER ${MAX_MULTIPLIER}; the contract ` +
        `reverts MultiplierAboveMaximum.`
    );
  }

  const step = stepBps(current, target);
  if (step > MAX_STEP_BPS) {
    throw new Error(
      `step is ${step}bps, above MAX_STEP_BPS (${MAX_STEP_BPS}bps); the contract ` +
        `reverts StepAboveMaximum. Split the mark across several smaller steps — ` +
        `each pays its own coverage check, so the total fee requirement is ` +
        `unchanged, but no single write breaches the per-step ceiling.`
    );
  }

  // Step coverage. Read from the module (which is where the fee schedule lives)
  // AND cross-check that the token is actually pointed at it: an unwired
  // `stepFeeSource` makes coverage read as zero on-chain no matter what the
  // module says, which is the single most confusing way for this call to fail.
  const feeSource: string = await (okuM as any).stepFeeSource();
  const moduleAddress = await moduleContract.getAddress();
  const tin: bigint = await (moduleContract as any).tin();
  const tout: bigint = await (moduleContract as any).tout();
  const coverage = tin + tout;
  const highWater: bigint = await (okuM as any).stepHighWaterMark();
  const halted: boolean = await (okuM as any).accrualHalted();

  logger.info("");
  logger.info(`Current M_oku:      ${ethers.formatEther(current)}`);
  logger.info(`Target M_oku:       ${ethers.formatEther(target)}`);
  logger.info(`Step:               ${step}bps (rounded up, as the contract does)`);
  logger.info(`Coverage tin+tout:  ${coverage}bps (tin=${tin} tout=${tout})`);
  logger.info(`stepFeeSource:      ${feeSource}`);
  logger.info(`stepHighWaterMark:  ${highWater}bps (current floor under setFees)`);
  logger.info(`accrualHalted:      ${halted}`);
  logger.info(
    `syncWindowDuration: ${await (okuM as any).syncWindowDuration()}s ` +
      `(auto-armed by this write)`
  );

  if (halted) {
    throw new Error(
      `PRE-CONDITION FAILED: accrualHalted is true — the guardian has blocked ` +
        `further steps and the contract reverts AccrualIsHalted. This is a ` +
        `deliberate asymmetry: the warm guardian key can stop marking, but only ` +
        `OKU_CAP_MANAGER (cold) can resume it. Run ` +
        `scripts/operator/resumeAccrual.ts from cold first.`
    );
  }

  if (feeSource === ethers.ZeroAddress) {
    throw new Error(
      `PRE-CONDITION FAILED: okuM.stepFeeSource is unset, so step coverage reads ` +
        `as ZERO regardless of the module's actual fees and EVERY step reverts ` +
        `StepNotCovered. This is fail-closed by design. Fix with ` +
        `okuM.setStepFeeSource(${moduleAddress}) from OKU_CAP_MANAGER — it is ` +
        `step 6 of scripts/deploy/index.ts and was evidently skipped.`
    );
  }
  if (feeSource.toLowerCase() !== moduleAddress.toLowerCase()) {
    throw new Error(
      `PRE-CONDITION FAILED: okuM.stepFeeSource is ${feeSource} but the address ` +
        `book's SubscriptionModule is ${moduleAddress}. Coverage will be read ` +
        `from the OTHER contract, so the fees printed above are not the fees ` +
        `that will be checked. Resolve the disagreement before signing.`
    );
  }

  if (step > coverage) {
    throw new Error(
      `PRE-CONDITION FAILED: step ${step}bps exceeds coverage ${coverage}bps; the ` +
        `contract reverts StepNotCovered(${step}, ${coverage}).\n` +
        `  WHY: mint at M0 then redeem at M1 extracts the step from the USDC ` +
        `buffer unless the round-trip fee covers it — profit per unit is ` +
        `M1/M0 - 1 - (tin + tout)/10000.\n` +
        `  TWO FIXES, and they are not equivalent:\n` +
        `    (a) raise tin+tout to >= ${step}bps first ` +
        `(scripts/operator/setFees.ts). Charges every subscriber and redeemer.\n` +
        `    (b) take a smaller step: --step-bps=${coverage} or lower. Under-marks ` +
        `this period; the unrecognised yield is not lost, it lands in the next mark.`
    );
  }

  if (step > highWater) {
    logger.warning(
      `This step (${step}bps) exceeds the current stepHighWaterMark (${highWater}bps), ` +
        `so it will RATCHET the floor under setFees to ${step}bps. From then on ` +
        `tin+tout can never drop below ${step}bps (FeesBelowStepFloor) unless cold ` +
        `calls resetStepHighWaterMark, which emits an alarmed event. A one-off large ` +
        `mark therefore permanently raises the minimum fee.`
    );
  }

  // Display-layer consequence of the step, at the current supply. This is the
  // number a holder sees move, and the only place in this script where the size
  // of the mark is expressed in dollars rather than basis points.
  const supply: bigint = await (okuM as any).totalSupply();
  const uiBefore = (supply * current) / PRECISION;
  const uiAfter = (supply * target) / PRECISION;
  logger.info("");
  logger.info(`totalSupply:        ${ethers.formatEther(supply)} raw (unchanged by a step)`);
  logger.info(`totalSupplyUI:      $${ethers.formatEther(uiBefore)} -> $${ethers.formatEther(uiAfter)}`);
  logger.info(`Value created:      $${ethers.formatEther(uiAfter - uiBefore)}`);

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("setOkuMultiplier", () => (okuM as any).setOkuMultiplier(target));

  const confirmed: bigint = await (okuM as any).uiMultiplier();
  const pending: bigint = await (okuM as any).newUIMultiplier();
  const lockedUntil: bigint = await (okuM as any).syncLockedUntil();

  if (confirmed !== target) {
    throw new Error(
      `POST-CONDITION FAILED: uiMultiplier is ${confirmed}, expected ${target}.`
    );
  }
  if (confirmed !== pending) {
    throw new Error(
      `POST-CONDITION FAILED: uiMultiplier (${confirmed}) != newUIMultiplier ` +
        `(${pending}). Steps are immediate, so these must always be equal; a ` +
        `divergence means the pending-multiplier semantics have drifted.`
    );
  }

  logger.success(`M_oku = ${ethers.formatEther(confirmed)} (step ${step}bps)`);
  logger.success(`New stepHighWaterMark: ${await (okuM as any).stepHighWaterMark()}bps`);
  if (lockedUntil > 0n) {
    logger.warning(
      `Sync window armed until ${new Date(Number(lockedUntil) * 1000).toISOString()}. ` +
        `Module mint/redeem, queue processing and wrapper wrap/unwrap revert ` +
        `SyncWindowActive until then. It expires on its own — there is nothing to close.`
    );
  } else {
    logger.warning(
      `syncWindowDuration is 0, so no window was armed and the step landed unfenced. ` +
        `On a multi-chain deployment that leaves the propagation interval exposed.`
    );
  }
  logger.info(
    `NEXT: write the SAME value on every other chain, then verify parity by ` +
      `comparing multiplier values (SVM: check-sync-parity.ts).`
  );
}

runScript(main);
