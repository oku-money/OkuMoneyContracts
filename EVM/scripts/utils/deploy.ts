/**
 * Contract-instance + tx-wait helpers used by every operator / test script.
 * Proxy deployment lives in `scripts/deploy/index.ts`.
 */

import { ethers } from "hardhat";
import { Contract, TransactionReceipt } from "ethers";
import { logger } from "./logger";
import type { OkuMoney, OkuDollar, LitePSM, MockUSDC } from "../../typechain-types";

/** Typechain types for the contracts operator scripts attach to. */
export interface DeployedContracts {
  OkuMoney: OkuMoney;
  OkuDollar: OkuDollar;
  LitePSM: LitePSM;
  MockUSDC: MockUSDC;
}

/**
 * Get a deployed contract instance bound to the given address.
 *
 * Uses the locally-compiled artifact for `contractName`, so the ABI matches
 * the source in `EVM/src/` even if the on-chain bytecode is an older impl.
 * Returns the typechain type for the protocol contracts, so `tsc` catches a
 * script calling a function that no longer exists — scripts must not cast
 * these to `any`.
 */
export async function getDeployedContract<N extends keyof DeployedContracts>(
  contractName: N,
  address: string
): Promise<DeployedContracts[N]>;
export async function getDeployedContract(contractName: string, address: string): Promise<Contract>;
export async function getDeployedContract(contractName: string, address: string): Promise<unknown> {
  const Factory = await ethers.getContractFactory(contractName);
  return Factory.attach(address);
}

/**
 * Wait for `confirmations` and return the receipt, throwing if the provider
 * returns none (ethers types `wait()` as possibly null).
 */
export async function waitMined(
  tx: { hash: string; wait: (c?: number) => Promise<TransactionReceipt | null> },
  confirmations = 1
): Promise<TransactionReceipt> {
  const receipt = await tx.wait(confirmations);
  if (!receipt) throw new Error(`no receipt for ${tx.hash}`);
  return receipt;
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
