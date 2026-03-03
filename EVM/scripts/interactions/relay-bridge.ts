/**
 * Bridge relay script for OkuBridge
 *
 * Two modes:
 * 1. Full relay (default): Execute source burn -> sign -> execute dest mint
 * 2. Complete mode (--complete): Read from log file -> execute dest mint only
 *
 * Usage:
 *   Full relay:
 *     SOURCE_NETWORK=optimism DEST_CHAIN_ID=42161 RECIPIENT=0x... SHARES=100 \
 *     npx hardhat run scripts/interactions/relay-bridge.ts --network optimism
 *
 *   Complete from log:
 *     REQUEST_ID=0x... \
 *     npx hardhat run scripts/interactions/relay-bridge.ts --complete --network arbitrum
 */

import { ethers } from "hardhat";
import fs from "fs";
import path from "path";
import { getNetworkName, getChainConfig } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract, waitForTx } from "../utils/deploy";

// ============ Types ============

interface BridgeRequest {
  sourceChainId: bigint;
  destChainId: bigint;
  sender: string;
  recipient: string;
  shares: bigint;
  nonce: bigint;
  deadline: number;
}

interface BridgeLogEntry {
  timestamp: string;
  requestId: string;
  sourceNetwork: string;
  destNetwork: string;
  sourceChainId: string;
  destChainId: string;
  sender: string;
  recipient: string;
  shares: string;
  nonce: string;
  deadline: number;
  signature: string;
  sourceTxHash: string;
  destTxHash?: string;
  status: "pending" | "completed" | "failed";
  networkType: "fork" | "mainnet";
  error?: string;
}

// ============ Constants ============

const BRIDGE_LOG_PATH = path.join(__dirname, "../logs/bridge-requests.jsonl");

