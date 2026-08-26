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
 * FOUR ON-CHAIN BOUNDS, each with its own revert:
 *   MultiplierCannotDecrease  strict monotonicity; a no-op write is also refused
 *                             (it would re-arm the sync window for free)
 *   StepAboveMaximum          a single step may not exceed MAX_STEP_BPS
 *   MultiplierAboveMaximum    cumulative ceiling, MAX_MULTIPLIER (1e24)
 *   AccrualIsHalted           the guardian's flag is set; cold must
 *                             `resumeAccrual` first (resumeAccrual.ts)
 *
 * NO STEP-COVERAGE CHECK HERE, and its absence is the notable change. The token
 * used to read `SubscriptionModule.tin() + tout()` at write time and refuse any
 * step the current fees did not cover (`StepNotCovered`), with a
 * `stepHighWaterMark` ratchet stopping fees dropping afterwards. That is gone.
 *
 * Coverage is now guaranteed by construction instead: `setFees` floors EACH leg
 * at `MAX_STEP_BPS`, and this write caps a step at `MAX_STEP_BPS`, so every
 * admissible step is covered on each leg for all time. Consequences for an
 * operator:
 *
 *   - The fee schedule can no longer block a mark. There is no wiring step to
 *     forget and no ordering to get wrong.
 *   - `MAX_STEP_BPS` alone sets the maximum mark, so it alone sets the MINIMUM
 *     cadence. A long outage must be walked over several marks.
 *   - Taking a large mark no longer has a permanent side effect on the fee
 *     floor. There is no ratchet to raise and no escape hatch to call.
 *
 * This script pre-checks the remaining bounds and refuses locally, with the
 * arithmetic shown, rather than letting a cold signer discover a selector on a
 * screen.
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

  // The fee schedule is printed for context only — it does not gate this write
  // any more. Both legs are floored at MAX_STEP_BPS on-chain, so coverage of
  // any admissible step is automatic.
  const tin: bigint = await (moduleContract as any).tin();
  const tout: bigint = await (moduleContract as any).tout();
  const halted: boolean = await (okuM as any).accrualHalted();

  logger.info("");
  logger.info(`Current M_oku:      ${ethers.formatEther(current)}`);
  logger.info(`Target M_oku:       ${ethers.formatEther(target)}`);
  logger.info(`Step:               ${step}bps (rounded up, as the contract does)`);
  logger.info(`Step ceiling:       ${MAX_STEP_BPS}bps (MAX_STEP_BPS)`);
  logger.info(
    `Fees (context only): tin=${tin}bps tout=${tout}bps — each >= ${MAX_STEP_BPS}bps ` +
      `by construction, so this step is covered whatever its size below the ceiling`
  );
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

  if (step > MAX_STEP_BPS) {
    throw new Error(
      `PRE-CONDITION FAILED: step ${step}bps exceeds MAX_STEP_BPS ` +
        `(${MAX_STEP_BPS}bps); the contract reverts StepAboveMaximum(${step}, ` +
        `${MAX_STEP_BPS}).\n` +
        `  WHY: mint at M0 then redeem at M1 extracts the step from the USDC ` +
        `buffer unless the fee covers it. Rather than checking the live fee, the ` +
        `protocol bounds the step at exactly the amount each fee leg is ` +
        `guaranteed to cover, so a step above this bound could not be covered by ` +
        `any admissible schedule.\n` +
        `  ONE FIX: take a smaller step, --step-bps=${MAX_STEP_BPS} or lower. ` +
        `Raising fees does NOT help any more — the ceiling is a constant, not a ` +
        `function of the schedule. Under-marking this period loses nothing: the ` +
        `unrecognised yield lands in the next mark.\n` +
        `  If marks are routinely hitting this bound, the cadence is too slow for ` +
        `MAX_STEP_BPS and that is a parameter decision, not an operator one.`
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
