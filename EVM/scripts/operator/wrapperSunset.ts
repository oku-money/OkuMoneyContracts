/**
 * Toggle `wrap` on USDOkuWrapper (`WRAPPER_ADMIN`, cold). Sunset step 1.
 *
 * Disabling `wrap` closes the entrance to USDOku while leaving `unwrap` open
 * INDEFINITELY — there is deliberately no way to disable the exit. Winding down
 * by trapping holders is a materially different act for a licensed issuer than
 * a noticed wind-down.
 *
 * The toggle is two-way, so a paused rollout can be resumed.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/wrapperSunset.ts --network base --enabled=false
 */

import { operatorContext, submit, requireArg, run, logger } from "./_shared";

run(async () => {
  const ctx = await operatorContext("wrapperSunset");
  const wrapper = await ctx.at("USDOkuWrapper");

  const raw = requireArg("enabled", "true|false").toLowerCase();
  if (!["true", "false"].includes(raw)) throw new Error("--enabled must be true or false");
  const enabled = raw === "true";

  logger.info(`wrap currently enabled: ${await (wrapper as any).wrapEnabled()}`);
  logger.info(`Setting wrapEnabled = ${enabled}`);
  if (!enabled) {
    logger.warning("Sunset step 1: new wraps close. unwrap stays open and cannot be disabled.");
  }

  await submit("setWrapEnabled", () => (wrapper as any).setWrapEnabled(enabled));
});
