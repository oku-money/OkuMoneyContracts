/**
 * Complete deployment and testing orchestration script
 *
 * This script:
 * 1. Checks if local network is running
 * 2. Deploys all contracts
 * 3. Configures roles
 * 4. Gets USDC for testing
 * 5. Tests all interactions (mint, wrap, rebalance)
 *
 * Usage:
 *   Terminal 1: npx hardhat node --fork https://mainnet.optimism.io
 *   Terminal 2: npx hardhat run scripts/deploy-and-test.ts --network localhost
 *
 * Or specify a different network:
 *   NETWORK=localhost npx hardhat run scripts/deploy-and-test.ts --network localhost
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
    logger.info("Make sure Hardhat node is running:");
    logger.info("  npx hardhat node --fork https://mainnet.optimism.io");
    return false;
  }
}

/**
 * Run a script and handle errors
 */
function runScript(scriptPath: string, description: string, env: Record<string, string> = {}): boolean {
  logger.section(description);

  const network = getNetworkName();
  const envStr = Object.entries({ NETWORK: network, ...env })
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");

  const command = `${envStr} npx hardhat run ${scriptPath} --network ${network}`;

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
 * Main orchestration function
 */
async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`OkuMoney Complete Deployment & Test Suite`);
  logger.info(`Target network: ${chainConfig.name}`);
  logger.info(`Network: ${network}`);
  console.log();

  // Step 0: Check network connectivity
  logger.section("STEP 0: NETWORK CHECK");
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

  logger.warning("This will deploy all contracts and run the complete test suite");
  logger.info("Press Ctrl+C to cancel, or wait 3 seconds to continue...\n");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Phase 1: Deploy contracts
  logger.section("PHASE 1: DEPLOYMENT");

  let success = runScript("scripts/deploy/1-deploy-core.ts", "Step 1: Deploy Core Contracts");
  if (!success) process.exit(1);

  success = runScript("scripts/deploy/2-deploy-psm.ts", "Step 2: Deploy LitePSM");
  if (!success) process.exit(1);

  success = runScript("scripts/deploy/3-deploy-bridge.ts", "Step 3: Deploy Bridge Router");
  if (!success) process.exit(1);

  success = runScript("scripts/deploy/4-configure-roles.ts", "Step 4: Configure Roles");
  if (!success) process.exit(1);

  // Phase 2: Get USDC (only for fork testing)
  if (network === "localhost") {
    logger.section("PHASE 2: ACQUIRE USDC FOR TESTING");

    // Try the more reliable deal-usdc method first
    logger.info("Attempting to deal USDC directly (more reliable)...");
    success = runScript(
      "scripts/utils/deal-usdc.ts",
      "Step 5a: Deal USDC via storage manipulation",
      { AMOUNT: "100000" }
    );

    if (!success) {
      logger.warning("Direct deal failed, trying whale impersonation...");
      success = runScript(
        "scripts/utils/get-usdc-fork.ts",
        "Step 5b: Get USDC from Whale",
        { AMOUNT: "100000" }
      );
    }

    if (!success) {
      logger.warning("Failed to get USDC automatically");
      logger.info("You may need to manually get USDC");
      logger.info("Try: npx hardhat console --network localhost");
      logger.info("Then follow the manual steps in QUICKSTART.md");
      logger.info("Continuing anyway...\n");
    }
  } else {
    logger.section("PHASE 2: USDC CHECK");
    logger.warning("On mainnet - skipping USDC acquisition");
    logger.info("Ensure you have USDC in your wallet before testing interactions\n");
  }

  // Phase 3: Test interactions
  logger.section("PHASE 3: TEST INTERACTIONS");

  success = runScript(
    "scripts/interactions/mint-okuusd.ts",
    "Step 6: Mint OkuUSD from USDC",
    { AMOUNT: "10000" }
  );
  if (!success) {
    logger.warning("Mint failed - you may not have enough USDC");
    logger.info("Stopping here. Fix USDC balance and run interaction scripts manually.\n");
    process.exit(1);
  }

  success = runScript(
    "scripts/interactions/check-balances.ts",
    "Step 7: Check Balances After Mint"
  );

  success = runScript(
    "scripts/interactions/wrap-okuusd.ts",
    "Step 8: Wrap OkuUSD to wOkuUSD",
    { AMOUNT: "5000" }
  );
  if (!success) {
    logger.warning("Wrap failed");
    process.exit(1);
  }

  success = runScript(
    "scripts/interactions/check-balances.ts",
    "Step 9: Check Balances After Wrap"
  );

  success = runScript(
    "scripts/interactions/rebalance.ts",
    "Step 10: Rebalance (5% yield)",
    { MULTIPLIER: "1.05" }
  );
  if (!success) {
    logger.warning("Rebalance failed");
    process.exit(1);
  }

  success = runScript(
    "scripts/interactions/check-balances.ts",
    "Step 11: Check Final Balances"
  );

  // Summary
  logger.section("DEPLOYMENT & TESTING COMPLETE!");
  logger.success("All contracts deployed successfully");
  logger.success("All interactions completed successfully");
  logger.success("Happy path verified!");

  logger.info("\nDeployed Contracts:");
  logger.info("  Check EVM/scripts/config/addresses.json for contract addresses");

  logger.info("\nNext steps:");
  logger.info("1. Run additional mint/wrap cycles");
  logger.info("2. Test multiple rebalances");
  logger.info("3. Test edge cases (queue, redemptions, etc.)");
  logger.info("4. Verify contract state with direct calls");

  if (network === "localhost") {
    logger.info("\nTo interact with deployed contracts:");
    logger.info("  npx hardhat console --network localhost");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Orchestration failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
