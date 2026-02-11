/**
 * Deploy all contracts in sequence
 *
 * This script:
 * 1. Checks if network is running
 * 2. Deploys all contracts
 * 3. Configures roles
 *
 * Usage:
 *   Terminal 1: npx hardhat node --fork https://mainnet.optimism.io
 *   Terminal 2: npx hardhat run scripts/deploy-all.ts --network localhost
 *
 * Or for mainnet:
 *   NETWORK=optimism npx hardhat run scripts/deploy-all.ts --network optimism
 */

import { ethers } from "hardhat";
import { execSync } from "child_process";
import { logger } from "./utils/logger";
import { getNetworkName, getChainConfig } from "./config/chains";

/**
 * Check if the network is reachable
 */
async function checkNetwork(): Promise<boolean> {
  try {
    const network = getNetworkName();
    const chainConfig = getChainConfig(network);

    logger.info(`Checking if ${chainConfig.name} network is reachable...`);

    const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);
    const blockNumber = await provider.getBlockNumber();

    logger.success(`Network is reachable! Current block: ${blockNumber}`);
    return true;
  } catch (error: any) {
    logger.error(`Network is not reachable: ${error.message}`);

    const network = getNetworkName();
    if (network === "localhost") {
      logger.info("Make sure Hardhat node is running:");
      logger.info("  npx hardhat node --fork https://mainnet.optimism.io");
    } else {
      logger.info(`Check your RPC URL for ${network}`);
    }
    return false;
  }
}

/**
 * Run a script and handle errors
 */
function runScript(scriptPath: string, description: string): boolean {
  logger.section(description);

  const network = getNetworkName();
  const command = `NETWORK=${network} npx hardhat run ${scriptPath} --network ${network}`;

  try {
    execSync(command, { stdio: "inherit" });
    logger.success(`${description} completed successfully\n`);
    return true;
  } catch (error: any) {
    logger.error(`${description} failed`);
    return false;
  }
}

/**
 * Main deployment function
 */
async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`OkuMoney Contract Deployment`);
  logger.info(`Target network: ${chainConfig.name}`);
  logger.info(`Network: ${network}`);
  console.log();

  // Check network connectivity
  logger.section("NETWORK CHECK");
  const networkReachable = await checkNetwork();

  if (!networkReachable) {
    logger.error("Cannot proceed without network connectivity");
    process.exit(1);
  }
  console.log();

  // Get deployer info
  const [deployer] = await ethers.getSigners();
  logger.info(`Deployer address: ${deployer.address}`);
  logger.info(`Deployer balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);
  console.log();

  logger.warning("This will deploy all OkuMoney contracts");
  logger.info("Press Ctrl+C to cancel, or wait 3 seconds to continue...\n");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Deploy all contracts
  logger.section("DEPLOYING CONTRACTS");

  let success = runScript("scripts/deploy/1-deploy-core.ts", "Step 1/4: Deploy Core Contracts");
  if (!success) process.exit(1);

  success = runScript("scripts/deploy/2-deploy-psm.ts", "Step 2/4: Deploy LitePSM");
  if (!success) process.exit(1);

  success = runScript("scripts/deploy/3-deploy-bridge.ts", "Step 3/4: Deploy Bridge Contracts");
  if (!success) process.exit(1);

  success = runScript("scripts/deploy/4-configure-roles.ts", "Step 4/4: Configure Roles");
  if (!success) process.exit(1);

  // Summary
  logger.section("DEPLOYMENT COMPLETE!");
  logger.success("All contracts deployed successfully");

  logger.info("\nDeployed contracts saved to:");
  logger.info("  EVM/scripts/config/addresses.json");

  logger.info("\nNext steps:");

  if (network === "localhost") {
    logger.info("1. Get USDC for testing:");
    logger.info("   NETWORK=localhost npx hardhat run scripts/utils/get-usdc-fork.ts --network localhost");
    logger.info("2. Test interactions:");
    logger.info("   NETWORK=localhost AMOUNT=10000 npx hardhat run scripts/interactions/mint-okuusd.ts --network localhost");
  } else {
    logger.info("1. Verify contracts on Etherscan");
    logger.info("2. Test interactions with real USDC");
    logger.info("3. Consider setting up multi-sig for admin roles");
  }

  logger.info("\nTo run the full test suite:");
  logger.info(`  NETWORK=${network} npx hardhat run scripts/deploy-and-test.ts --network ${network}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
