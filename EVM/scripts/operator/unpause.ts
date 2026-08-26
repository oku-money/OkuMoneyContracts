/**
 * Unpause one of the OkuMoney protocol contracts.
 *
 * Single script with --target. Every unpause role is COLD-multisig only, which
 * is the deliberate asymmetry: a warm key can stop the system but cannot
 * restart it.
 *
 *   token   -> OkuM.unpause()             [OKU_UNPAUSER]
 *   usdOku  -> USDOku.unpause()           [OKU_UNPAUSER]
 *   module  -> SubscriptionModule.unpause() [PSM_UNPAUSER]
 *   wrapper -> USDOkuWrapper.unpause()    [WRAPPER_UNPAUSER]
 *
 * `psm` is accepted as an alias for `module` so existing runbooks keep working.
 *
 * ORDER MATTERS ON THE WAY BACK UP. Unpausing the module or the wrapper while
 * OkuM is still paused produces confusing partial failures: the module's `mint`
 * calls `OkuM.mint`, which is `whenNotPaused` on the token, so subscription
 * reverts with the TOKEN's pause error from a module that reports itself
 * unpaused. Unpause OkuM first, then the surfaces above it. This script warns
 * when it detects that ordering hazard rather than enforcing it — the correct
 * order can legitimately differ during an incident.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/unpause.ts --network base --target=module
 *
 * Environment:
 *   TARGET         token|usdOku|module|wrapper (psm == module)
 *   DRY_RUN=true
 *   --yes-mainnet
 */

import { resolveNetworkContext } from "../utils/networkContext";
import { hasAddress, loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { resolveOperatorSigner } from "./_shared";

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : process.env[name.toUpperCase().replace(/-/g, "_")];
}

const YES_MAINNET = process.argv.includes("--yes-mainnet");
const DRY_RUN = process.env.DRY_RUN === "true";

interface UnpauseTarget {
  /** Hardhat contract name; doubles as the address-book key. */
  name: string;
  /** Role that gates unpause() on this contract. Cold, in every case. */
  role: string;
  /** True when this target's operations bottom out in OkuM's pause check. */
  dependsOnOkuM: boolean;
}

/** Duplicated from pause.ts on purpose — see the note there. */
const UNPAUSE_TARGETS: Record<string, UnpauseTarget> = {
  token: { name: "OkuM", role: "OKU_UNPAUSER", dependsOnOkuM: false },
  usdOku: { name: "USDOku", role: "OKU_UNPAUSER", dependsOnOkuM: false },
  module: { name: "SubscriptionModule", role: "PSM_UNPAUSER", dependsOnOkuM: true },
  psm: { name: "SubscriptionModule", role: "PSM_UNPAUSER", dependsOnOkuM: true },
  wrapper: { name: "USDOkuWrapper", role: "WRAPPER_UNPAUSER", dependsOnOkuM: true },
};

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`unpause (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const target = parseArg("target") ?? parseArg("TARGET");
  if (!target || !(target in UNPAUSE_TARGETS)) {
    throw new Error(
      `Required: --target=${Object.keys(UNPAUSE_TARGETS).join("|")} (got ${target ?? "<none>"})`
    );
  }
  const sel = UNPAUSE_TARGETS[target];

  const addr = loadAddress(ctx.bookKey, sel.name);
  if (!addr) throw new Error(`Missing ${sel.name} in address book for ${ctx.bookKey}`);

  // Signer resolution goes through the shared helper rather than
  // `getSigners()[0]`: on a fork the mnemonic accounts hold no roles, so every
  // privileged call here would revert AccessControlUnauthorizedAccount against
  // a correctly-wired deployment. On a live network the helper returns the same
  // PRIVATE_KEY signer, so behaviour there is unchanged.
  const signer = await resolveOperatorSigner(ctx.isFork);
  const c = (await getDeployedContract(sel.name, addr)).connect(signer);

  const pausedBefore: boolean = await (c as any).paused();
  logger.info(`Target: ${target} (${sel.name} @ ${addr})`);
  logger.info(`Role:   ${sel.role} (cold)`);
  logger.info(`Signer: ${await signer.getAddress()}`);
  logger.info(`paused() before: ${pausedBefore}`);

  if (!pausedBefore) {
    logger.warning(`${sel.name} is not paused; no-op`);
    return;
  }

  // Ordering hazard: unpausing a surface whose writes bottom out in OkuM's
  // pause check leaves it reporting itself live while every user-facing call
  // still reverts on the token.
  if (sel.dependsOnOkuM && hasAddress(ctx.bookKey, "OkuM")) {
    const okuM = await getDeployedContract("OkuM", loadAddress(ctx.bookKey, "OkuM"));
    if (await (okuM as any).paused()) {
      logger.warning(
        `OkuM is STILL PAUSED. Unpausing ${sel.name} now will make it report itself ` +
          `live while mint (and, for the wrapper, wrap) still revert on the token's ` +
          `own pause check — a confusing state to hand to users or to a status page. ` +
          `Unpause OkuM first unless you specifically want the surface open for the ` +
          `paths that do not touch the token.`
      );
    }
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
