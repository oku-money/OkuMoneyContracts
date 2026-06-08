/**
 * Contract-instance + tx-wait helpers used by every operator / test script.
 *
 * Proxy-deployment helpers (`deployUUPSProxy`, `deployTransparentProxy`) used
 * to live here but were unused — `scripts/deploy/index.ts` ships its own
 * retry-aware copies inline. They were removed in the post-MVP script
 * overhaul. If you need to deploy a proxy outside the master deploy script,
 * call `upgrades.deployProxy` directly.
 */

import { ethers } from "hardhat";
import { Contract } from "ethers";
import { logger } from "./logger";

/**
 * Get a deployed contract instance bound to the given address.
 *
 * Uses the locally-compiled artifact for `contractName`, so the ABI matches
 * the source in `EVM/src/` even if the on-chain bytecode is an older impl.
 */
export async function getDeployedContract(
  contractName: string,
  address: string
): Promise<Contract> {
  const Factory = await ethers.getContractFactory(contractName);
  return Factory.attach(address) as Contract;
}

/**
 * Wait for a tx, log the confirmation block. Throws on revert (ethers default).
 */
export async function waitForTx(tx: any, description: string): Promise<void> {
  logger.info(`${description}...`);
  const receipt = await tx.wait();
  logger.success(`${description} - confirmed in block ${receipt.blockNumber}`);
}
