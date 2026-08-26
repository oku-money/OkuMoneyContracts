/**
 * Standalone verification script for already-deployed contracts
 * 
 * Usage:
 *   npx hardhat run scripts/deploy/verify.ts --network sepolia
 */

import { ethers, run, upgrades } from "hardhat";
import { loadAddressBook } from "../utils/addressBook";
import { getNetworkName } from "../config/chains";
import { logger } from "../utils/logger";

const VERIFIABLE_NETWORKS = [
  "sepolia",
  "opSepolia",
  "baseSepolia",
  "arbSepolia",
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

  // UUPS proxies — verify the implementation behind each, since that is where
  // the source lives. Mirrors PROXY_CONTRACTS in deploy/index.ts.
  const proxyContracts = [
    "OkuM",
    "USDOku",
    "USDOkuWrapper",
    "SubscriptionModule",
    "RedemptionQueue",
  ];

  for (const contractName of proxyContracts) {
    const address = addresses[contractName];
    if (address) {
      logger.info(`Verifying ${contractName}...`);
      await verifyImplementation(address, contractName);
    }
  }

  // Non-proxy contracts. `OkuMultiplierAdapter` is immutable by design (a
  // bounds change means deploying a new one), so it has no implementation slot
  // to chase — but its constructor args must be supplied for the bytecode to
  // match. They are re-derived here from the deployed adapter rather than
  // hardcoded, so this stays correct if deploy/index.ts retunes the bounds.
  if (addresses.MockUSDC) {
    logger.info("Verifying MockUSDC...");
    await verifyNonProxy(addresses.MockUSDC, "MockUSDC");
  }

  if (addresses.OkuMultiplierAdapter) {
    logger.info("Verifying OkuMultiplierAdapter...");
    const adapter = await ethers.getContractAt(
      "OkuMultiplierAdapter",
      addresses.OkuMultiplierAdapter
    );
    await verifyNonProxy(addresses.OkuMultiplierAdapter, "OkuMultiplierAdapter", [
      await adapter.token(),
      await adapter.minAnswer(),
      await adapter.maxAnswer(),
      await adapter.stalenessThreshold(),
    ]);
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
