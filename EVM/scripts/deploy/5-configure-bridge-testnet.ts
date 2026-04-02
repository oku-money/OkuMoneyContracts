/**
 * Configure OkuBridge for testnet deployment
 *
 * This script applies testnet-specific bridge settings:
 * - Bridge fee: 10 bps (0.1%)
 * - Min bridge amount: 1 OkuM (permissive for testing)
 * - Max bridge amount: 100,000 OkuM
 * - Orchestrator signer: deployer address (for manual signing)
 * - Fee recipient: deployer address
 * - Supported chains: Solana Devnet (103) already added in deploy
 *
 * NOTE: This script is for testnet only. Production deployments
 * should use proper orchestrator keys and fee recipients.
 */

import { ethers } from "hardhat";
import { getNetworkName, getChainConfig, SOLANA_DEVNET_CHAIN_ID } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { waitForTx, getDeployedContract } from "../utils/deploy";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Configuring OkuBridge for Testnet on ${chainConfig.name}`);

  const [deployer] = await ethers.getSigners();
  logger.info(`Admin/Orchestrator address: ${deployer.address}`);

  // Load deployed contract address
  const okuBridgeAddress = loadAddress(network, "OkuBridge");
  const okuBridge = await getDeployedContract("OkuBridge", okuBridgeAddress);

  logger.info(`OkuBridge address: ${okuBridgeAddress}`);

  // Bridge configuration values
  const BRIDGE_FEE_BPS = 10n; // 0.1%
  const MIN_BRIDGE_AMOUNT = ethers.parseUnits("1", 18); // 1 OkuM
  const MAX_BRIDGE_AMOUNT = ethers.parseUnits("100000", 18); // 100,000 OkuM
  const BRIDGE_DEADLINE = 3600n; // 1 hour

  logger.section("Configuring Bridge Parameters");

  // Set bridge fee
  logger.step(1, `Setting bridge fee to ${BRIDGE_FEE_BPS} bps (0.1%)`);
  await waitForTx(
    await okuBridge.setBridgeFee(BRIDGE_FEE_BPS),
    "Set bridge fee"
  );

  // Set min/max bridge amounts
  logger.step(2, `Setting min bridge amount to ${ethers.formatUnits(MIN_BRIDGE_AMOUNT, 18)} OkuM`);
  logger.step(2, `Setting max bridge amount to ${ethers.formatUnits(MAX_BRIDGE_AMOUNT, 18)} OkuM`);
  await waitForTx(
    await okuBridge.setBridgeLimits(MIN_BRIDGE_AMOUNT, MAX_BRIDGE_AMOUNT),
    "Set bridge limits"
  );

  // Set bridge deadline
  logger.step(3, `Setting bridge deadline to ${BRIDGE_DEADLINE} seconds (1 hour)`);
  await waitForTx(
    await okuBridge.setBridgeDeadline(BRIDGE_DEADLINE),
    "Set bridge deadline"
  );

  // Set orchestrator signer (deployer for testnet)
  logger.step(4, "Setting orchestrator signer to deployer address");
  await waitForTx(
    await okuBridge.setAuthorizedSigner(deployer.address),
    "Set authorized signer"
  );

  // Set fee recipient (deployer for testnet)
  logger.step(5, "Setting fee recipient to deployer address");
  await waitForTx(
    await okuBridge.setFeeRecipient(deployer.address),
    "Set fee recipient"
  );

  // Verify Solana Devnet is a supported chain
  logger.step(6, "Verifying Solana Devnet (103) is supported");
  const isSolanaSupported = await okuBridge.isSupportedChain(SOLANA_DEVNET_CHAIN_ID);
  if (isSolanaSupported) {
    logger.success(`Solana Devnet (chain ID ${SOLANA_DEVNET_CHAIN_ID}) is supported`);
  } else {
    logger.warning(`Solana Devnet (chain ID ${SOLANA_DEVNET_CHAIN_ID}) is NOT supported - adding now`);
    await waitForTx(
      await okuBridge.addSupportedChain(SOLANA_DEVNET_CHAIN_ID),
      "Add Solana Devnet as supported chain"
    );
  }

  // Log final configuration
  logger.section("Bridge Configuration Summary");

  const bridgeFee = await okuBridge.bridgeFee();
  const limits = await okuBridge.limits();
  const deadline = await okuBridge.bridgeDeadline();
  const authorizedSigner = await okuBridge.authorizedSigner();
  const feeRecipient = await okuBridge.feeRecipient();
  const isPaused = await okuBridge.paused();

  logger.info(`Bridge Fee: ${bridgeFee} bps`);
  logger.info(`Min Bridge Amount: ${ethers.formatUnits(limits.min, 18)} OkuM`);
  logger.info(`Max Bridge Amount: ${ethers.formatUnits(limits.max, 18)} OkuM`);
  logger.info(`Bridge Deadline: ${deadline} seconds`);
  logger.info(`Authorized Signer: ${authorizedSigner}`);
  logger.info(`Fee Recipient: ${feeRecipient}`);
  logger.info(`Paused: ${isPaused}`);

  logger.section("Supported Chains");
  const supportedChains = [SOLANA_DEVNET_CHAIN_ID];
  for (const chainId of supportedChains) {
    const isSupported = await okuBridge.isSupportedChain(chainId);
    logger.info(`Chain ${chainId}: ${isSupported ? "SUPPORTED" : "NOT SUPPORTED"}`);
  }

  logger.section("Testnet Bridge Configuration Complete");
  logger.success("OkuBridge is ready for testnet bridge operations");
  logger.info("");
  logger.info("Next steps:");
  logger.info("1. Deploy to Solana Devnet (SVM side)");
  logger.info("2. Update testnet-addresses.json with deployed addresses");
  logger.info("3. Run bridge test scripts from EVM/scripts/bridge/");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Bridge configuration failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
