/**
 * Deploy core contracts: OkuUSD, wOkuUSD, RedemptionQueue
 */

import { ethers } from "hardhat";
import { deployUUPSProxy } from "../utils/deploy";
import { getNetworkName, getChainConfig } from "../config/chains";
import { logger } from "../utils/logger";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Deploying Core Contracts to ${chainConfig.name}`);

  const [deployer] = await ethers.getSigners();
  logger.info(`Deployer address: ${deployer.address}`);
  logger.info(`Deployer balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  // Deploy OkuUSD
  logger.step(1, "Deploying OkuUSD...");
  const maxSupply = ethers.parseUnits("1000000000", 18); // 1 billion tokens
  const okuUSD = await deployUUPSProxy(
    "OkuUSD",
    [
      "Oku USD", // name
      "okuUSD",  // symbol
      deployer.address, // admin
      maxSupply, // maxSupply
    ],
    network
  );
  const okuUSDAddress = await okuUSD.getAddress();

  // Deploy wOkuUSD
  logger.step(2, "Deploying wOkuUSD...");
  const wOkuUSD = await deployUUPSProxy(
    "wOkuUSD",
    [
      okuUSDAddress, // underlying OkuUSD
      "Wrapped Oku USD", // name
      "wOkuUSD", // symbol
      deployer.address, // admin
    ],
    network
  );

  // Deploy RedemptionQueue
  logger.step(3, "Deploying RedemptionQueue...");
  const redemptionQueue = await deployUUPSProxy(
    "RedemptionQueue",
    [
      okuUSDAddress, // okuUSD
      deployer.address, // admin
    ],
    network
  );

  logger.section("Core Contracts Deployment Summary");
  logger.success(`OkuUSD: ${okuUSDAddress}`);
  logger.success(`wOkuUSD: ${await wOkuUSD.getAddress()}`);
  logger.success(`RedemptionQueue: ${await redemptionQueue.getAddress()}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
