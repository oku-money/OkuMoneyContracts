/**
 * Set the OkuDollar minimum collateral ratio (`VAULT_ADMIN` role).
 *
 * Calls `OkuDollar.setMinCollateralRatio(newRatio)`. The contract rejects
 * lowering the floor below current collateralization (computed at call time),
 * so raising the floor above current state will revert with
 * `BelowMinimumCollateral`.
 *
 * 1e18 = 100%. E.g. 1.05e18 means "require 105% OkuM-backed collateral".
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setMinCollateralRatio.ts --network base \
 *       --ratio 1050000000000000000     # 105%
 *   DRY_RUN=true RATIO=1050000000000000000 NETWORK=base \
 *       npx hardhat run scripts/operator/setMinCollateralRatio.ts --network base
 *
 * Environment / flags:
 *   --ratio=<1e18-scaled> | RATIO    required
 *   DRY_RUN=true                     simulate without submitting
 *   --yes-mainnet                    bypass mainnet guard
 */

import { ethers } from "hardhat";
import { Contract } from "ethers";
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

const PRECISION = 10n ** 18n;

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`setMinCollateralRatio (${ctx.networkName})`);
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const ratioStr = parseArg("ratio") ?? parseArg("RATIO");
  if (!ratioStr) throw new Error("Required: --ratio=<1e18-scaled> or RATIO env var (1e18 = 100%)");
  const newRatio = BigInt(ratioStr);
  if (newRatio < PRECISION) {
    throw new Error(`--ratio (${newRatio}) < PRECISION (${PRECISION}); contract rejects under-collateralized floor`);
  }

  const okuDollarAddr = loadAddress(ctx.bookKey, "OkuDollar");
  if (!okuDollarAddr) throw new Error(`Missing OkuDollar in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const okuDollar = (await getDeployedContract("OkuDollar", okuDollarAddr)).connect(signer) as Contract;

  const currentRatio = await (okuDollar as any).minCollateralRatio();
  const liveRatio = await (okuDollar as any).collateralizationRatio();

  const fmtPct = (r: bigint) => `${(Number(r) / Number(PRECISION) * 100).toFixed(4)}%`;
  logger.info(`Signer (vaultAdmin):      ${await signer.getAddress()}`);
  logger.info(`Current minCollatRatio:   ${fmtPct(currentRatio)} (${currentRatio})`);
  logger.info(`Live collateralization:   ${fmtPct(liveRatio)} (${liveRatio})`);
  logger.info(`Proposed minCollatRatio:  ${fmtPct(newRatio)} (${newRatio})`);

  if (newRatio > liveRatio) {
    logger.warning(
      `Proposed floor (${fmtPct(newRatio)}) > live collateralization (${fmtPct(liveRatio)}); tx will revert with BelowMinimumCollateral`
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (okuDollar as any).setMinCollateralRatio(newRatio);
  const receipt = await tx.wait(1);
  logger.success(`setMinCollateralRatio tx: ${receipt.hash}`);

  const confirmed = await (okuDollar as any).minCollateralRatio();
  logger.success(`Confirmed minCollateralRatio: ${fmtPct(confirmed)} (${confirmed})`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
