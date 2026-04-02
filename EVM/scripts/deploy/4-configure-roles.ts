/**
 * Configure roles for all deployed contracts
 *
 * This script grants the necessary roles to enable the OkuMoney system:
 * - OkuMoney: Minter roles to LitePSM, OkuBridge, OkuBridgeRouter
 * - OkuMoney: Rebaser role to deployer (for testnet price updates)
 * - OkuDollar: Rebaser role to deployer (for testnet multiplier updates)
 * - RedemptionQueue: PSM role to LitePSM
 * - LitePSM: Buffer roles to deployer
 * - OkuBridge: Already configured during initialization
 * - OkuBridgeRouter: Already configured during initialization
 */

import { ethers } from "hardhat";
import { getNetworkName, getChainConfig } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { ROLES } from "../config/roles";
import { logger } from "../utils/logger";
import { waitForTx, getDeployedContract } from "../utils/deploy";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Configuring Roles on ${chainConfig.name}`);

  const [deployer] = await ethers.getSigners();
  logger.info(`Admin address: ${deployer.address}`);

  // Load deployed contract addresses
  const okuMoneyAddress = loadAddress(network, "OkuMoney");
  const okuDollarAddress = loadAddress(network, "OkuDollar");
  const redemptionQueueAddress = loadAddress(network, "RedemptionQueue");
  const litePSMAddress = loadAddress(network, "LitePSM");
  const okuBridgeAddress = loadAddress(network, "OkuBridge");
  const bridgeRouterAddress = loadAddress(network, "OkuBridgeRouter");

  // Get contract instances
  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddress);
  const okuDollar = await getDeployedContract("OkuDollar", okuDollarAddress);
  const redemptionQueue = await getDeployedContract("RedemptionQueue", redemptionQueueAddress);
  const litePSM = await getDeployedContract("LitePSM", litePSMAddress);

  // Configure OkuMoney roles
  logger.section("Configuring OkuMoney Roles");

  logger.step(1, "Granting OKUM_MINTER to LitePSM");
  await waitForTx(
    await okuMoney.grantRole(ROLES.OKUM_MINTER, litePSMAddress),
    "Grant OKUM_MINTER to LitePSM"
  );

  logger.step(2, "Granting OKUM_MINTER to RedemptionQueue");
  await waitForTx(
    await okuMoney.grantRole(ROLES.OKUM_MINTER, redemptionQueueAddress),
    "Grant OKUM_MINTER to RedemptionQueue"
  );

  logger.step(3, "Granting OKUM_MINTER to OkuBridge");
  await waitForTx(
    await okuMoney.grantRole(ROLES.OKUM_MINTER, okuBridgeAddress),
    "Grant OKUM_MINTER to OkuBridge"
  );

  logger.step(4, "Granting OKUM_MINTER to OkuBridgeRouter");
  await waitForTx(
    await okuMoney.grantRole(ROLES.OKUM_MINTER, bridgeRouterAddress),
    "Grant OKUM_MINTER to OkuBridgeRouter"
  );

  logger.step(5, "Granting OKUM_REBASER to Admin (testnet)");
  await waitForTx(
    await okuMoney.grantRole(ROLES.OKUM_REBASER, deployer.address),
    "Grant OKUM_REBASER to Admin"
  );

  logger.step(6, "Granting OKUM_ALLOWANCE_MANAGER to Admin");
  await waitForTx(
    await okuMoney.grantRole(ROLES.OKUM_ALLOWANCE_MANAGER, deployer.address),
    "Grant OKUM_ALLOWANCE_MANAGER to Admin"
  );

  // Configure minter allowances (1 billion tokens)
  const minterAllowance = ethers.parseUnits("1000000000", 18);

  logger.step(7, "Configuring minter allowance for LitePSM");
  await waitForTx(
    await okuMoney.configureMinterAllowance(litePSMAddress, minterAllowance),
    "Configure LitePSM minter allowance"
  );

  logger.step(8, "Configuring minter allowance for RedemptionQueue");
  await waitForTx(
    await okuMoney.configureMinterAllowance(redemptionQueueAddress, minterAllowance),
    "Configure RedemptionQueue minter allowance"
  );

  logger.step(9, "Configuring minter allowance for OkuBridge");
  await waitForTx(
    await okuMoney.configureMinterAllowance(okuBridgeAddress, minterAllowance),
    "Configure OkuBridge minter allowance"
  );

  logger.step(10, "Configuring minter allowance for OkuBridgeRouter");
  await waitForTx(
    await okuMoney.configureMinterAllowance(bridgeRouterAddress, minterAllowance),
    "Configure OkuBridgeRouter minter allowance"
  );

  // Configure OkuDollar roles
  logger.section("Configuring OkuDollar Roles");

  logger.step(11, "Granting VAULT_REBASER to Admin (testnet)");
  await waitForTx(
    await okuDollar.grantRole(ROLES.VAULT_REBASER, deployer.address),
    "Grant VAULT_REBASER to Admin"
  );

  // Configure RedemptionQueue roles
  logger.section("Configuring RedemptionQueue Roles");

  logger.step(12, "Granting QUEUE_PSM to LitePSM");
  await waitForTx(
    await redemptionQueue.grantRole(ROLES.QUEUE_PSM, litePSMAddress),
    "Grant QUEUE_PSM to LitePSM"
  );

  // Configure LitePSM roles
  logger.section("Configuring LitePSM Roles");

  logger.step(13, "Granting PSM_BUFFER_DEPOSITOR to Admin");
  await waitForTx(
    await litePSM.grantRole(ROLES.PSM_BUFFER_DEPOSITOR, deployer.address),
    "Grant PSM_BUFFER_DEPOSITOR to Admin"
  );

  // PSM_QUEUE_PROCESSOR is already granted to admin in initialize
  logger.info("PSM_QUEUE_PROCESSOR already granted to Admin during initialization");

  // Configure OkuBridge roles
  logger.section("Configuring OkuBridge Roles");
  logger.info("All OkuBridge roles already granted to Admin during initialization");
  logger.info("Roles include: BRIDGE_SIGNER_MANAGER, BRIDGE_PAUSER, BRIDGE_UNPAUSER,");
  logger.info("  BRIDGE_FEE_MANAGER, BRIDGE_CHAIN_MANAGER, BRIDGE_LIMITS_MANAGER,");
  logger.info("  BRIDGE_NONCE_ADMIN, BRIDGE_REFUND_INITIATOR, BRIDGE_REFUND_CONFIRMER");

  // Configure OkuBridgeRouter roles
  logger.section("Configuring OkuBridgeRouter Roles");
  logger.info("All OkuBridgeRouter roles already granted to Admin during initialization");
  logger.info("Roles include: ROUTER_ADAPTER_MANAGER, ROUTER_BRIDGE_MANAGER");

  logger.section("Role Configuration Complete");
  logger.success("All roles configured successfully");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Role configuration failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
