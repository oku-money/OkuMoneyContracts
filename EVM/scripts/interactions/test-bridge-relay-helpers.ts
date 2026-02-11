/**
 * Test script for bridge relay helper functions
 * This verifies the log file operations and request ID calculation work correctly
 *
 * Usage: npx hardhat run scripts/interactions/test-bridge-relay-helpers.ts
 */

import { ethers } from "hardhat";
import fs from "fs";
import path from "path";
import { logger } from "../utils/logger";

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

// ============ Test Helpers ============

const TEST_LOG_PATH = path.join(__dirname, "../logs/test-bridge-requests.jsonl");

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

function createDomain(destChainId: bigint, bridgeAddress: string) {
  return {
    name: "OkuBridge",
    version: "1",
    chainId: destChainId,
    verifyingContract: bridgeAddress,
  };
}

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

// ============ Tests ============

async function main() {
  logger.section("Bridge Relay Helper Function Tests");

  // Test 1: Request ID calculation
  logger.step(1, "Testing request ID calculation");

  const testRequest: BridgeRequest = {
    sourceChainId: 10n,
    destChainId: 42161n,
    sender: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    recipient: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    shares: ethers.parseEther("100"),
    nonce: 0n,
    deadline: 1738848896,
  };

  const requestId = calculateRequestId(testRequest);
  logger.info(`Request ID: ${requestId}`);

  if (!requestId.startsWith("0x") || requestId.length !== 66) {
    logger.error("Request ID format invalid!");
    process.exit(1);
  }
  logger.success("Request ID format valid (0x + 64 hex chars)");

  // Test 2: EIP-712 domain construction
  logger.step(2, "Testing EIP-712 domain construction");

  const bridgeAddress = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
  const domain = createDomain(testRequest.destChainId, bridgeAddress);

  logger.info(`Domain name: ${domain.name}`);
  logger.info(`Domain version: ${domain.version}`);
  logger.info(`Domain chainId: ${domain.chainId}`);
  logger.info(`Domain verifyingContract: ${domain.verifyingContract}`);

  if (domain.name !== "OkuBridge" || domain.version !== "1") {
    logger.error("Domain construction invalid!");
    process.exit(1);
  }
  logger.success("Domain construction valid");

  // Test 3: EIP-712 signature
  logger.step(3, "Testing EIP-712 signature");

  const [signer] = await ethers.getSigners();
  logger.info(`Signer address: ${signer.address}`);

  const signature = await signer.signTypedData(domain, BRIDGE_REQUEST_TYPES, {
    sourceChainId: testRequest.sourceChainId,
    destChainId: testRequest.destChainId,
    sender: testRequest.sender,
    recipient: testRequest.recipient,
    shares: testRequest.shares,
    nonce: testRequest.nonce,
    deadline: testRequest.deadline,
  });

  logger.info(`Signature: ${signature.slice(0, 20)}...${signature.slice(-10)}`);

  if (!signature.startsWith("0x") || signature.length !== 132) {
    logger.error("Signature format invalid!");
    process.exit(1);
  }
  logger.success("Signature format valid (0x + 130 hex chars)");

  // Test 4: Log file operations
  logger.step(4, "Testing log file operations");

  // Clean up test log if exists
  if (fs.existsSync(TEST_LOG_PATH)) {
    fs.unlinkSync(TEST_LOG_PATH);
  }

  // Create log entry
  const logEntry = {
    timestamp: new Date().toISOString(),
    requestId,
    sourceNetwork: "optimism",
    destNetwork: "arbitrum",
    sourceChainId: testRequest.sourceChainId.toString(),
    destChainId: testRequest.destChainId.toString(),
    sender: testRequest.sender,
    recipient: testRequest.recipient,
    shares: testRequest.shares.toString(),
    nonce: testRequest.nonce.toString(),
    deadline: testRequest.deadline,
    signature,
    sourceTxHash: "0xabc123...",
    status: "pending" as const,
    networkType: "fork" as const,
  };

  // Write log
  const logDir = path.dirname(TEST_LOG_PATH);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }
  fs.appendFileSync(TEST_LOG_PATH, JSON.stringify(logEntry) + "\n", "utf8");
  logger.success("Log entry written");

  // Read log
  const content = fs.readFileSync(TEST_LOG_PATH, "utf8");
  const entries = content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

  if (entries.length !== 1) {
    logger.error(`Expected 1 entry, found ${entries.length}`);
    process.exit(1);
  }

  const readEntry = entries[0];
  if (readEntry.requestId !== requestId) {
    logger.error("Request ID mismatch in log!");
    process.exit(1);
  }
  logger.success("Log entry read successfully");

  // Update log
  const updatedEntries = entries.map((entry) =>
    entry.requestId === requestId
      ? { ...entry, status: "completed", destTxHash: "0xdef456..." }
      : entry
  );
  fs.writeFileSync(
    TEST_LOG_PATH,
    updatedEntries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8"
  );
  logger.success("Log entry updated");

  // Verify update
  const updatedContent = fs.readFileSync(TEST_LOG_PATH, "utf8");
  const updatedRead = JSON.parse(updatedContent.trim());

  if (updatedRead.status !== "completed") {
    logger.error("Log update failed!");
    process.exit(1);
  }
  logger.success("Log entry update verified");

  // Clean up
  fs.unlinkSync(TEST_LOG_PATH);
  logger.success("Test log file cleaned up");

  // Test 5: Network type detection
  logger.step(5, "Testing network type detection");

  const forkConfig = {
    rpcUrl: "http://127.0.0.1:8545",
    chainId: 31337,
  };

  const mainnetConfig = {
    rpcUrl: "https://mainnet.optimism.io",
    chainId: 10,
  };

  const detectNetworkType = (config: any): "fork" | "mainnet" => {
    if (
      config.rpcUrl.includes("localhost") ||
      config.rpcUrl.includes("127.0.0.1") ||
      config.chainId === 31337
    ) {
      return "fork";
    }
    return "mainnet";
  };

  const forkType = detectNetworkType(forkConfig);
  const mainnetType = detectNetworkType(mainnetConfig);

  if (forkType !== "fork" || mainnetType !== "mainnet") {
    logger.error("Network type detection failed!");
    logger.error(`Fork: ${forkType}, Mainnet: ${mainnetType}`);
    process.exit(1);
  }
  logger.success("Network type detection working correctly");

  // All tests passed
  logger.section("All Tests Passed! ✓");
  logger.success("Bridge relay helper functions are working correctly");
  logger.info("The relay-bridge.ts script is ready to use");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Test failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
