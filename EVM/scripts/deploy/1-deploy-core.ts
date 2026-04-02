/**
 * Deploy core contracts: OkuMoney, OkuDollar, RedemptionQueue
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

  // Deploy OkuMoney
  logger.step(1, "Deploying OkuMoney...");
  const maxSupply = ethers.parseUnits("1000000000", 18); // 1 billion tokens
  const okuMoney = await deployUUPSProxy(
    "OkuMoney",
    [
      "Oku Money", // name
      "OkuM",      // symbol
      deployer.address, // admin
      maxSupply, // maxSupply
    ],
    network
  );
  const okuMoneyAddress = await okuMoney.getAddress();

  // Deploy OkuDollar
  logger.step(2, "Deploying OkuDollar...");
  const okuDollar = await deployUUPSProxy(
    "OkuDollar",
    [
      okuMoneyAddress, // underlying OkuMoney
      "Oku Dollar", // name
      "usdOku", // symbol
      deployer.address, // admin
    ],
    network
  );

  // Deploy RedemptionQueue
  logger.step(3, "Deploying RedemptionQueue...");
  const redemptionQueue = await deployUUPSProxy(
    "RedemptionQueue",
    [
      okuMoneyAddress, // okuMoney
      deployer.address, // admin
    ],
    network
  );

  logger.section("Core Contracts Deployment Summary");
  logger.success(`OkuMoney: ${okuMoneyAddress}`);
  logger.success(`OkuDollar: ${await okuDollar.getAddress()}`);
  logger.success(`RedemptionQueue: ${await redemptionQueue.getAddress()}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
