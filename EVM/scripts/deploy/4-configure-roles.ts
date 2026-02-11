/**
 * Configure roles for all deployed contracts
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
  const okuUSDAddress = loadAddress(network, "OkuUSD");
  const redemptionQueueAddress = loadAddress(network, "RedemptionQueue");
  const litePSMAddress = loadAddress(network, "LitePSM");
  const okuBridgeAddress = loadAddress(network, "OkuBridge");
  const bridgeRouterAddress = loadAddress(network, "OkuBridgeRouter");

  // Get contract instances
  const okuUSD = await getDeployedContract("OkuUSD", okuUSDAddress);
  const redemptionQueue = await getDeployedContract("RedemptionQueue", redemptionQueueAddress);
  const litePSM = await getDeployedContract("LitePSM", litePSMAddress);
  const okuBridge = await getDeployedContract("OkuBridge", okuBridgeAddress);
  const bridgeRouter = await getDeployedContract("OkuBridgeRouter", bridgeRouterAddress);

  // Configure OkuUSD roles
  logger.section("Configuring OkuUSD Roles");

  logger.step(1, "Granting MINTER_ROLE to LitePSM");
  await waitForTx(
    await okuUSD.grantRole(ROLES.MINTER_ROLE, litePSMAddress),
    "Grant MINTER_ROLE to LitePSM"
  );

  logger.step(2, "Granting MINTER_ROLE to RedemptionQueue");
  await waitForTx(
    await okuUSD.grantRole(ROLES.MINTER_ROLE, redemptionQueueAddress),
    "Grant MINTER_ROLE to RedemptionQueue"
  );

  logger.step(3, "Granting REBASER_ROLE to Admin");
  await waitForTx(
    await okuUSD.grantRole(ROLES.REBASER_ROLE, deployer.address),
    "Grant REBASER_ROLE to Admin"
  );

  logger.step(4, "Granting ALLOWANCE_MANAGER_ROLE to Admin");
  await waitForTx(
    await okuUSD.grantRole(ROLES.ALLOWANCE_MANAGER_ROLE, deployer.address),
    "Grant ALLOWANCE_MANAGER_ROLE to Admin"
  );

  // Configure minter allowances (1 billion tokens)
  const minterAllowance = ethers.parseUnits("1000000000", 18);

  logger.step(5, "Configuring minter allowance for LitePSM");
  await waitForTx(
    await okuUSD.configureMinterAllowance(litePSMAddress, minterAllowance),
    "Configure LitePSM minter allowance"
  );

  logger.step(6, "Configuring minter allowance for RedemptionQueue");
  await waitForTx(
    await okuUSD.configureMinterAllowance(redemptionQueueAddress, minterAllowance),
    "Configure RedemptionQueue minter allowance"
  );

  logger.step(7, "Granting MINTER_ROLE to OkuBridge");
  await waitForTx(
    await okuUSD.grantRole(ROLES.MINTER_ROLE, okuBridgeAddress),
    "Grant MINTER_ROLE to OkuBridge"
  );

  logger.step(8, "Configuring minter allowance for OkuBridge");
  await waitForTx(
    await okuUSD.configureMinterAllowance(okuBridgeAddress, minterAllowance),
    "Configure OkuBridge minter allowance"
  );

  // Configure RedemptionQueue roles
  logger.section("Configuring RedemptionQueue Roles");

  logger.step(9, "Granting PSM_ROLE to LitePSM");
  await waitForTx(
    await redemptionQueue.grantRole(ROLES.PSM_ROLE, litePSMAddress),
    "Grant PSM_ROLE to LitePSM"
  );

  // Configure LitePSM roles
  logger.section("Configuring LitePSM Roles");

  logger.step(10, "Granting BUFFER_DEPOSITOR_ROLE to Admin");
  await waitForTx(
    await litePSM.grantRole(ROLES.BUFFER_DEPOSITOR_ROLE, deployer.address),
    "Grant BUFFER_DEPOSITOR_ROLE to Admin"
  );

  // QUEUE_PROCESSOR_ROLE is already granted to admin in initialize
  logger.info("QUEUE_PROCESSOR_ROLE already granted to Admin during initialization");

  // Configure OkuBridge roles
  logger.section("Configuring OkuBridge Roles");
  logger.info("All OkuBridge roles already granted to Admin during initialization");
  logger.info("Roles include: BRIDGE_SIGNER_MANAGER, BRIDGE_PAUSER, BRIDGE_UNPAUSER,");
  logger.info("  BRIDGE_FEE_MANAGER, BRIDGE_CHAIN_MANAGER, BRIDGE_LIMITS_MANAGER,");
  logger.info("  BRIDGE_NONCE_ADMIN, BRIDGE_REFUND_ADMIN");

  // Configure OkuBridgeRouter roles
  logger.section("Configuring OkuBridgeRouter Roles");

  logger.step(11, "Granting ADAPTER_MANAGER_ROLE to Admin");
  await waitForTx(
    await bridgeRouter.grantRole(ROLES.ADAPTER_MANAGER_ROLE, deployer.address),
    "Grant ADAPTER_MANAGER_ROLE to Admin"
  );

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
