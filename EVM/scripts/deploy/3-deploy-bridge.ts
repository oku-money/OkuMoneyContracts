/**
 * Deploy OkuBridge and OkuBridgeRouter contracts
 *
 * OkuBridge: Orchestrator-signed cross-chain bridge using burn-and-mint pattern
 * OkuBridgeRouter: Convenience wrapper for bridging wOkuUSD
 */

import { ethers } from "hardhat";
import { deployTransparentProxy, deployUUPSProxy } from "../utils/deploy";
import { getNetworkName, getChainConfig } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Deploying Bridge Contracts to ${chainConfig.name}`);

  const [deployer] = await ethers.getSigners();
  logger.info(`Deployer address: ${deployer.address}`);

  // Load deployed contract addresses
  const okuUSDAddress = loadAddress(network, "OkuUSD");
  const wOkuUSDAddress = loadAddress(network, "wOkuUSD");

  logger.info(`OkuUSD address: ${okuUSDAddress}`);
  logger.info(`wOkuUSD address: ${wOkuUSDAddress}`);

  // Configuration for OkuBridge
  // TODO: Update these addresses for production deployment
  const orchestratorSigner = deployer.address; // Replace with actual orchestrator signer address
  const feeRecipient = deployer.address; // Replace with actual fee recipient address

  // Deploy OkuBridge (uses TransparentUpgradeableProxy)
  logger.step(1, "Deploying OkuBridge...");
  const okuBridge = await deployTransparentProxy(
    "OkuBridge",
    [
      okuUSDAddress,        // OkuUSD token address
      orchestratorSigner,   // Authorized signer (orchestrator)
      feeRecipient,         // Fee recipient address
      deployer.address,     // Admin (gets all roles)
    ],
    network
  );
  const okuBridgeAddress = await okuBridge.getAddress();

  // Deploy OkuBridgeRouter (uses UUPS proxy)
  logger.step(2, "Deploying OkuBridgeRouter...");
  const bridgeRouter = await deployUUPSProxy(
    "OkuBridgeRouter",
    [
      wOkuUSDAddress,    // wOkuUSD
      okuUSDAddress,     // okuUSD
      okuBridgeAddress,  // okuBridge
      deployer.address,  // admin
    ],
    network
  );

  logger.section("Bridge Contracts Deployment Summary");
  logger.success(`OkuBridge: ${okuBridgeAddress}`);
  logger.success(`OkuBridgeRouter: ${await bridgeRouter.getAddress()}`);
  logger.info("");
  logger.info("Next steps:");
  logger.info("1. Grant MINTER to OkuBridge on OkuUSD");
  logger.info("2. Configure minter allowance for OkuBridge");
  logger.info("3. Update orchestrator signer address (if needed)");
  logger.info("4. Update fee recipient address (if needed)");
  logger.info("5. Configure supported destination chains");
  logger.warning("");
  logger.warning("Note: Router deployed but third-party bridge adapters not configured");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
