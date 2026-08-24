/**
 * Unpause one of the OkuDollar protocol contracts.
 *
 * Single script with --target={token|psm}. Each target's unpause() is gated by a
 * distinct role, both cold-multisig only:
 *   token -> OkuDollar.unpause()  [OKU_UNPAUSER]
 *   psm   -> LitePSM.unpause()    [PSM_UNPAUSER]
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/unpause.ts --network base --target=psm
 *
 * Environment:
 *   TARGET         token|psm
 *   DRY_RUN=true
 *   --yes-mainnet
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

const TARGET_MAP: Record<string, { name: "LitePSM" | "OkuDollar"; bookKey: string }> = {
  token: { name: "OkuDollar", bookKey: "OkuDollar" },
  psm: { name: "LitePSM", bookKey: "LitePSM" },
};

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`unpause (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const target = parseArg("target") ?? parseArg("TARGET");
  if (!target || !(target in TARGET_MAP)) {
    throw new Error(
      `Required: --target=${Object.keys(TARGET_MAP).join("|")} (got ${target ?? "<none>"})`
    );
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

  if (!pausedBefore) {
    logger.warning(`${sel.name} is not paused; no-op`);
    return;
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (c as any).unpause();
  const receipt = await tx.wait(1);
  logger.success(`unpause tx: ${receipt.hash}`);

  const pausedAfter: boolean = await (c as any).paused();
  logger.success(`paused() after: ${pausedAfter}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
