/**
 * Set the PSM `tin` / `tout` fee schedule (`PSM_FEE_MANAGER`, cold multisig).
 *
 * Restores the fee parameters from the upstream this PSM was modelled on
 * (`makerdao/dss-lite-psm`), which the original port omitted.
 *
 * WHAT `tout` IS FOR. It is the control for *local* step arbitrage: minting at
 * M0, holding across a discrete multiplier step, and redeeming at M1 for the
 * whole step, risk-free and repeatable. The cross-chain sync window does NOT
 * address this — the attacker never transacts while the window is open, so
 * lengthening it changes nothing. A `tout` exceeding the yield delivered by one
 * step is what makes the round trip lossy.
 *
 * ON EVM THIS IS PARITY, NOT DEFENCE. Accrual here is continuous, so there is no
 * discrete step to hold across and no local arbitrage surface to close. The
 * parameters exist so the fee schedule, runbook and monitoring stay symmetric
 * with SVM, where the stepped Token-2022 multiplier makes `tout` load-bearing.
 *
 * SIZING (SVM-driven). `tout` must exceed the largest single step the rebase
 * cadence can produce, with margin. At 5% APY: ~1.4bps daily, ~9.6bps weekly.
 * Bounded by `MAX_FEE_BPS` (100 = 1%).
 *
 * WHERE THE FEE GOES. Nowhere — it is withheld, not forwarded. `tin` is
 * deposited without being credited; `tout` is owed without being paid out. Both
 * stay in the USDC buffer, so a fee raises the collateral ratio rather than
 * being extracted. There is no recipient and no sweep.
 *
 * QUEUED REDEMPTIONS ARE UNAFFECTED. Each entry snapshots the `tout` prevailing
 * when it was enqueued, so raising the fee cannot retroactively tax users
 * already waiting.
 *
 * Usage:
 *   TIN=0 TOUT=15 npx hardhat run scripts/operator/setFees.ts --network base --yes-mainnet
 *   TIN=0 TOUT=0  npx hardhat run scripts/operator/setFees.ts --network base
 *
 * Environment:
 *   TIN            Required. Mint fee in basis points.
 *   TOUT           Required. Redeem fee in basis points.
 *   DRY_RUN=true   Simulate without submitting
 *   --yes-mainnet  Required to broadcast on a mainnet network
 */

import { logger } from "../utils/logger";
import { DRY_RUN, requireArg, runScript, setup, submit } from "./_shared";

const MAX_FEE_BPS = 100n;

async function main() {
  const { contract: psm } = await setup("setFees", "LitePSM");

  const newTin = BigInt(requireArg("tin"));
  const newTout = BigInt(requireArg("tout"));

  const oldTin: bigint = await (psm as any).tin();
  const oldTout: bigint = await (psm as any).tout();

  logger.info(`tin:  ${oldTin}bps -> ${newTin}bps`);
  logger.info(`tout: ${oldTout}bps -> ${newTout}bps`);

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

  if (newTout < oldTout) {
    logger.warning(
      "Lowering tout. If this drops below the largest single multiplier step the " +
        "rebase cadence can produce, mint-hold-redeem across a step becomes " +
        "profitable again on any chain with a stepped multiplier."
    );
  }
  if (newTout > oldTout) {
    logger.info(
      "Raising tout. Entries already in the redemption queue keep their " +
        "snapshotted rate and are unaffected."
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit("setFees", () => (psm as any).setFees(newTin, newTout));

  const gotTin: bigint = await (psm as any).tin();
  const gotTout: bigint = await (psm as any).tout();
  if (gotTin !== newTin || gotTout !== newTout) {
    throw new Error(
      `POST-CONDITION FAILED: on-chain fees are tin=${gotTin} tout=${gotTout}, ` +
        `expected tin=${newTin} tout=${newTout}`
    );
  }
  logger.success(`Fees set: tin=${gotTin}bps tout=${gotTout}bps`);
}

runScript(main);
