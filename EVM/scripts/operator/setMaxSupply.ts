/**
 * Set the OkuMoney global supply cap (`OKUM_CAP_MANAGER` role required).
 *
 * Calls `OkuMoney.setMaxSupply(newMaxSupply)`. The contract rejects values
 * below current totalSupply. Cap raises are the typical operation; cap
 * lowers are only safe when totalSupply has room.
 *
 * Usage (env vars — NOT `--flags`; see scripts/utils/cli.ts for why
 * `hardhat run` rejects custom flags with HH305/HH310):
 *   NETWORK=base MAX_SUPPLY=1000000000000000000000000000 \
 *       npx hardhat run scripts/operator/setMaxSupply.ts --network base   # 1B OkuM (18-dec)
 *
 * Environment:
 *   MAX_SUPPLY=<wei>                  18-decimal OkuM amount (required)
 *   DRY_RUN=true                      simulate without submitting
 *   YES_MAINNET=true                  bypass mainnet guard
 *
 * Also exported as `runSetMaxSupply()` for in-process callers (e.g. the drill).
 */

import { ethers } from "hardhat";
import { Signer } from "ethers";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract, waitMined } from "../utils/deploy";
import { logger } from "../utils/logger";
import { mainnetGuard } from "../utils/mainnetGuard";
import { parseArg, isYesMainnet, isDryRun, runMain } from "../utils/cli";

export interface SetMaxSupplyResult {
  previousMax: bigint;
  newMax: bigint;
  txHash?: string;
}

/** Change OkuMoney's supply cap (must stay >= current supply). */
export async function runSetMaxSupply(
  ctx: NetworkContext,
  signer: Signer,
  newMaxSupply: bigint,
  dryRun = false
): Promise<SetMaxSupplyResult> {
  if (newMaxSupply <= 0n) throw new Error("newMaxSupply must be > 0");

  const okuMoneyAddr = loadAddress(ctx.bookKey, "OkuMoney");
  if (!okuMoneyAddr) throw new Error(`Missing OkuMoney in address book for ${ctx.bookKey}`);

  const okuMoney = (await getDeployedContract("OkuMoney", okuMoneyAddr)).connect(signer);

  const currentMax = await okuMoney.maxSupply();
  const currentSupply = await okuMoney.totalSupply();

  logger.info(`Signer (capManager): ${await signer.getAddress()}`);
  logger.info(`Current maxSupply:   ${ethers.formatEther(currentMax)} OkuM`);
  logger.info(`Current totalSupply: ${ethers.formatEther(currentSupply)} OkuM`);
  logger.info(`New maxSupply:       ${ethers.formatEther(newMaxSupply)} OkuM`);

  if (newMaxSupply < currentSupply) {
    throw new Error(
      `New maxSupply (${ethers.formatEther(newMaxSupply)}) < totalSupply (${ethers.formatEther(currentSupply)}) — would brick mint`
    );
  }
  if (dryRun) {
    logger.success("DRY_RUN=true — not submitting");
    return { previousMax: currentMax, newMax: currentMax };
  }

  const tx = await okuMoney.setMaxSupply(newMaxSupply);
  const receipt = await waitMined(tx);
  logger.success(`setMaxSupply tx: ${receipt.hash}`);

  const confirmed = await okuMoney.maxSupply();
  logger.success(`Confirmed maxSupply: ${ethers.formatEther(confirmed)} OkuM`);
  return { previousMax: currentMax, newMax: confirmed, txHash: receipt.hash };
}

if (require.main === module) {
  runMain(async () => {
    const ctx = await resolveNetworkContext();
    logger.header(`setMaxSupply (${ctx.networkName})`);
    mainnetGuard(ctx.networkName, { yesMainnet: isYesMainnet(), dryRun: isDryRun() });

    const newMaxStr = parseArg("maxSupply");
    if (!newMaxStr) throw new Error("Required: --maxSupply=<18-dec OkuM>");

    const [signer] = await ethers.getSigners();
    await runSetMaxSupply(ctx, signer, BigInt(newMaxStr), isDryRun());
  });
}
