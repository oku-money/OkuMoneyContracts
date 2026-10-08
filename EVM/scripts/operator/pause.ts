/**
 * Pause one of the OkuMoney protocol contracts.
 *
 * Single script with TARGET={psm|okuM|usdOku}. Each target's pause()
 * is gated by a distinct role:
 *   psm    -> LitePSM.pause()    [PSM_PAUSER]
 *   okuM   -> OkuMoney.pause()   [OKUM_PAUSER]
 *   usdOku -> OkuDollar.pause()  [VAULT_PAUSER]
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base TARGET=psm    npx hardhat run scripts/operator/pause.ts --network base
 *   NETWORK=base TARGET=okuM   npx hardhat run scripts/operator/pause.ts --network base
 *   NETWORK=base TARGET=usdOku npx hardhat run scripts/operator/pause.ts --network base
 *
 * Environment:
 *   TARGET            psm|okuM|usdOku (required)
 *   DRY_RUN=true      Simulate without submitting
 *   YES_MAINNET=true  Required to broadcast on a mainnet network
 *
 * Also exported as `runPause()` for in-process callers (e.g. the operator
 * drill, `test/hardhat/drill/operatorDrill.test.ts`).
 */

import { ethers } from "hardhat";
import { Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract, waitMined } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";

export type PauseTarget = "psm" | "okuM" | "usdOku";

export const TARGET_MAP: Record<PauseTarget, { name: "LitePSM" | "OkuMoney" | "OkuDollar"; bookKey: string }> = {
  psm: { name: "LitePSM", bookKey: "LitePSM" },
  okuM: { name: "OkuMoney", bookKey: "OkuMoney" },
  usdOku: { name: "OkuDollar", bookKey: "OkuDollar" },
};

export interface PauseResult {
  pausedBefore: boolean;
  pausedAfter: boolean;
  txHash?: string;
}

/** Pause one contract (OkuMoney, OkuDollar or LitePSM); no-op if already paused. */
export async function runPause(
  ctx: NetworkContext,
  signer: Signer,
  target: PauseTarget,
  dryRun = false
): Promise<PauseResult> {
  const sel = TARGET_MAP[target];
  const addr = loadAddress(ctx.bookKey, sel.bookKey);
  if (!addr) throw new Error(`Missing ${sel.bookKey} in address book for ${ctx.bookKey}`);

  const c = (await getDeployedContract(sel.name, addr)).connect(signer);
  const pausedBefore: boolean = await c.paused();
  logger.info(`Target: ${target} (${sel.name} @ ${addr})`);
  logger.info(`Signer: ${await signer.getAddress()}`);
  logger.info(`paused() before: ${pausedBefore}`);

  if (pausedBefore) {
    logger.warning(`${sel.name} is already paused; no-op`);
    return { pausedBefore, pausedAfter: pausedBefore };
  }
  if (dryRun) {
    logger.success("DRY_RUN=true — not submitting");
    return { pausedBefore, pausedAfter: pausedBefore };
  }

  const tx = await c.pause();
  const receipt = await waitMined(tx);
  logger.success(`pause tx: ${receipt.hash}`);

  const pausedAfter: boolean = await c.paused();
  logger.success(`paused() after: ${pausedAfter}`);
  return { pausedBefore, pausedAfter, txHash: receipt.hash };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`pause (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const target = parseArg("target") as PauseTarget | undefined;
    if (!target || !(target in TARGET_MAP)) {
      throw new Error(`Required: --target=psm|okuM|usdOku (got ${target ?? "<none>"})`);
    }

    const [signer] = await ethers.getSigners();
    await runPause(ctx, signer, target, isDryRun());
  });
}
