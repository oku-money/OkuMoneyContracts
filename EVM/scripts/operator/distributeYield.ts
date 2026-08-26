/**
 * Mark realized yield as a DOLLAR AMOUNT, letting the contract derive the
 * `M_oku` step.
 *
 * The twin of `setOkuMultiplier.ts`, and of SVM's `distribute_yield`. Both
 * chains expose the same two mark-entry shapes:
 *
 *   setOkuMultiplier(newMultiplier)  — you compute the index
 *   distributeYield(yieldAmount)     — you hand over dollars, it computes the index
 *
 *       newMultiplier = uiMultiplier() + yieldAmount * PRECISION / totalSupply()
 *
 * WHICH ONE TO USE. `distributeYield` is the right entry point when the treasury
 * figure you are working from is "this period earned $X". It removes a manual
 * division from the operator's side of the fence, which is where a fat-fingered
 * multiplier would otherwise come from — and a wrong `M_oku` mints borrowing
 * power directly in any lending market pricing off `uiMultiplier()`.
 *
 * Use `setOkuMultiplier` instead when correcting the index to a specific known
 * value, e.g. re-anchoring after an incident.
 *
 * NOT A SECOND AUTHORITY. It routes through the identical validation path, so
 * every bound is inherited rather than restated:
 *
 *   MultiplierCannotDecrease  strict monotonicity
 *   StepAboveMaximum          the derived step may not exceed MAX_STEP_BPS
 *   MultiplierAboveMaximum    cumulative ceiling, MAX_MULTIPLIER
 *   AccrualIsHalted           the guardian's flag; cold must resumeAccrual first
 *
 * plus two of its own:
 *
 *   NoSupplyToDistributeTo    zero supply — nobody to distribute to, and the
 *                             per-share divisor would be zero
 *   YieldTooSmall             the amount does not move `M_oku` by even 1 wei.
 *                             Fails loudly rather than silently no-opping, which
 *                             would still stamp `lastSteppedAt` and re-arm the
 *                             sync window for free.
 *
 * THE REMAINDER IS NOT LOST. The per-share delta FLOORS, so a dollar amount that
 * does not divide evenly across supply leaves the remainder in the buffer as
 * surplus rather than inflating the mark. It lands in a later mark.
 *
 * Usage:
 *   npx hardhat run scripts/operator/distributeYield.ts --network sepolia --dollars 1234.56
 *   DRY_RUN=true DOLLARS=1234.56 npx hardhat run scripts/operator/distributeYield.ts --network sepolia
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import {
  BASIS_POINTS,
  DRY_RUN,
  MAX_MULTIPLIER,
  MAX_STEP_BPS,
  PRECISION,
  requireArg,
  runScript,
  setup,
  submit,
} from "./_shared";

async function main() {
  const { contract: okuM, signer } = await setup("distributeYield", "OkuM");

  const yieldAmount = ethers.parseEther(requireArg("dollars"));
  if (yieldAmount === 0n) throw new Error("--dollars must be greater than zero");

  const current: bigint = await (okuM as any).uiMultiplier();
  const supply: bigint = await (okuM as any).totalSupply();
  const halted: boolean = await (okuM as any).accrualHalted();

  if (supply === 0n) {
    throw new Error(
      "PRE-CONDITION FAILED: totalSupply is zero, so the contract reverts " +
        "NoSupplyToDistributeTo. There is nobody to distribute to. Mint first, or " +
        "use setOkuMultiplier.ts if you are seeding an index before any supply exists."
    );
  }
  if (halted) {
    throw new Error(
      "PRE-CONDITION FAILED: accrualHalted is true — the guardian has blocked " +
        "further marks and the contract reverts AccrualIsHalted. Run " +
        "scripts/operator/resumeAccrual.ts from OKU_CAP_MANAGER (cold) first."
    );
  }

  // Mirror the contract's arithmetic exactly, including the floor.
  const delta = (yieldAmount * PRECISION) / supply;
  const target = current + delta;
  // `stepBps` ceils on-chain, so this must too.
  const stepBps = delta === 0n ? 0n : (delta * BASIS_POINTS + current - 1n) / current;

  logger.info("");
  logger.info(`Yield in:        $${ethers.formatEther(yieldAmount)}`);
  logger.info(`Total supply:    ${ethers.formatEther(supply)} raw OkuM`);
  logger.info(`Current M_oku:   ${ethers.formatEther(current)}`);
  logger.info(`Derived M_oku:   ${ethers.formatEther(target)}`);
  logger.info(`Implied step:    ${stepBps}bps (ceiled, as the contract does)`);
  logger.info(`Step ceiling:    ${MAX_STEP_BPS}bps (MAX_STEP_BPS)`);

  if (delta === 0n) {
    throw new Error(
      `PRE-CONDITION FAILED: $${ethers.formatEther(yieldAmount)} across ` +
        `${ethers.formatEther(supply)} raw OkuM floors to a zero per-share delta, ` +
        `so the contract reverts YieldTooSmall.\n` +
        `  The smallest amount that moves the index at this supply is ` +
        `~$${ethers.formatEther(supply / PRECISION + 1n)}. Accumulate and mark less ` +
        `often rather than marking nothing.`
    );
  }

  if (stepBps > MAX_STEP_BPS) {
    throw new Error(
      `PRE-CONDITION FAILED: the implied step is ${stepBps}bps, above MAX_STEP_BPS ` +
        `(${MAX_STEP_BPS}bps), so the contract reverts StepAboveMaximum.\n` +
        `  WHY: the step ceiling is exactly what each fee leg is guaranteed to ` +
        `cover, so a larger step could not be covered by any admissible fee ` +
        `schedule. Raising fees does NOT help — the ceiling is a constant.\n` +
        `  FIX: split this into several marks. The largest amount that fits right ` +
        `now is ~$${ethers.formatEther(
          (current * MAX_STEP_BPS * supply) / (BASIS_POINTS * PRECISION)
        )}. The remainder is not lost; mark it next.\n` +
        `  If marks routinely exceed the ceiling, the cadence is too slow for ` +
        `MAX_STEP_BPS — a parameter decision, not an operator one.`
    );
  }

  if (target > MAX_MULTIPLIER) {
    throw new Error(
      `PRE-CONDITION FAILED: derived M_oku ${target} exceeds MAX_MULTIPLIER ` +
        `(${MAX_MULTIPLIER}); the contract reverts MultiplierAboveMaximum.`
    );
  }

  // The number a holder actually sees move.
  const uiBefore = (supply * current) / PRECISION;
  const uiAfter = (supply * target) / PRECISION;
  logger.info(
    `Displayed supply: $${ethers.formatEther(uiBefore)} -> $${ethers.formatEther(uiAfter)} ` +
      `(+$${ethers.formatEther(uiAfter - uiBefore)})`
  );
  const undistributed = yieldAmount - ((uiAfter - uiBefore) as bigint);
  if (undistributed > 0n) {
    logger.info(
      `Undistributed remainder: $${ethers.formatEther(undistributed)} — floors into ` +
        `the buffer as surplus rather than inflating the mark. Not lost; it lands ` +
        `in a later mark.`
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit(`distributeYield($${ethers.formatEther(yieldAmount)})`, () =>
    (okuM as any).connect(signer).distributeYield(yieldAmount)
  );

  const confirmed: bigint = await (okuM as any).uiMultiplier();
  if (confirmed !== target) {
    throw new Error(
      `POST-CONDITION FAILED: M_oku is ${confirmed}, expected ${target}. The ` +
        `derivation this script mirrors has drifted from the contract's.`
    );
  }
  logger.success(`M_oku = ${ethers.formatEther(confirmed)} (step ${stepBps}bps)`);

  const lockedUntil: bigint = await (okuM as any).syncLockedUntil();
  if (lockedUntil > 0n) {
    logger.info(
      `Sync window armed until ${new Date(Number(lockedUntil) * 1000).toISOString()}. ` +
        `On EVM this gates nothing — it is an advisory signal for monitoring and ` +
        `for the bridge adapter. Nothing is blocked by it.`
    );
  }
}

runScript(main);
