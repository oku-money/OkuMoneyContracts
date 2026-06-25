/**
 * Pause one of the OkuMoney protocol contracts.
 *
 * Single script with --target={psm|okuM|usdOku}. Each target's pause()
 * is gated by a distinct role:
 *   psm    -> LitePSM.pause()    [PSM_PAUSER]
 *   okuM   -> OkuMoney.pause()   [OKUM_PAUSER]
 *   usdOku -> OkuDollar.pause()  [VAULT_PAUSER]
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/pause.ts --network base --target=psm
 *   NETWORK=base npx hardhat run scripts/operator/pause.ts --network base --target=okuM
 *   NETWORK=base npx hardhat run scripts/operator/pause.ts --network base --target=usdOku
 *
 * Environment:
 *   TARGET         psm|okuM|usdOku (alternative to --target)
 *   DRY_RUN=true   Simulate without submitting
 *   --yes-mainnet  Required to broadcast on a mainnet network
 */

import { ethers } from "hardhat";
import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : process.env[name.toUpperCase().replace(/-/g, "_")];
}

const YES_MAINNET = process.argv.includes("--yes-mainnet");
const DRY_RUN = process.env.DRY_RUN === "true";

const TARGET_MAP: Record<string, { name: "LitePSM" | "OkuMoney" | "OkuDollar"; bookKey: string }> = {
  psm: { name: "LitePSM", bookKey: "LitePSM" },
  okuM: { name: "OkuMoney", bookKey: "OkuMoney" },
  usdOku: { name: "OkuDollar", bookKey: "OkuDollar" },
};

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`pause (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const target = parseArg("target") ?? parseArg("TARGET");
  if (!target || !(target in TARGET_MAP)) {
    throw new Error(`Required: --target=psm|okuM|usdOku (got ${target ?? "<none>"})`);
  }
  const sel = TARGET_MAP[target];

  const addr = loadAddress(ctx.bookKey, sel.bookKey);
  if (!addr) throw new Error(`Missing ${sel.bookKey} in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const c = (await getDeployedContract(sel.name, addr)).connect(signer);

  const pausedBefore: boolean = await (c as any).paused();
  logger.info(`Target: ${target} (${sel.name} @ ${addr})`);
  logger.info(`Signer: ${await signer.getAddress()}`);
  logger.info(`paused() before: ${pausedBefore}`);

  if (pausedBefore) {
    logger.warning(`${sel.name} is already paused; no-op`);
    return;
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (c as any).pause();
  const receipt = await tx.wait(1);
  logger.success(`pause tx: ${receipt.hash}`);

  const pausedAfter: boolean = await (c as any).paused();
  logger.success(`paused() after: ${pausedAfter}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
