/**
 * Configure the OracleRelay (USDC peg circuit-breaker) and wire it to LitePSM
 * and RedemptionQueue.
 *
 * Subcommands (selected via --action=<name>):
 *
 *   set-feed       OracleRelay.setPriceFeed(newFeed)
 *                  Requires --feed=0x<chainlink-usdc-usd-aggregator>.
 *                  RELAY_FEED_MANAGER-gated.
 *
 *   set-staleness  OracleRelay.setStalenessThreshold(seconds)
 *                  Requires --staleness=<seconds> (bounded by ORACLE_MIN/MAX_STALENESS).
 *                  RELAY_CONFIG_MANAGER-gated.
 *
 *   set-band       OracleRelay.setPriceBand(minE18, maxE18)
 *                  Requires --min=<1e18-scaled> and --max=<1e18-scaled>
 *                  (bounded by ORACLE_USDC_PRICE_FLOOR / ORACLE_USDC_PRICE_CEILING).
 *                  RELAY_CONFIG_MANAGER-gated.
 *
 *   wire           LitePSM.setOracleRelay(newRelay) and
 *                  RedemptionQueue.setOracleRelay(newRelay).
 *                  Pass --relay=0x... to wire a specific address (defaults to the
 *                  OracleRelay address from the address book).
 *                  Pass --relay=0x0000...0000 to DISABLE the peg check on both
 *                  consumers (kill-switch).
 *                  PSM_ORACLE_MANAGER + QUEUE_ORACLE_MANAGER gated.
 *
 * Usage:
 *   NETWORK=base npx hardhat run scripts/operator/configureRelay.ts --network base \
 *       --action=set-feed --feed=0x<chainlinkUsdcUsd> --yes-mainnet
 *
 *   NETWORK=base npx hardhat run scripts/operator/configureRelay.ts --network base \
 *       --action=wire --relay=0x0000000000000000000000000000000000000000 \
 *       --yes-mainnet
 *
 *   DRY_RUN=true NETWORK=base npx hardhat run scripts/operator/configureRelay.ts \
 *       --network base --action=set-staleness --staleness=3600
 *
 * Environment:
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
  const action = parseArg("action") ?? "wire";
  logger.header(`configureRelay [${action}] (${ctx.networkName})`);

  mainnetGuard(ctx.networkName, { yesMainnet: YES_MAINNET, dryRun: DRY_RUN });

  const [signer] = await ethers.getSigners();
  const signerAddr = await signer.getAddress();
  logger.info(`Signer: ${signerAddr}`);

  if (action === "set-feed") {
    const feed = parseArg("feed");
    if (!feed || !ethers.isAddress(feed)) {
      throw new Error("Required: --feed=0x<chainlink-aggregator>");
    }
    const relayAddr = loadAddress(ctx.bookKey, "OracleRelay");
    if (!relayAddr) throw new Error(`Missing OracleRelay in address book for ${ctx.bookKey}`);
    const relay = (await getDeployedContract("OracleRelay", relayAddr)).connect(signer);

    logger.info(`Relay: ${relayAddr}`);
    logger.info(`New feed: ${feed}`);
    if (DRY_RUN) {
      logger.success("DRY_RUN=true — not submitting");
      return;
    }
    const tx = await (relay as any).setPriceFeed(feed);
    const receipt = await tx.wait(1);
    logger.success(`setPriceFeed tx: ${receipt.hash}`);
    return;
  }

  if (action === "set-staleness") {
    const stalenessStr = parseArg("staleness");
    if (!stalenessStr) throw new Error("Required: --staleness=<seconds>");
    const staleness = BigInt(stalenessStr);
    if (staleness <= 0n) throw new Error("--staleness must be > 0");

    const relayAddr = loadAddress(ctx.bookKey, "OracleRelay");
    if (!relayAddr) throw new Error(`Missing OracleRelay in address book for ${ctx.bookKey}`);
    const relay = (await getDeployedContract("OracleRelay", relayAddr)).connect(signer);

    logger.info(`Relay: ${relayAddr}`);
    logger.info(`New staleness threshold: ${staleness}s`);
    if (DRY_RUN) {
      logger.success("DRY_RUN=true — not submitting");
      return;
    }
    const tx = await (relay as any).setStalenessThreshold(staleness);
    const receipt = await tx.wait(1);
    logger.success(`setStalenessThreshold tx: ${receipt.hash}`);
    return;
  }

  if (action === "set-band") {
    const minStr = parseArg("min");
    const maxStr = parseArg("max");
    if (!minStr) throw new Error("Required: --min=<1e18-scaled>");
    if (!maxStr) throw new Error("Required: --max=<1e18-scaled>");
    const minE18 = BigInt(minStr);
    const maxE18 = BigInt(maxStr);
    if (minE18 >= maxE18) throw new Error("--min must be < --max");

    const relayAddr = loadAddress(ctx.bookKey, "OracleRelay");
    if (!relayAddr) throw new Error(`Missing OracleRelay in address book for ${ctx.bookKey}`);
    const relay = (await getDeployedContract("OracleRelay", relayAddr)).connect(signer);

    logger.info(`Relay: ${relayAddr}`);
    logger.info(`New band: [${minE18}, ${maxE18}] (1e18-scaled)`);
    if (DRY_RUN) {
      logger.success("DRY_RUN=true — not submitting");
      return;
    }
    const tx = await (relay as any).setPriceBand(minE18, maxE18);
    const receipt = await tx.wait(1);
    logger.success(`setPriceBand tx: ${receipt.hash}`);
    return;
  }

  if (action === "wire") {
    // Default to wiring the OracleRelay in the address book; allow override via --relay.
    const explicit = parseArg("relay");
    const fromBook = loadAddress(ctx.bookKey, "OracleRelay");
    const relayAddr = explicit ?? fromBook;
    if (!relayAddr) {
      throw new Error(
        "No relay address found. Either pass --relay=0x... or deploy OracleRelay first."
      );
    }
    if (!ethers.isAddress(relayAddr)) throw new Error(`Invalid relay: ${relayAddr}`);

    const psmAddr = loadAddress(ctx.bookKey, "LitePSM");
    const queueAddr = loadAddress(ctx.bookKey, "RedemptionQueue");
    if (!psmAddr) throw new Error(`Missing LitePSM in address book for ${ctx.bookKey}`);
    if (!queueAddr) throw new Error(`Missing RedemptionQueue in address book for ${ctx.bookKey}`);

    const psm = (await getDeployedContract("LitePSM", psmAddr)).connect(signer);
    const queue = (await getDeployedContract("RedemptionQueue", queueAddr)).connect(signer);

    logger.info(`Wiring relay ${relayAddr} onto:`);
    logger.info(`  LitePSM:         ${psmAddr}`);
    logger.info(`  RedemptionQueue: ${queueAddr}`);
    if (DRY_RUN) {
      logger.success("DRY_RUN=true — not submitting");
      return;
    }
    const tx1 = await (psm as any).setOracleRelay(relayAddr);
    await tx1.wait(1);
    logger.success(`LitePSM.setOracleRelay tx: ${tx1.hash}`);
    const tx2 = await (queue as any).setOracleRelay(relayAddr);
    await tx2.wait(1);
    logger.success(`RedemptionQueue.setOracleRelay tx: ${tx2.hash}`);
    return;
  }

  throw new Error(
    `Unknown --action=${action}. Valid actions: set-feed, set-staleness, set-band, wire.`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    logger.error(e.message ?? String(e));
    process.exit(1);
  });
