/**
 * UUPS proxy deployment utilities using OpenZeppelin Hardhat Upgrades plugin
 */

import { ethers, upgrades } from "hardhat";
import { Contract, ContractFactory } from "ethers";
import { logger } from "./logger";
import { saveAddress } from "./addressBook";

/**
 * Deploy a UUPS proxy with the specified contract factory and initialization arguments
 */
export async function deployUUPSProxy(
  contractName: string,
  initArgs: any[],
  network: string
): Promise<Contract> {
  logger.info(`Deploying ${contractName} with UUPS proxy...`);

  const Factory = await ethers.getContractFactory(contractName);
  const proxy = await upgrades.deployProxy(Factory, initArgs, { kind: "uups" });
  await proxy.waitForDeployment();

  const address = await proxy.getAddress();
  logger.success(`${contractName} deployed at: ${address}`);

  // Save address to address book
  saveAddress(network, contractName, address);

  return proxy;
}

/**
 * Get a deployed contract instance from the address book
 */
export async function getDeployedContract(
  contractName: string,
  address: string
): Promise<Contract> {
  const Factory = await ethers.getContractFactory(contractName);
  return Factory.attach(address) as Contract;
}

/**
 * Wait for a transaction with logging
 */
export async function waitForTx(tx: any, description: string): Promise<void> {
  logger.info(`${description}...`);
  const receipt = await tx.wait();
  logger.success(`${description} - confirmed in block ${receipt.blockNumber}`);
}
