/**
 * Enable or disable `wrap` on the USDOkuWrapper (`WRAPPER_ADMIN`, cold multisig).
 *
 * Calls `USDOkuWrapper.setWrapEnabled(bool)`. `--disable` is STEP 1 OF THE
 * USDOku SUNSET.
 *
 * WHY A SUNSET LEVER EXISTS AT ALL. USDOku is transitional. It exists to cover
 * the gap while ERC-8056 wallet support lands: a rebasing `balanceOf` displays
 * correctly in every wallet ever written, with zero integration work, which is
 * the one thing OkuM cannot do until wallets learn to apply a UI multiplier.
 * The cost is that a balance which moves with no Transfer event breaks AMM
 * pools, balance snapshots and most lending markets — so USDOku is never meant
 * to be the composable leg, and it is meant to be retired.
 *
 * WHY THERE IS NO `unwrap` LEVER. There is deliberately no code path that
 * disables unwrapping, and none will be added. Winding a wrapper down by making
 * redemption fail for whoever is last in line is a bank run with a published
 * starting gun. Disabling `wrap` stops new liability from forming while leaving
 * the exit open indefinitely; that asymmetry is the entire design.
 *
 * WHAT DISABLING DOES *NOT* DO:
 *   - It does not stop `M_usd` accruing. Outstanding USDOku balances keep
 *     growing at the declared rate, so the solvency gap keeps evolving. Halting
 *     accrual is a separate lever (haltAccrual.ts --target=usdOku), and the
 *     honest sunset order is: disable wrap, let the position run down, then stop
 *     declaring yield once the remaining float is immaterial.
 *   - It does not affect OkuM in any way. The share token, the subscription
 *     module and the redemption queue are untouched.
 *   - It is not a pause. `pause.ts --target=wrapper` blocks BOTH directions and
 *     is incident response; this is a one-way, indefinite policy change.
 *
 * PAUSE VS SUNSET, stated plainly because the two are easy to confuse on a
 * signing screen: pause is reversible, blocks the exit, and lives on
 * WRAPPER_PAUSER (warm). Sunset is reversible in principle but is announced
 * policy, leaves the exit open, and lives on WRAPPER_ADMIN (cold).
 *
 * Usage:
 *   npx hardhat run scripts/operator/wrapperSunset.ts --network base --disable --yes-mainnet
 *   npx hardhat run scripts/operator/wrapperSunset.ts --network base --enable
 *   DRY_RUN=true npx hardhat run scripts/operator/wrapperSunset.ts --network base --disable
 *
 * Flags:
 *   --disable       set wrapEnabled = false (sunset step 1)
 *   --enable        set wrapEnabled = true (re-open; expected only to undo a mistake)
 *   DRY_RUN=true    simulate
 *   --yes-mainnet   required to broadcast on a mainnet network
 */

import { ethers } from "hardhat";

import { logger } from "../utils/logger";
import { DRY_RUN, runScript, setup, submit } from "./_shared";

async function main() {
  const { contract: wrapper } = await setup("wrapperSunset", "USDOkuWrapper");

  const disable = process.argv.includes("--disable") || process.env.DISABLE === "true";
  const enable = process.argv.includes("--enable") || process.env.ENABLE === "true";
  if (disable === enable) {
    throw new Error("Provide exactly one of --disable or --enable");
  }
  const desired = enable;

  const current: boolean = await (wrapper as any).wrapEnabled();
  const paused: boolean = await (wrapper as any).paused();
  const liability: bigint = await (wrapper as any).declaredLiability();
  const backing: bigint = await (wrapper as any).realizedBacking();
  const gapBps: bigint = await (wrapper as any).solvencyGapBps();

  logger.info("");
  logger.info(`wrapEnabled:        ${current} -> ${desired}`);
  logger.info(`paused:             ${paused}`);
  logger.info(`declaredLiability:  $${ethers.formatEther(liability)}`);
  logger.info(`realizedBacking:    $${ethers.formatEther(backing)}`);
  logger.info(`solvencyGapBps:     ${gapBps}`);

  if (current === desired) {
    logger.warning(
      `wrapEnabled is already ${current} — this call is a no-op (the write is ` +
        `unconditional, so it does not revert).`
    );
  }

  if (!desired) {
    logger.warning(
      `Disabling wrap. New USDOku can no longer be minted (WrapDisabled); unwrap ` +
        `stays open and there is no lever to close it.`
    );
    if (liability > 0n) {
      logger.warning(
        `$${ethers.formatEther(liability)} of USDOku is still outstanding and will ` +
          `KEEP ACCRUING at the declared rate until someone stops it. Disabling wrap ` +
          `does not halt M_usd. Plan the rest of the sunset: let the float run down ` +
          `via unwrap, then halt accrual (haltAccrual.ts --target=usdOku) once the ` +
          `remainder is immaterial.`
      );
      if (backing < liability) {
        logger.warning(
          `Backing is BELOW liability right now (gap ${gapBps}bps). Everyone still ` +
            `holding USDOku is entitled to unwrap into OkuM at M_oku, and the buffer ` +
            `has to cover it — a wrapper that runs out reverts InsufficientBacking, ` +
            `which is precisely the "slow problem becomes a panic" scenario. Fund the ` +
            `buffer with OkuM before announcing the sunset, not after.`
        );
      }
    }
  } else {
    logger.warning(
      `Re-enabling wrap. If the sunset was announced publicly, reversing it is a ` +
        `communications event as much as a transaction.`
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  await submit(`setWrapEnabled(${desired})`, () => (wrapper as any).setWrapEnabled(desired));

  const confirmed: boolean = await (wrapper as any).wrapEnabled();
  if (confirmed !== desired) {
    throw new Error(`POST-CONDITION FAILED: wrapEnabled is ${confirmed}, expected ${desired}`);
  }
  logger.success(`wrapEnabled = ${confirmed}`);
  logger.info("Unwrap remains available regardless — verify with solvencyStatus.ts.");
}

runScript(main);