// EIP-712 Types
const BRIDGE_REQUEST_TYPES = {
  BridgeRequest: [
    { name: "sourceChainId", type: "uint256" },
    { name: "destChainId", type: "uint256" },
    { name: "sender", type: "address" },
    { name: "recipient", type: "address" },
    { name: "shares", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// ============ Helper Functions ============

/**
 * Ensure logs directory exists
 */
function ensureLogDirectory() {
  const logDir = path.dirname(BRIDGE_LOG_PATH);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
}

/**
 * Append log entry to JSONL file
 */
function appendLogEntry(entry: BridgeLogEntry) {
  ensureLogDirectory();
  fs.appendFileSync(BRIDGE_LOG_PATH, JSON.stringify(entry) + "\n", "utf8");
}

/**
 * Read all log entries
 */
function readLogEntries(): BridgeLogEntry[] {
  if (!fs.existsSync(BRIDGE_LOG_PATH)) {
    return [];
  }

  const content = fs.readFileSync(BRIDGE_LOG_PATH, "utf8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * Find pending log entry by requestId
 */
function findPendingEntry(requestId: string): BridgeLogEntry | undefined {
  const entries = readLogEntries();
  return entries.find(
    (e) => e.requestId === requestId && e.status === "pending"
  );
}

/**
 * Update log entry status
 */
function updateLogEntry(requestId: string, updates: Partial<BridgeLogEntry>) {
  const entries = readLogEntries();
  const updatedEntries = entries.map((entry) =>
    entry.requestId === requestId ? { ...entry, ...updates } : entry
  );

  ensureLogDirectory();
  fs.writeFileSync(
    BRIDGE_LOG_PATH,
    updatedEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8"
  );
}

/**
 * Detect if network is a fork or mainnet
 */
function getNetworkType(chainConfig: any): "fork" | "mainnet" {
  // If running on hardhat network (chainId 31337), it's a fork
  // Otherwise, check if RPC URL contains "localhost" or "127.0.0.1"
  if (
    chainConfig.rpcUrl.includes("localhost") ||
    chainConfig.rpcUrl.includes("127.0.0.1") ||
    chainConfig.chainId === 31337
  ) {
    return "fork";
  }
  return "mainnet";
}

/**
 * Get network name from chain ID
 */
function getNetworkNameFromChainId(chainId: bigint): string {
  const mapping: Record<string, string> = {
    "1": "mainnet",
    "10": "optimism",
    "8453": "base",
    "42161": "arbitrum",
    "31337": "localhost",
  };
  return mapping[chainId.toString()] || `chain-${chainId}`;
}

/**
 * Create EIP-712 domain for destination chain
 */
function createDomain(destChainId: bigint, bridgeAddress: string) {
  return {
    name: "OkuBridge",
    version: "1",
    chainId: destChainId,
    verifyingContract: bridgeAddress,
  };
}

/**
 * Calculate requestId (matches Solidity calculation)
 */
function calculateRequestId(request: BridgeRequest): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "address", "address", "uint256", "uint256", "uint256"],
      [
        request.sourceChainId,
        request.destChainId,
        request.sender,
        request.recipient,
        request.shares,
        request.nonce,
        request.deadline,
      ]
    )
  );
}

// ============ Main Functions ============

/**
 * Execute bridge burn on source chain and capture event
 */
async function executeBridgeBurn(
  sourceNetwork: string,
  destChainId: bigint,
  recipient: string,
  shares: bigint
) {
  logger.section("Step 1: Execute Bridge Burn on Source Chain");

  const sourceChainConfig = getChainConfig(sourceNetwork);
  logger.info(`Source: ${sourceChainConfig.name} (Chain ID: ${sourceChainConfig.chainId})`);
  logger.info(`Destination: Chain ID ${destChainId}`);
  logger.info(`Recipient: ${recipient}`);
  logger.info(`Shares: ${ethers.formatEther(shares)}`);

  // Load contracts
  const okuBridgeAddress = loadAddress(sourceNetwork, "OkuBridge");
  const okuUSDAddress = loadAddress(sourceNetwork, "OkuUSD");
  const okuBridge = await getDeployedContract("OkuBridge", okuBridgeAddress);
  const okuUSD = await getDeployedContract("OkuUSD", okuUSDAddress);

  // Get user signer
  const [user] = await ethers.getSigners();
  logger.info(`User: ${user.address}`);

  // Check balance and fee (subtractive model: fee comes out of input shares)
  const bridgeFee = await okuBridge.bridgeFee();
  const feeShares = (shares * bridgeFee) / 10000n;
  const netShares = shares - feeShares;
  const totalTokens = await okuUSD.sharesToTokens(shares);

  const userBalance = await okuUSD.balanceOf(user.address);
  if (userBalance < totalTokens) {
    logger.error(`Insufficient balance: ${ethers.formatEther(userBalance)} < ${ethers.formatEther(totalTokens)}`);
    logger.info("Mint tokens first using: NETWORK=... AMOUNT=... npx hardhat run scripts/interactions/mint-okuusd.ts");
    process.exit(1);
  }

  logger.info(`Fee: ${ethers.formatEther(feeShares)} shares (${Number(bridgeFee) / 100}%)`);
  logger.info(`Net: ${ethers.formatEther(netShares)} shares, Total: ${ethers.formatEther(shares)} shares (${ethers.formatEther(totalTokens)} tokens)`);

  // Check if destination chain is supported
  const isSupported = await okuBridge.supportedChains(destChainId);
  if (!isSupported) {
    logger.error(`Destination chain ${destChainId} is not supported`);
    logger.info("Add support using admin functions");
    process.exit(1);
  }

  // Get nonce before burn
  const nonceBefore = await okuBridge.outboundNonce(destChainId);
  logger.info(`Current nonce: ${nonceBefore}`);

  // Execute burn
  logger.step(1, "Approving OkuUSD for bridge");
  const allowance = await okuUSD.allowance(user.address, okuBridgeAddress);
  if (allowance < totalTokens) {
    await waitForTx(
      await okuUSD.approve(okuBridgeAddress, totalTokens),
      "Approve tokens"
    );
  } else {
    logger.info("Already approved");
  }

  logger.step(2, "Executing bridgeBurn");
  const burnTx = await okuBridge.bridgeBurn(destChainId, recipient, shares);
  const burnReceipt = await burnTx.wait();
  logger.success(`Transaction: ${burnReceipt.hash}`);

  // Parse event
  logger.step(3, "Parsing BridgeBurn event");
  const burnEvent = burnReceipt.logs
    .map((log: any) => {
      try {
        return okuBridge.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed && parsed.name === "BridgeBurn");

  if (!burnEvent) {
    logger.error("BridgeBurn event not found in transaction logs");
    process.exit(1);
  }

  // Extract event data
  const eventData = {
    requestId: burnEvent.args.requestId,
    sender: burnEvent.args.sender,
    recipient: burnEvent.args.recipient,
    sourceChainId: burnEvent.args.sourceChainId,
    destChainId: burnEvent.args.destChainId,
    shares: burnEvent.args.shares,
    nonce: burnEvent.args.nonce,
  };

  logger.success("Event captured:");
  logger.info(`  Request ID: ${eventData.requestId}`);
  logger.info(`  Sender: ${eventData.sender}`);
  logger.info(`  Recipient: ${eventData.recipient}`);
  logger.info(`  Shares: ${ethers.formatEther(eventData.shares)}`);
  logger.info(`  Nonce: ${eventData.nonce}`);

  return {
    ...eventData,
    txHash: burnReceipt.hash,
    networkType: getNetworkType(sourceChainConfig),
  };
}

/**
 * Sign bridge request with EIP-712
 */
async function signBridgeRequest(
  request: BridgeRequest,
  destNetwork: string
) {
  logger.section("Step 2: Sign Bridge Request with EIP-712");

  // Load destination bridge address
  const destBridgeAddress = loadAddress(destNetwork, "OkuBridge");
  logger.info(`Destination bridge: ${destBridgeAddress}`);

  // Create EIP-712 domain
  const domain = createDomain(request.destChainId, destBridgeAddress);

  // Get orchestrator signer
  const [signer] = await ethers.getSigners();
  logger.info(`Signer: ${signer.address}`);

  // Sign
  const signature = await signer.signTypedData(domain, BRIDGE_REQUEST_TYPES, {
    sourceChainId: request.sourceChainId,
    destChainId: request.destChainId,
    sender: request.sender,
    recipient: request.recipient,
    shares: request.shares,
    nonce: request.nonce,
    deadline: request.deadline,
  });

  logger.success(`Signature: ${signature.slice(0, 20)}...${signature.slice(-10)}`);

  return signature;
}

/**
 * Execute bridge mint on destination chain
 */
async function executeBridgeMint(
  destNetwork: string,
  request: BridgeRequest,
  signature: string
) {
  logger.section("Step 3: Execute Bridge Mint on Destination Chain");

  const destChainConfig = getChainConfig(destNetwork);
  logger.info(`Destination: ${destChainConfig.name} (Chain ID: ${destChainConfig.chainId})`);

  // Load contract
  const destBridgeAddress = loadAddress(destNetwork, "OkuBridge");
  const destBridge = await getDeployedContract("OkuBridge", destBridgeAddress);

  // Check if already processed
  const requestId = calculateRequestId(request);
  const isProcessed = await destBridge.processedRequests(requestId);
  if (isProcessed) {
    logger.warning("Request already processed on destination chain");
    return null;
  }

  // Execute mint
  logger.step(1, "Executing bridgeMint");
  const mintTx = await destBridge.bridgeMint(
    {
      sourceChainId: request.sourceChainId,
      destChainId: request.destChainId,
      sender: request.sender,
      recipient: request.recipient,
      shares: request.shares,
      nonce: request.nonce,
      deadline: request.deadline,
    },
    signature
  );
  const mintReceipt = await mintTx.wait();
  logger.success(`Transaction: ${mintReceipt.hash}`);

  // Verify mint event
  logger.step(2, "Verifying BridgeMint event");
  const mintEvent = mintReceipt.logs
    .map((log: any) => {
      try {
        return destBridge.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed: any) => parsed && parsed.name === "BridgeMint");

  if (!mintEvent) {
    logger.warning("BridgeMint event not found (but tx succeeded)");
  } else {
    logger.success("BridgeMint event confirmed");
  }

  // Verify shares received
  const okuUSDAddress = loadAddress(destNetwork, "OkuUSD");
  const okuUSD = await getDeployedContract("OkuUSD", okuUSDAddress);
  const recipientShares = await okuUSD.sharesOf(request.recipient);
  logger.success(`Recipient shares: ${ethers.formatEther(recipientShares)}`);

  return {
    txHash: mintReceipt.hash,
    networkType: getNetworkType(destChainConfig),
  };
}

/**
 * Main relay function (full flow)
 */
async function relayBridge() {
  logger.section("Bridge Relay: Full Flow");

  // Parse environment variables
  const sourceNetwork = process.env.SOURCE_NETWORK || getNetworkName();
  const destChainIdStr = process.env.DEST_CHAIN_ID;
  const recipientStr = process.env.RECIPIENT;
  const sharesStr = process.env.SHARES || "100";

  if (!destChainIdStr) {
    logger.error("Missing DEST_CHAIN_ID environment variable");
    logger.info("Usage: SOURCE_NETWORK=optimism DEST_CHAIN_ID=42161 RECIPIENT=0x... SHARES=100 npx hardhat run scripts/interactions/relay-bridge.ts");
    process.exit(1);
  }

  if (!recipientStr) {
    logger.error("Missing RECIPIENT environment variable");
    process.exit(1);
  }

  const destChainId = BigInt(destChainIdStr);
  const recipient = ethers.getAddress(recipientStr);
  const shares = ethers.parseEther(sharesStr);

  // Step 1: Execute burn and capture event
  const burnResult = await executeBridgeBurn(
    sourceNetwork,
    destChainId,
    recipient,
    shares
  );

  // Construct bridge request
  const deadline = Math.floor(Date.now() / 1000) + 3600; // 1 hour
  const request: BridgeRequest = {
    sourceChainId: burnResult.sourceChainId,
    destChainId: burnResult.destChainId,
    sender: burnResult.sender,
    recipient: burnResult.recipient,
    shares: burnResult.shares,
    nonce: burnResult.nonce,
    deadline,
  };

  // Calculate requestId
  const requestId = calculateRequestId(request);

  // Step 2: Sign request
  const destNetwork = getNetworkNameFromChainId(destChainId);
  const signature = await signBridgeRequest(request, destNetwork);

  // Step 3: Write to log
  logger.section("Writing to Log File");
  const logEntry: BridgeLogEntry = {
    timestamp: new Date().toISOString(),
    requestId,
    sourceNetwork,
    destNetwork,
    sourceChainId: request.sourceChainId.toString(),
    destChainId: request.destChainId.toString(),
    sender: request.sender,
    recipient: request.recipient,
    shares: request.shares.toString(),
    nonce: request.nonce.toString(),
    deadline: request.deadline,
    signature,
    sourceTxHash: burnResult.txHash,
    status: "pending",
    networkType: burnResult.networkType,
  };
  appendLogEntry(logEntry);
  logger.success(`Log written to: ${BRIDGE_LOG_PATH}`);
  logger.info(`Request ID: ${requestId}`);

  // Step 4: Execute mint
  try {
    const mintResult = await executeBridgeMint(destNetwork, request, signature);

    if (mintResult) {
      // Update log with success
      updateLogEntry(requestId, {
        destTxHash: mintResult.txHash,
        status: "completed",
      });

      logger.section("Bridge Relay Complete!");
      logger.success(`Source tx: ${burnResult.txHash}`);
      logger.success(`Dest tx: ${mintResult.txHash}`);
      logger.info(`Log: ${BRIDGE_LOG_PATH}`);
    }
  } catch (error: any) {
    // Update log with error
    updateLogEntry(requestId, {
      status: "failed",
      error: error.message,
    });

    logger.error(`Bridge mint failed: ${error.message}`);
    logger.warning("Request logged as failed. Retry with --complete flag:");
    logger.info(`REQUEST_ID=${requestId} npx hardhat run scripts/interactions/relay-bridge.ts --complete`);
    throw error;
  }
}

/**
 * Complete pending bridge from log file
 */
async function completePendingBridge() {
  logger.section("Bridge Relay: Complete from Log");

  const requestIdStr = process.env.REQUEST_ID;
  if (!requestIdStr) {
    logger.error("Missing REQUEST_ID environment variable");
    logger.info("Usage: REQUEST_ID=0x... npx hardhat run scripts/interactions/relay-bridge.ts --complete");
    process.exit(1);
  }

  // Find pending entry
  const entry = findPendingEntry(requestIdStr);
  if (!entry) {
    logger.error(`No pending entry found for request ID: ${requestIdStr}`);
    logger.info("Check log file:");
    logger.info(`  ${BRIDGE_LOG_PATH}`);
    process.exit(1);
  }

  logger.info("Found pending bridge request:");
  logger.info(`  Source: ${entry.sourceNetwork}`);
  logger.info(`  Destination: ${entry.destNetwork}`);
  logger.info(`  Shares: ${ethers.formatEther(entry.shares)}`);
  logger.info(`  Source tx: ${entry.sourceTxHash}`);

  // Reconstruct request
  const request: BridgeRequest = {
    sourceChainId: BigInt(entry.sourceChainId),
    destChainId: BigInt(entry.destChainId),
    sender: entry.sender,
    recipient: entry.recipient,
    shares: BigInt(entry.shares),
    nonce: BigInt(entry.nonce),
    deadline: entry.deadline,
  };

  // Execute mint
  try {
    const mintResult = await executeBridgeMint(
      entry.destNetwork,
      request,
      entry.signature
    );

    if (mintResult) {
      // Update log
      updateLogEntry(requestIdStr, {
        destTxHash: mintResult.txHash,
        status: "completed",
      });

      logger.section("Bridge Completed!");
      logger.success(`Destination tx: ${mintResult.txHash}`);
    }
  } catch (error: any) {
    // Update log with error
    updateLogEntry(requestIdStr, {
      status: "failed",
      error: error.message,
    });

    logger.error(`Bridge mint failed: ${error.message}`);
    throw error;
  }
}

// ============ Main ============

async function main() {
  const completeMode = process.argv.includes("--complete");

  if (completeMode) {
    await completePendingBridge();
  } else {
    await relayBridge();
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Script failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
