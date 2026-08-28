/**
 * Reverse an accrual halt (`OKU_ACCRUAL_RESUMER`, COLD).
 *
 * Deliberately a different role from `OKU_GUARDIAN`, mirroring the
 * pauser/unpauser and blacklister/unblacklister splits: warm keys stop things,
 * cold keys start them again.
 *
 * Note for USDOku: resuming only clears the latch. The index stays frozen until
 * a new rate is declared, and that rate must be pre-funded like any other.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/resumeAccrual.ts --network base --target=both
 */

import { operatorContext, submit, arg, run, logger } from "./_shared";

run(async () => {
  const ctx = await operatorContext("resumeAccrual");
  const target = (arg("target") ?? "both").toLowerCase();
  if (!["okum", "usdoku", "both"].includes(target)) {
    throw new Error("--target must be one of: okuM, usdOku, both");
  }

  if (target === "okum" || target === "both") {
    const okuM = await ctx.at("OkuM");
    await submit("OkuM.resumeAccrual", () => (okuM as any).resumeAccrual());
  }

  if (target === "usdoku" || target === "both") {
    const usdOku = await ctx.at("USDOku");
    await submit("USDOku.resumeUsdOkuAccrual", () => (usdOku as any).resumeUsdOkuAccrual());
    logger.info("USDOku: M_usd stays frozen until a new (pre-funded) rate is declared.");
  }
});
