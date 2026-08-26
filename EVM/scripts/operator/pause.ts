/**
 * Pause one of the OkuMoney protocol contracts.
 *
 * Single script with --target. Each target's `pause()` is gated by a distinct
 * role, and each blocks a genuinely different surface:
 *
 *   token   -> OkuM.pause()           [OKU_PAUSER]     blocks peer-to-peer
 *              transfers and minting. BURN STAYS OPEN, so a holder can still
 *              exit and the pause-then-blacklist protocol works.
 *   usdOku  -> USDOku.pause()         [OKU_PAUSER]     blocks share transfers
 *              and minting, and therefore transitively blocks `unwrap` (which
 *              needs a `transferFrom` into the wrapper). Read that twice: it
 *              closes the exit from the dollar leg.
 *   module  -> SubscriptionModule.pause() [PSM_PAUSER] blocks mint/redeem.
 *              processQueue, depositBuffer and withdrawUsdc stay open — pause
 *              must not lock users into the redemption queue.
 *   wrapper -> USDOkuWrapper.pause()  [WRAPPER_PAUSER] blocks BOTH wrap and
 *              unwrap.
 *
 * `psm` is accepted as an alias for `module` so existing runbooks keep working.
 *
 * PAUSE IS NOT THE MULTIPLIER-STEP LEVER. It is unbounded incident response.
 * The routine fence around a step is the post-step sync window, which arms
 * itself on every `setOkuMultiplier` write, is bounded by MAX_SYNC_WINDOW
 * (15 minutes) and expires unaided. v0.3's `beginSyncWindow.ts` /
 * `endSyncWindow.ts` no longer exist — there is nothing to open or close.
 *
 * PAUSE IS NOT THE USDOku SUNSET LEVER EITHER. Sunset is
 * `wrapperSunset.ts --disable`, which stops new wrapping and leaves the exit
 * open indefinitely. Pausing the wrapper closes the exit, which is the opposite
 * property, and is only correct while an incident is genuinely live.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/pause.ts --network base --target=module
 *   NETWORK=base npx hardhat run scripts/operator/pause.ts --network base --target=token
 *
 * Environment:
 *   TARGET         token|usdOku|module|wrapper (psm == module)
 *   DRY_RUN=true   Simulate without submitting
 *   --yes-mainnet  Required to broadcast on a mainnet network
 */

import { resolveNetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
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

interface PauseTarget {
  /** Hardhat contract name; doubles as the address-book key. */
  name: string;
  /** Role that gates pause()/unpause() on this contract. */
  role: string;
  /** What an operator is actually switching off. */
  effect: string;
}

/**
 * Deliberately duplicated in unpause.ts rather than exported: this module calls
 * `main()` at import time, so importing it from a sibling script would execute a
 * pause. (And these two are the scripts most likely to be read in a hurry under
 * incident conditions — the `effect` strings are the part worth reading, so
 * having them present in the file you opened is worth the duplication.)
 */
const PAUSE_TARGETS: Record<string, PauseTarget> = {
  token: {
    name: "OkuM",
    role: "OKU_PAUSER / OKU_UNPAUSER",
    effect: "transfers + mint (burn and redemption stay OPEN)",
  },
  usdOku: {
    name: "USDOku",
    role: "OKU_PAUSER / OKU_UNPAUSER",
    effect: "share transfers + mint, and transitively unwrap (CLOSES the exit)",
  },
  module: {
    name: "SubscriptionModule",
    role: "PSM_PAUSER / PSM_UNPAUSER",
    effect: "mint + redeem (processQueue and buffer ops stay OPEN)",
  },
  psm: {
    name: "SubscriptionModule",
    role: "PSM_PAUSER / PSM_UNPAUSER",
    effect: "mint + redeem (alias of --target=module)",
  },
  wrapper: {
    name: "USDOkuWrapper",
    role: "WRAPPER_PAUSER / WRAPPER_UNPAUSER",
    effect: "wrap AND unwrap (CLOSES the exit; not a sunset)",
  },
};

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`pause (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const target = parseArg("target") ?? parseArg("TARGET");
  if (!target || !(target in PAUSE_TARGETS)) {
    throw new Error(
      `Required: --target=${Object.keys(PAUSE_TARGETS).join("|")} (got ${target ?? "<none>"})`
    );
  }
  const sel = PAUSE_TARGETS[target];

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
  logger.info(`Target:  ${target} (${sel.name} @ ${addr})`);
  logger.info(`Role:    ${sel.role}`);
  logger.info(`Blocks:  ${sel.effect}`);
  logger.info(`Signer:  ${await signer.getAddress()}`);
  logger.info(`paused() before: ${pausedBefore}`);

  if (pausedBefore) {
    logger.warning(`${sel.name} is already paused; no-op`);
    return;
  }

  if (target === "usdOku" || target === "wrapper") {
    logger.warning(
      "This target CLOSES A USER EXIT. Refusing to let people out of a wrapper " +
        "because the wrapper is under-funded is how a slow problem becomes a panic — " +
        "hold it only as long as the incident genuinely requires, and prefer " +
        "wrapperSunset.ts if the intent is to wind USDOku down rather than to stop " +
        "an attack in progress."
    );
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
  logger.info(
    `Unpause is a DIFFERENT role (${sel.role.split(" / ")[1]}), on cold. Coordinate ` +
      `it before pausing if the recovery path matters.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
