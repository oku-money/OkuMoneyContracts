/**
 * Check OkuBridge state and configuration (Read-only diagnostics)
 *
 * Queries and logs:
 * - Supported chains, fee, min/max, authorized signer
 * - Nonces per chain
 * - Paused state
 * - Recent BridgeBurn/BridgeMint events
 * - Pending refund requests
 *
 * Usage:
 *   NETWORK=op-sepolia npx hardhat run scripts/bridge/check-bridge-state.ts --network op-sepolia
 */

import { ethers } from "hardhat";
import {
  SOLANA_DEVNET_CHAIN_ID,
  SOLANA_MAINNET_CHAIN_ID,
  OPTIMISM_CHAIN_ID,
  ARBITRUM_CHAIN_ID,
  BASE_CHAIN_ID,
  BSC_CHAIN_ID,
  ETHEREUM_CHAIN_ID,
} from "../config/chains";
import { loadAddress, hasAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract } from "../utils/deploy";
import { resolveNetworkContext } from "../utils/networkContext";

async function main() {
  const { networkName, bookKey } = await resolveNetworkContext();

  logger.section("OkuBridge State Check");
  logger.info(`Network: ${networkName} (book key: ${bookKey})`);

  // Load contract addresses
  if (!hasAddress(bookKey, "OkuBridge")) {
    throw new Error(`OkuBridge not deployed under "${bookKey}". Run deploy scripts first.`);
  }

  const okuBridgeAddress = loadAddress(bookKey, "OkuBridge");
  const okuMoneyAddress = loadAddress(bookKey, "OkuMoney");
  
  logger.info(`OkuBridge: ${okuBridgeAddress}`);
  logger.info(`OkuMoney: ${okuMoneyAddress}`);

  // Get contract instance
  const okuBridge = await getDeployedContract("OkuBridge", okuBridgeAddress);

  // ============ Basic Configuration ============
  logger.section("Bridge Configuration");

  const bridgeFee = await okuBridge.bridgeFee();
  const limits = await okuBridge.limits();
  const deadline = await okuBridge.bridgeDeadline();
  const authorizedSigner = await okuBridge.authorizedSigner();
  const feeRecipient = await okuBridge.feeRecipient();
  const isPaused = await okuBridge.paused();

  logger.info(`Bridge Fee: ${bridgeFee} bps (${Number(bridgeFee) / 100}%)`);
  logger.info(`Min Bridge Amount: ${ethers.formatUnits(limits.min, 18)} OkuM`);
  logger.info(`Max Bridge Amount: ${ethers.formatUnits(limits.max, 18)} OkuM`);
  logger.info(`Bridge Deadline: ${deadline} seconds`);
  logger.info(`Authorized Signer: ${authorizedSigner}`);
  logger.info(`Fee Recipient: ${feeRecipient}`);
  logger.info(`Paused: ${isPaused ? "YES" : "NO"}`);

  // ============ Supported Chains ============
  logger.section("Supported Chains");

  const chainsToCheck = [
    { id: SOLANA_DEVNET_CHAIN_ID, name: "Solana Devnet" },
    { id: SOLANA_MAINNET_CHAIN_ID, name: "Solana Mainnet" },
    { id: ETHEREUM_CHAIN_ID, name: "Ethereum Mainnet" },
    { id: OPTIMISM_CHAIN_ID, name: "Optimism" },
    { id: ARBITRUM_CHAIN_ID, name: "Arbitrum One" },
    { id: BASE_CHAIN_ID, name: "Base" },
    { id: BSC_CHAIN_ID, name: "BNB Smart Chain" },
  ];

  for (const chain of chainsToCheck) {
    const isSupported = await okuBridge.supportedChains(chain.id);
    const status = isSupported ? "SUPPORTED" : "not supported";
    if (isSupported) {
      const outboundNonce = await okuBridge.outboundNonce(chain.id);
      logger.info(`${chain.name} (${chain.id}): ${status}, outbound nonce: ${outboundNonce}`);
    } else {
      logger.info(`${chain.name} (${chain.id}): ${status}`);
    }
  }

  // ============ Recent Events ============
  logger.section("Recent Bridge Events (last 1000 blocks)");

  const currentBlock = await ethers.provider.getBlockNumber();
  const fromBlock = Math.max(0, currentBlock - 1000);

  // Query BridgeBurn events
  const burnFilter = okuBridge.filters.BridgeBurn();
  const burnEvents = await okuBridge.queryFilter(burnFilter, fromBlock, currentBlock);

  logger.info(`BridgeBurn events: ${burnEvents.length}`);
  for (const event of burnEvents.slice(-5)) { // Last 5
    const args = event.args;
    if (args) {
      logger.info(`  Block ${event.blockNumber}: ${ethers.formatUnits(args.amount, 18)} OkuM -> chain ${args.destChainId}`);
      logger.info(`    Request ID: ${args.requestId.slice(0, 18)}...`);
    }
  }

  // Query BridgeMint events
  const mintFilter = okuBridge.filters.BridgeMint();
  const mintEvents = await okuBridge.queryFilter(mintFilter, fromBlock, currentBlock);

  logger.info(`BridgeMint events: ${mintEvents.length}`);
  for (const event of mintEvents.slice(-5)) { // Last 5
    const args = event.args;
    if (args) {
      logger.info(`  Block ${event.blockNumber}: ${ethers.formatUnits(args.amount, 18)} OkuM from chain ${args.sourceChainId}`);
      logger.info(`    Request ID: ${args.requestId.slice(0, 18)}...`);
    }
  }

  // ============ OkuBridgeRouter ============
  if (hasAddress(bookKey, "OkuBridgeRouter")) {
    logger.section("OkuBridgeRouter State");

    const routerAddress = loadAddress(bookKey, "OkuBridgeRouter");
    const router = await getDeployedContract("OkuBridgeRouter", routerAddress);
    
    logger.info(`OkuBridgeRouter: ${routerAddress}`);
    
    const routerPaused = await router.paused();
    logger.info(`Paused: ${routerPaused ? "YES" : "NO"}`);

    // Query NativeBridgeInitiated events
    const nativeBridgeFilter = router.filters.NativeBridgeInitiated();
    const nativeBridgeEvents = await router.queryFilter(nativeBridgeFilter, fromBlock, currentBlock);
    logger.info(`NativeBridgeInitiated events: ${nativeBridgeEvents.length}`);
  }

  // ============ Token Balances ============
  logger.section("Bridge Contract Balances");

  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddress);
  const bridgeBalance = await okuMoney.balanceOf(okuBridgeAddress);
  logger.info(`OkuBridge OkuMoney balance: ${ethers.formatUnits(bridgeBalance, 18)} OkuM`);

  if (hasAddress(bookKey, "OkuBridgeRouter")) {
    const routerAddress = loadAddress(bookKey, "OkuBridgeRouter");
    const routerBalance = await okuMoney.balanceOf(routerAddress);
    logger.info(`OkuBridgeRouter OkuMoney balance: ${ethers.formatUnits(routerBalance, 18)} OkuM`);
  }

  logger.section("State Check Complete");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`State check failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
