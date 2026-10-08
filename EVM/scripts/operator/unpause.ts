/**
 * Unpause one of the OkuMoney protocol contracts.
 *
 * Single script with TARGET={psm|okuM|usdOku}. Each target's unpause()
 * is gated by a distinct role:
 *   psm    -> LitePSM.unpause()    [PSM_UNPAUSER]
 *   okuM   -> OkuMoney.unpause()   [OKUM_UNPAUSER]
 *   usdOku -> OkuDollar.unpause()  [VAULT_UNPAUSER]
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base TARGET=psm npx hardhat run scripts/operator/unpause.ts --network base
 *
 * Environment:
 *   TARGET            psm|okuM|usdOku
 *   DRY_RUN=true
 *   YES_MAINNET=true
 *
 * Also exported as `runUnpause()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract, waitMined } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";
import { TARGET_MAP, PauseTarget } from "./pause";

export interface UnpauseResult {
  pausedBefore: boolean;
  pausedAfter: boolean;
  txHash?: string;
}

/** Unpause one contract; no-op if not paused. */
export async function runUnpause(
  ctx: NetworkContext,
  signer: Signer,
  target: PauseTarget,
  dryRun = false
): Promise<UnpauseResult> {
  const sel = TARGET_MAP[target];
  const addr = loadAddress(ctx.bookKey, sel.bookKey);
  if (!addr) throw new Error(`Missing ${sel.bookKey} in address book for ${ctx.bookKey}`);

  const c = (await getDeployedContract(sel.name, addr)).connect(signer);
  const pausedBefore: boolean = await c.paused();
  logger.info(`Target: ${target} (${sel.name} @ ${addr})`);
  logger.info(`Signer: ${await signer.getAddress()}`);
  logger.info(`paused() before: ${pausedBefore}`);

  if (!pausedBefore) {
    logger.warning(`${sel.name} is not paused; no-op`);
    return { pausedBefore, pausedAfter: pausedBefore };
  }
  if (dryRun) {
    logger.success("DRY_RUN=true — not submitting");
    return { pausedBefore, pausedAfter: pausedBefore };
  }

  const tx = await c.unpause();
  const receipt = await waitMined(tx);
  logger.success(`unpause tx: ${receipt.hash}`);

  const pausedAfter: boolean = await c.paused();
  logger.success(`paused() after: ${pausedAfter}`);
  return { pausedBefore, pausedAfter, txHash: receipt.hash };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`unpause (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const target = parseArg("target") as PauseTarget | undefined;
    if (!target || !(target in TARGET_MAP)) {
      throw new Error(`Required: --target=psm|okuM|usdOku (got ${target ?? "<none>"})`);
    }

    const [signer] = await ethers.getSigners();
    await runUnpause(ctx, signer, target, isDryRun());
  });
}
