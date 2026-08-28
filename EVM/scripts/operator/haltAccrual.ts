/**
 * Freeze accrual on OkuM and/or USDOku (`OKU_GUARDIAN`, warm).
 *
 * Monotone-safe: this stops growth, it never reduces anything already accrued.
 *
 * ONE-WAY from this key. Reversal requires `OKU_ACCRUAL_RESUMER` (cold), by
 * design — a compromised warm key can stop the protocol but never restart it.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/haltAccrual.ts --network base --target=both
 *
 * Flags:
 *   --target=okuM|usdOku|both   which index to freeze (default both)
 *   DRY_RUN=true                simulate without submitting
 */

import { operatorContext, submit, arg, run, logger } from "./_shared";

run(async () => {
  const ctx = await operatorContext("haltAccrual");
  const target = (arg("target") ?? "both").toLowerCase();
  if (!["okum", "usdoku", "both"].includes(target)) {
    throw new Error("--target must be one of: okuM, usdOku, both");
  }

  logger.warning("Reversal requires the cold OKU_ACCRUAL_RESUMER key. This is one-way from here.");

  if (target === "okum" || target === "both") {
    const okuM = await ctx.at("OkuM");
    if (await (okuM as any).accrualHalted()) {
      logger.info("OkuM accrual already halted — skipping");
    } else {
      await submit("OkuM.haltAccrual", () => (okuM as any).haltAccrual());
    }
  }

  if (target === "usdoku" || target === "both") {
    const usdOku = await ctx.at("USDOku");
    if (await (usdOku as any).accrualHalted()) {
      logger.info("USDOku accrual already halted — skipping");
    } else {
      await submit("USDOku.haltUsdOkuAccrual", () => (usdOku as any).haltUsdOkuAccrual());
    }
  }
});
