/**
 * Check OkuMoney roles on the forked network
 */
import { ethers } from "hardhat";
import { getNetworkName, DEV_WALLET_ADDRESS } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract } from "../utils/deploy";

// Use centralized deployer address
const DEPLOYER = DEV_WALLET_ADDRESS;

async function main() {
  const network = getNetworkName();
  logger.section(`Checking Roles on ${network}`);

  const okuMoneyAddr = loadAddress(network, "OkuMoney");
  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddr);

  const DEFAULT_ADMIN = await okuMoney.DEFAULT_ADMIN_ROLE();
  const ALLOWANCE_MANAGER = await okuMoney.OKUM_ALLOWANCE_MANAGER();
  const MINTER = await okuMoney.OKUM_MINTER();
  const REBASER = await okuMoney.OKUM_REBASER();

  logger.info(`DEFAULT_ADMIN role: ${DEFAULT_ADMIN}`);
  logger.info(`ALLOWANCE_MANAGER role: ${ALLOWANCE_MANAGER}`);
  logger.info(`MINTER role: ${MINTER}`);
  logger.info(`REBASER role: ${REBASER}`);

  // Check deployer roles
  logger.section("Deployer Roles");
  const hasAdmin = await okuMoney.hasRole(DEFAULT_ADMIN, DEPLOYER);
  const hasAllowanceManager = await okuMoney.hasRole(ALLOWANCE_MANAGER, DEPLOYER);
  const hasMinter = await okuMoney.hasRole(MINTER, DEPLOYER);
  const hasRebaser = await okuMoney.hasRole(REBASER, DEPLOYER);

  logger.info(`Deployer (${DEPLOYER}):`);
  logger.info(`  DEFAULT_ADMIN: ${hasAdmin}`);
  logger.info(`  ALLOWANCE_MANAGER: ${hasAllowanceManager}`);
  logger.info(`  MINTER: ${hasMinter}`);
  logger.info(`  REBASER: ${hasRebaser}`);

  // Check LitePSM roles
  const litePSMAddr = loadAddress(network, "LitePSM");
  const litePSMHasMinter = await okuMoney.hasRole(MINTER, litePSMAddr);
  logger.info(`LitePSM (${litePSMAddr}):`);
  logger.info(`  MINTER: ${litePSMHasMinter}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Check failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
