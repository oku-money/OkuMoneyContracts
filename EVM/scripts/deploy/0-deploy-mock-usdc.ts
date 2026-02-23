/**
 * Deploy MockUSDC for testnet/local testing
 *
 * MockUSDC is an open-mint ERC20 (6 decimals) with no access control on mint().
 * It is saved to the address book as "MockUSDC" so that 2-deploy-psm.ts picks it
 * up automatically instead of using the canonical USDC address from chain config.
 *
 * Usage:
 *   NETWORK=localhost npx hardhat run scripts/deploy/0-deploy-mock-usdc.ts --network localhost
 *   NETWORK=opSepolia npx hardhat run scripts/deploy/0-deploy-mock-usdc.ts --network opSepolia
 */

import { ethers } from "hardhat";
import { saveAddress } from "../utils/addressBook";
import { getNetworkName, getChainConfig } from "../config/chains";
import { logger } from "../utils/logger";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Deploying MockUSDC to ${chainConfig.name}`);

  const [deployer] = await ethers.getSigners();
  logger.info(`Deployer address: ${deployer.address}`);

  logger.step(1, "Deploying MockUSDC...");
  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const mockUsdc = await MockUSDC.deploy();
  await mockUsdc.waitForDeployment();

  const address = await mockUsdc.getAddress();
  saveAddress(network, "MockUSDC", address);

  logger.section("MockUSDC Deployment Summary");
  logger.success(`MockUSDC: ${address}`);
  logger.info("Saved as 'MockUSDC' in address book — 2-deploy-psm.ts will use it automatically");
  logger.info("\nTo mint test USDC (no role required):");
  logger.info(`  cast send ${address} "mint(address,uint256)" <RECIPIENT> <AMOUNT> --rpc-url <RPC>`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
