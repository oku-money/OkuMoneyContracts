/**
 * Deploy OkuBridgeRouter contract
 * Note: Router deployed but adapters not configured (third-party bridge integration deferred)
 */

import { ethers } from "hardhat";
import { deployUUPSProxy } from "../utils/deploy";
import { getNetworkName, getChainConfig } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Deploying OkuBridgeRouter to ${chainConfig.name}`);

  const [deployer] = await ethers.getSigners();
  logger.info(`Deployer address: ${deployer.address}`);

  // Load deployed contract addresses
  const okuUSDAddress = loadAddress(network, "OkuUSD");
  const wOkuUSDAddress = loadAddress(network, "wOkuUSD");

  logger.info(`OkuUSD address: ${okuUSDAddress}`);
  logger.info(`wOkuUSD address: ${wOkuUSDAddress}`);

  // Deploy OkuBridgeRouter
  logger.step(1, "Deploying OkuBridgeRouter...");
  const bridgeRouter = await deployUUPSProxy(
    "OkuBridgeRouter",
    [
      wOkuUSDAddress, // wOkuUSD
      okuUSDAddress, // okuUSD
      deployer.address, // admin
    ],
    network
  );

  logger.section("OkuBridgeRouter Deployment Summary");
  logger.success(`OkuBridgeRouter: ${await bridgeRouter.getAddress()}`);
  logger.warning("Note: Bridge adapters not configured (third-party integration deferred)");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
