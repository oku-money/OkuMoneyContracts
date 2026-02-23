/**
 * Deploy LitePSM contract
 */

import { ethers } from "hardhat";
import { deployUUPSProxy } from "../utils/deploy";
import { getNetworkName, getChainConfig } from "../config/chains";
import { hasAddress, loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Deploying LitePSM to ${chainConfig.name}`);

  const [deployer] = await ethers.getSigners();
  logger.info(`Deployer address: ${deployer.address}`);

  // Load deployed contract addresses
  const okuUSDAddress = loadAddress(network, "OkuUSD");
  const redemptionQueueAddress = loadAddress(network, "RedemptionQueue");

  // Use MockUSDC from address book if present (testnet/fork deployments),
  // otherwise fall back to the canonical USDC address from chain config (mainnet).
  const usdcAddress = hasAddress(network, "MockUSDC")
    ? loadAddress(network, "MockUSDC")
    : chainConfig.usdc;

  logger.info(`OkuUSD address: ${okuUSDAddress}`);
  logger.info(`USDC address: ${usdcAddress}${hasAddress(network, "MockUSDC") ? " (MockUSDC)" : ""}`);
  logger.info(`RedemptionQueue address: ${redemptionQueueAddress}`);

  // Deploy LitePSM
  logger.step(1, "Deploying LitePSM...");
  const litePSM = await deployUUPSProxy(
    "LitePSM",
    [
      okuUSDAddress, // okuUSD
      usdcAddress, // USDC
      redemptionQueueAddress, // redemptionQueue
      deployer.address, // admin
    ],
    network
  );

  logger.section("LitePSM Deployment Summary");
  logger.success(`LitePSM: ${await litePSM.getAddress()}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
