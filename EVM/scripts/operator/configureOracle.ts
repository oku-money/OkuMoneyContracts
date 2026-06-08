/**
 * Configure the LitePSM Proof-of-Reserves oracle.
 *
 * Calls `LitePSM.configureOracle(oracle, stalenessThreshold, enabled)`,
 * the PSM_ORACLE_MANAGER-gated setter that controls whether mints check
 * an on-chain reserves attestation.
 *
 * Usage:
 *   # Disable the oracle (skip reserve checks; the v1 model)
 *   NETWORK=base npx hardhat run scripts/operator/configureOracle.ts --network base \
 *       --oracle 0x0000000000000000000000000000000000000000 \
 *       --staleness 3600 --enabled false
 *
 *   # Enable a Chainlink-style PoR feed
 *   NETWORK=base npx hardhat run scripts/operator/configureOracle.ts --network base \
 *       --oracle 0x<feedAddr> --staleness 3600 --enabled true
 *
 *   DRY_RUN=true NETWORK=base npx hardhat run scripts/operator/configureOracle.ts \
 *       --network base --oracle 0x... --staleness 3600 --enabled true
 *
 * Environment:
 *   ORACLE         IAggregatorV3 oracle address (alternative to --oracle)
 *   STALENESS      Staleness threshold seconds (alternative to --staleness)
 *   ENABLED        "true" or "false" (alternative to --enabled)
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

async function main() {
  const ctx = await resolveNetworkContext();
  logger.header(`configureOracle (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const oracleStr = parseArg("oracle") ?? parseArg("ORACLE");
  const stalenessStr = parseArg("staleness") ?? parseArg("STALENESS");
  const enabledStr = parseArg("enabled") ?? parseArg("ENABLED");
  if (!oracleStr) throw new Error("Required: --oracle=0x...");
  if (!stalenessStr) throw new Error("Required: --staleness=<seconds>");
  if (enabledStr === undefined) throw new Error("Required: --enabled=true|false");

  if (!ethers.isAddress(oracleStr)) throw new Error(`Invalid --oracle: ${oracleStr}`);
  const staleness = BigInt(stalenessStr);
  if (staleness <= 0n) throw new Error("--staleness must be > 0");
  const enabled = enabledStr === "true";

  const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
  if (!psmAddr) throw new Error(`Missing LitePSM in address book for ${ctx.bookKey}`);

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();

  const psm = (await getDeployedContract("LitePSM", psmAddr)).connect(signer);

  logger.info(`Signer: ${signerAddr}`);
  logger.info(`Oracle: ${oracleStr}`);
  logger.info(`Staleness threshold: ${staleness}s`);
  logger.info(`Enabled: ${enabled}`);

  if (DRY_RUN) {
    logger.success("DRY_RUN=true — not submitting");
    return;
  }

  const tx = await (psm as any).configureOracle(oracleStr, staleness, enabled);
  const receipt = await tx.wait(1);
  logger.success(`configureOracle tx: ${receipt.hash}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
