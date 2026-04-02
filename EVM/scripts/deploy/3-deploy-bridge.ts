/**
 * Deploy OkuBridge and OkuBridgeRouter contracts
 *
 * OkuBridge: Orchestrator-signed cross-chain bridge using burn-and-mint pattern
 * OkuBridgeRouter: Convenience wrapper for bridging OkuDollar (usdOku)
 */

import { ethers } from "hardhat";
import { deployTransparentProxy, deployUUPSProxy } from "../utils/deploy";
import { getNetworkName, getChainConfig } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { SOLANA_DEVNET_CHAIN_ID } from "../config/chains";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Deploying Bridge Contracts to ${chainConfig.name}`);

  const [deployer] = await ethers.getSigners();
  logger.info(`Deployer address: ${deployer.address}`);

  // Load deployed contract addresses
  const okuMoneyAddress = loadAddress(network, "OkuMoney");
  const okuDollarAddress = loadAddress(network, "OkuDollar");

  logger.info(`OkuMoney address: ${okuMoneyAddress}`);
  logger.info(`OkuDollar address: ${okuDollarAddress}`);

  // Configuration for OkuBridge
  // TODO: Update these addresses for production deployment
  const orchestratorSigner = deployer.address; // Replace with actual orchestrator signer address
  const feeRecipient = deployer.address; // Replace with actual fee recipient address

  // Initial supported chains - include Solana Devnet for testnet deployments
  const initialChains: bigint[] = [BigInt(SOLANA_DEVNET_CHAIN_ID)];
  logger.info(`Initial supported chains: [${initialChains.join(", ")}]`);

  // Deploy OkuBridge (uses TransparentUpgradeableProxy)
  logger.step(1, "Deploying OkuBridge...");
  const okuBridge = await deployTransparentProxy(
    "OkuBridge",
    [
      okuMoneyAddress,        // OkuMoney token address
      orchestratorSigner,     // Authorized signer (orchestrator)
      feeRecipient,           // Fee recipient address
      deployer.address,       // Admin (gets all roles)
      initialChains,          // Supported destination chains
    ],
    network
  );
  const okuBridgeAddress = await okuBridge.getAddress();

  // Deploy OkuBridgeRouter (uses UUPS proxy)
  logger.step(2, "Deploying OkuBridgeRouter...");
  const bridgeRouter = await deployUUPSProxy(
    "OkuBridgeRouter",
    [
      okuDollarAddress,    // OkuDollar (usdOku)
      okuMoneyAddress,     // OkuMoney
      okuBridgeAddress,    // OkuBridge
      deployer.address,    // admin
    ],
    network
  );

  logger.section("Bridge Contracts Deployment Summary");
  logger.success(`OkuBridge: ${okuBridgeAddress}`);
  logger.success(`OkuBridgeRouter: ${await bridgeRouter.getAddress()}`);
  logger.info("");
  logger.info("Next steps:");
  logger.info("1. Grant OKUM_MINTER to OkuBridge on OkuMoney");
  logger.info("2. Configure minter allowance for OkuBridge");
  logger.info("3. Update orchestrator signer address (if needed)");
  logger.info("4. Update fee recipient address (if needed)");
  logger.info("5. Run 4-configure-roles.ts to set up RBAC");
  logger.info("6. Run 5-configure-bridge-testnet.ts for testnet settings");
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
