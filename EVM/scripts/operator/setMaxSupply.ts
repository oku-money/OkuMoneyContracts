/**
 * Set the OkuM global supply cap (`OKU_CAP_MANAGER` role required).
 *
 * Calls `OkuM.setMaxSupply(newMaxSupply)`. The contract rejects values below
 * current totalSupply, and values above `MAX_TOTAL_SUPPLY` (1e33). Cap raises are the typical operation; cap
 * lowers are only safe when totalSupply has room.
 *
 * See ../../README.md § Authority model.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/setMaxSupply.ts --network base \
 *       --maxSupply 1000000000000000000000000000      # 1B OkuM (18-dec)
 *   DRY_RUN=true MAX_SUPPLY=1000000000000000000000000000 NETWORK=base \
 *       npx hardhat run scripts/operator/setMaxSupply.ts --network base
 *
 * Environment / flags:
 *   --maxSupply=<wei> | MAX_SUPPLY    18-decimal OkuM amount (required)
 *   DRY_RUN=true                      simulate without submitting
 *   --yes-mainnet                     bypass mainnet guard
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

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`setMaxSupply (${ctx.networkName})`);
  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const newMaxStr = parseArg("maxSupply") ?? parseArg("MAX_SUPPLY");
  if (!newMaxStr) throw new Error("Required: --maxSupply=<18-dec OkuM> or MAX_SUPPLY env var");
  const newMaxSupply = BigInt(newMaxStr);
  if (newMaxSupply <= 0n) throw new Error("--maxSupply must be > 0");

  const okuMAddr = loadAddress(ctx.bookKey, "OkuM");
  if (!okuMAddr) throw new Error(`Missing OkuM in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const okuM = (await getDeployedContract("OkuM", okuMAddr)).connect(signer) as Contract;

  const currentMax = await (okuM as any).maxSupply();
  const currentSupply = await (okuM as any).totalSupply();

  logger.info(`Signer (capManager): ${await signer.getAddress()}`);
  logger.info(`Current maxSupply:   ${ethers.formatEther(currentMax)} OkuM`);
  logger.info(`Current totalSupply: ${ethers.formatEther(currentSupply)} OkuM`);
  logger.info(`New maxSupply:       ${ethers.formatEther(newMaxSupply)} OkuM`);

  if (newMaxSupply < currentSupply) {
    throw new Error(
      `New maxSupply (${ethers.formatEther(newMaxSupply)}) < totalSupply (${ethers.formatEther(currentSupply)}) — would brick mint`
    );
  }

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (okuM as any).setMaxSupply(newMaxSupply);
  const receipt = await tx.wait(1);
  logger.success(`setMaxSupply tx: ${receipt.hash}`);

  const confirmed = await (okuM as any).maxSupply();
  logger.success(`Confirmed maxSupply: ${ethers.formatEther(confirmed)} OkuM`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
