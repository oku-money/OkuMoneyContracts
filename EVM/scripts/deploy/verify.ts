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
  "arbSepolia",
  "bscTestnet",
  "mainnet",
  "optimism",
  "arbitrum",
  "base",
  "bsc",
];

/**
 * Verify on BOTH Etherscan and Sourcify.
 *
 * Sourcify is not optional cosmetics: the ERC-7730 linter used by the
 * clear-signing registry resolves reference ABIs from Sourcify FIRST, falling
 * back to Etherscan. A contract absent from Sourcify yields a "Could not fetch
 * ABI" warning that the registry's REVIEWING.md tells reviewers to challenge.
 * See metadata/erc7730/README.md.
 */
async function verifyBoth(address: string, label: string, constructorArgs: any[]): Promise<void> {
  // Etherscan
  try {
    await run("verify:verify", { address, constructorArguments: constructorArgs });
    logger.success(`  ${label} verified (Etherscan)`);
  } catch (error: any) {
    if (/already verified/i.test(error.message)) {
      logger.info(`  ${label} already verified (Etherscan)`);
    } else {
      logger.warning(`  ${label} Etherscan verification failed: ${error.message}`);
    }
  }

  // Sourcify
  try {
    await run("verify:sourcify", { address });
    logger.success(`  ${label} verified (Sourcify)`);
  } catch (error: any) {
    if (/already verified/i.test(error.message)) {
      logger.info(`  ${label} already verified (Sourcify)`);
    } else {
      logger.warning(
        `  ${label} Sourcify verification failed: ${error.message}` +
          " - the ERC-7730 registry linter will not be able to fetch this ABI"
      );
    }
  }
}

async function verifyImplementation(proxyAddress: string, contractName: string): Promise<void> {
  try {
    const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    logger.info(`  ${contractName} implementation: ${implAddress}`);
    await verifyBoth(implAddress, `${contractName} implementation`, []);
    // The PROXY is the address users transact with and the address the
    // ERC-7730 descriptors bind to, so it must be resolvable too.
    await verifyBoth(proxyAddress, `${contractName} proxy`, []);
  } catch (error: any) {
    if (error.message.includes("Already Verified") || error.message.includes("already verified")) {
      logger.info(`  ${contractName} already verified`);
    } else {
      logger.warning(`  ${contractName} verification failed: ${error.message}`);
    }
  }
}

async function verifyNonProxy(address: string, contractName: string, constructorArgs: any[] = []): Promise<void> {
  await verifyBoth(address, contractName, constructorArgs);
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
  const proxyContracts = ["OkuM", "SubscriptionModule", "USDOku", "USDOkuWrapper"];
  
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
