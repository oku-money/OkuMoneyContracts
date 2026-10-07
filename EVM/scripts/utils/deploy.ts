/**
 * Contract-instance + tx-wait helpers used by every operator / test script.
 * Proxy deployment lives in `scripts/deploy/index.ts`.
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
 * Wait for a tx, log the confirmation block + tx hash. Throws on revert (ethers default).
 */
export async function waitForTx(tx: any, description: string): Promise<void> {
  logger.info(`${description}...`);
  const receipt = await tx.wait();
  logger.success(
    `${description} - block ${receipt.blockNumber} - ${receipt.hash ?? tx.hash}`
  );
}
