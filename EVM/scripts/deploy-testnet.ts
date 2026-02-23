/**
 * Deploy all contracts to testnet (OP Sepolia) or a local fork of it.
 *
 * Differences from deploy-all.ts (mainnet):
 *   - Step 0: Deploys MockUSDC (open-mint, no faucet needed)
 *   - LitePSM uses MockUSDC instead of a canonical USDC address
 *   - "Next steps" show how to mint test USDC directly
 *
 * Mainnet deployment is unchanged — use deploy-all.ts for that.
 *
 * Usage (local fork of OP Sepolia):
 *   Terminal 1: FORK_URL=$OP_SEPOLIA_RPC_URL npx hardhat node
 *   Terminal 2: NETWORK=localhost npx hardhat run scripts/deploy-testnet.ts --network localhost
 *
 * Usage (live OP Sepolia):
 *   NETWORK=opSepolia npx hardhat run scripts/deploy-testnet.ts --network opSepolia
 */

import { ethers } from "hardhat";
import { execSync } from "child_process";
import { logger } from "./utils/logger";
import { getNetworkName, getChainConfig } from "./config/chains";
import { loadAddress } from "./utils/addressBook";

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
      logger.info("  FORK_URL=$OP_SEPOLIA_RPC_URL npx hardhat node");
    } else {
      logger.info(`Check your RPC URL for ${network} (OP_SEPOLIA_RPC_URL)`);
    }
    return false;
  }
}

/**
 * Run a deployment script and handle errors
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
 * Main testnet deployment function
 */
async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section("OkuMoney Testnet Deployment");
  logger.info(`Target network: ${chainConfig.name}`);
  logger.info(`Network key:    ${network}`);
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

  logger.warning("This will deploy all OkuMoney contracts + MockUSDC to the testnet");
  logger.info("Press Ctrl+C to cancel, or wait 3 seconds to continue...\n");
  await new Promise((resolve) => setTimeout(resolve, 3000));

  // Deploy all contracts
  logger.section("DEPLOYING CONTRACTS");

  let success = runScript("scripts/deploy/0-deploy-mock-usdc.ts", "Step 0/4: Deploy MockUSDC");
  if (!success) process.exit(1);

  success = runScript("scripts/deploy/1-deploy-core.ts", "Step 1/4: Deploy Core Contracts");
  if (!success) process.exit(1);

  success = runScript("scripts/deploy/2-deploy-psm.ts", "Step 2/4: Deploy LitePSM");
  if (!success) process.exit(1);

  success = runScript("scripts/deploy/3-deploy-bridge.ts", "Step 3/4: Deploy Bridge Contracts");
  if (!success) process.exit(1);

  success = runScript("scripts/deploy/4-configure-roles.ts", "Step 4/4: Configure Roles");
  if (!success) process.exit(1);

  // Load deployed addresses for next-steps output
  const mockUsdcAddress = loadAddress(network, "MockUSDC");
  const litePsmAddress = loadAddress(network, "LitePSM");

  // Summary
  logger.section("TESTNET DEPLOYMENT COMPLETE!");
  logger.success("All contracts deployed successfully");

  logger.info("\nDeployed contracts saved to:");
  logger.info("  EVM/scripts/config/addresses.json");

  logger.info("\nNext steps:");
  logger.info("1. Mint test USDC (MockUSDC has no access control — anyone can mint):");
  logger.info(`   cast send ${mockUsdcAddress} "mint(address,uint256)" <YOUR_ADDR> 1000000000 \\`);

  if (network === "localhost") {
    logger.info("     --rpc-url http://127.0.0.1:8545");
  } else {
    logger.info(`     --rpc-url $OP_SEPOLIA_RPC_URL --private-key $PRIVATE_KEY`);
  }

  logger.info("\n2. Approve LitePSM and mint OkuUSD:");
  logger.info(`   NETWORK=${network} AMOUNT=1000 npx hardhat run scripts/interactions/mint-okuusd.ts --network ${network}`);

  logger.info("\n3. Check balances:");
  logger.info(`   NETWORK=${network} npx hardhat run scripts/interactions/check-balances.ts --network ${network}`);

  if (network !== "localhost") {
    logger.info("\n4. Verify contracts on OP Sepolia Etherscan:");
    logger.info(`   npx hardhat verify --network ${network} ${mockUsdcAddress}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
