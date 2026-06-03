/**
 * Standalone verification script for already-deployed contracts
 * 
 * Usage:
 *   npx hardhat run scripts/deploy/verify.ts --network sepolia
 */

import { run, upgrades } from "hardhat";
import { loadAddressBook } from "../utils/addressBook";
import { getNetworkName } from "../config/chains";
import { logger } from "../utils/logger";

const VERIFIABLE_NETWORKS = [
  "sepolia",
  "opSepolia",
  "baseSepolia",
  "bscTestnet",
  "mainnet",
  "optimism",
  "arbitrum",
  "base",
  "bsc",
];

async function verifyImplementation(proxyAddress: string, contractName: string): Promise<void> {
  try {
    const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    logger.info(`  ${contractName} implementation: ${implAddress}`);
    
    await run("verify:verify", {
      address: implAddress,
      constructorArguments: [],
    });
    logger.success(`  ${contractName} implementation verified`);
  } catch (error: any) {
    if (error.message.includes("Already Verified") || error.message.includes("already verified")) {
      logger.info(`  ${contractName} already verified`);
    } else {
      logger.warning(`  ${contractName} verification failed: ${error.message}`);
    }
  }
}

async function verifyNonProxy(address: string, contractName: string, constructorArgs: any[] = []): Promise<void> {
  try {
    await run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    logger.success(`  ${contractName} verified`);
  } catch (error: any) {
    if (error.message.includes("Already Verified") || error.message.includes("already verified")) {
      logger.info(`  ${contractName} already verified`);
    } else {
      logger.warning(`  ${contractName} verification failed: ${error.message}`);
    }
  }
}

async function main() {
  const networkName = getNetworkName();
  
  if (!VERIFIABLE_NETWORKS.includes(networkName)) {
    throw new Error(`Network ${networkName} does not support Etherscan verification`);
  }

  if (!process.env.ETHERSCAN_API_KEY) {
    throw new Error("ETHERSCAN_API_KEY not set in environment");
  }

  logger.header(`Verifying Contracts on ${networkName}`);

  const addresses = loadAddressBook()[networkName];
  if (!addresses || Object.keys(addresses).length === 0) {
    throw new Error(`No addresses found for network ${networkName}`);
  }

  console.log("\nDeployed contracts:");
  for (const [name, address] of Object.entries(addresses)) {
    console.log(`  ${name}: ${address}`);
  }
  console.log();

  // Proxy contracts
  // OkuBridge / OkuBridgeRouter removed in the noBridge refactor; PSM is the
  // sole user-facing mint/burn surface.
  const proxyContracts = ["OkuMoney", "OkuDollar", "RedemptionQueue", "LitePSM"];
  
  for (const contractName of proxyContracts) {
    const address = addresses[contractName];
    if (address) {
      logger.info(`Verifying ${contractName}...`);
      await verifyImplementation(address, contractName);
    }
  }

  // Non-proxy contracts
  if (addresses.MockUSDC) {
    logger.info("Verifying MockUSDC...");
    await verifyNonProxy(addresses.MockUSDC, "MockUSDC");
  }

  logger.success("\nVerification complete");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Verification failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
