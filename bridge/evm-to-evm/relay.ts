#!/usr/bin/env ts-node
/**
 * evm-to-evm/relay.ts
 *
 * EVM ↔ EVM bridge relay (standalone ethers, no Hardhat dependency).
 * Port of EVM/scripts/interactions/relay-bridge.ts.
 *
 * Two modes:
 *   1. Full relay (default): bridgeBurn → sign EIP-712 → bridgeMint (same run)
 *   2. Complete mode (--complete): read from JSONL log → bridgeMint only
 *
 * Required env vars:
 *   SOURCE_RPC             - Source chain JSON-RPC URL
 *   DEST_RPC               - Destination chain JSON-RPC URL
 *   EVM_PRIVATE_KEY        - User private key (source chain burn)
 *   EVM_ORCHESTRATOR_PRIVATE_KEY - Orchestrator private key (dest chain mint + signing)
 *   SOURCE_OKUBRIDGE        - OkuBridge address on source chain
 *   SOURCE_OKUUSD           - OkuUSD address on source chain
 *   DEST_OKUBRIDGE          - OkuBridge address on destination chain
 *   DEST_OKUUSD             - OkuUSD address on destination chain
 *   RECIPIENT              - Destination chain recipient address (0x...)
 *   SHARES                 - Shares to bridge (e.g. "1000000000000000000" = 1 share)
 *   DEST_CHAIN_ID          - Destination chain ID (uint256 as string)
 *
 * Optional env vars:
 *   REQUEST_ID             - (--complete mode) request ID from JSONL log
 *   LOG_PATH               - Override default log file path
 *
 * Usage — full relay:
 *   SOURCE_RPC=http://127.0.0.1:8545 \
 *   DEST_RPC=http://127.0.0.1:8546 \
 *   EVM_PRIVATE_KEY=0x... \
 *   EVM_ORCHESTRATOR_PRIVATE_KEY=0x... \
 *   SOURCE_OKUBRIDGE=0x... SOURCE_OKUUSD=0x... \
 *   DEST_OKUBRIDGE=0x... DEST_OKUUSD=0x... \
 *   RECIPIENT=0x... SHARES=1000000000000000000 DEST_CHAIN_ID=42161 \
 *   ts-node evm-to-evm/relay.ts
 *
 * Usage — complete pending:
 *   EVM_ORCHESTRATOR_PRIVATE_KEY=0x... \
 *   DEST_RPC=http://... \
 *   DEST_OKUBRIDGE=0x... \
 *   REQUEST_ID=0x... \
 *   ts-node evm-to-evm/relay.ts --complete
 */

import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import * as path from "path";
import { ethers } from "ethers";
import {
  OKUBRIDGE_ABI,
  OKUUSD_ABI,
  BRIDGE_REQUEST_TYPES,
  PENDING_DIR,
} from "../config";

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
  error?: string;
}

// ============ Log helpers ============

const LOG_PATH =
  process.env.LOG_PATH ||
  path.join(PENDING_DIR, "evm-to-evm.jsonl");

function ensureLogDir() {
  fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
}

function appendLog(entry: BridgeLogEntry) {
  ensureLogDir();
  fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + "\n", "utf-8");
}

function readLogs(): BridgeLogEntry[] {
  if (!fs.existsSync(LOG_PATH)) return [];
  return fs
    .readFileSync(LOG_PATH, "utf-8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

function updateLog(requestId: string, updates: Partial<BridgeLogEntry>) {
  ensureLogDir();
  const entries = readLogs().map((e) =>
    e.requestId === requestId ? { ...e, ...updates } : e
  );
  fs.writeFileSync(
    LOG_PATH,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8"
  );
}

function findPending(requestId: string): BridgeLogEntry | undefined {
  return readLogs().find(
    (e) => e.requestId === requestId && e.status === "pending"
  );
}

// ============ Core helpers ============

function buildDomain(destChainId: bigint, bridgeAddress: string) {
  return {
    name: "OkuBridge",
    version: "1",
    chainId: destChainId,
    verifyingContract: bridgeAddress,
  };
}

function calculateRequestId(req: BridgeRequest): string {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      [
        "uint256",
        "uint256",
        "address",
        "address",
        "uint256",
        "uint256",
        "uint256",
      ],
      [
        req.sourceChainId,
        req.destChainId,
        req.sender,
        req.recipient,
        req.shares,
        req.nonce,
        req.deadline,
      ]
    )
  );
}

// ============ Steps ============

async function executeBurn(
  sourceRpc: string,
  privateKey: string,
  bridgeAddress: string,
  okuusdAddress: string,
  destChainId: bigint,
  recipient: string,
  shares: bigint
): Promise<{
  sourceChainId: bigint;
  destChainId: bigint;
  sender: string;
  recipient: string;
  shares: bigint;
  nonce: bigint;
  txHash: string;
}> {
  console.log("--- Step 1: bridgeBurn ---");
  const provider = new ethers.JsonRpcProvider(sourceRpc);
  const wallet = new ethers.Wallet(privateKey, provider);
  const network = await provider.getNetwork();

  const okuBridge = new ethers.Contract(bridgeAddress, OKUBRIDGE_ABI, wallet);
  const okuUsd = new ethers.Contract(okuusdAddress, OKUUSD_ABI, wallet);

  // Verify chain is supported
  const supported = await okuBridge.supportedChains(destChainId);
  if (!supported) {
    throw new Error(`Destination chain ${destChainId} not supported on source bridge`);
  }

  // Check & approve allowance
  const tokenAmount = await okuUsd.sharesToTokens(shares);
  const allowance: bigint = await okuUsd.allowance(wallet.address, bridgeAddress);
  if (allowance < tokenAmount) {
    console.log("Approving OkuUSD...");
    const tx = await okuUsd.approve(bridgeAddress, tokenAmount);
    await tx.wait();
  }

  // Burn
  console.log(
    `Burning ${shares} shares → dest chain ${destChainId} → recipient ${recipient}`
  );
  const burnTx = await okuBridge.bridgeBurn(destChainId, recipient, shares);
  const receipt = await burnTx.wait();
  console.log(`Burn tx: ${receipt.hash}`);

  // Parse event
  const iface = new ethers.Interface(OKUBRIDGE_ABI);
  let event: ethers.LogDescription | null = null;
  for (const log of receipt.logs) {
    try {
      const parsed = iface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed?.name === "BridgeBurn") {
        event = parsed;
        break;
      }
    } catch { /* skip */ }
  }
  if (!event) throw new Error("BridgeBurn event not found");

  console.log(`Nonce: ${event.args.nonce}`);

  return {
    sourceChainId: BigInt(network.chainId),
    destChainId: event.args.destChainId,
    sender: event.args.sender,
    recipient: event.args.recipient,
    shares: event.args.shares,
    nonce: event.args.nonce,
    txHash: receipt.hash,
  };
}

async function signRequest(
  orchestratorKey: string,
  request: BridgeRequest,
  destBridgeAddress: string
): Promise<string> {
  console.log("--- Step 2: EIP-712 sign ---");
  const provider = new ethers.JsonRpcProvider(process.env.DEST_RPC!);
  const orchestrator = new ethers.Wallet(orchestratorKey, provider);
  const domain = buildDomain(request.destChainId, destBridgeAddress);
  const sig = await orchestrator.signTypedData(domain, BRIDGE_REQUEST_TYPES, {
    sourceChainId: request.sourceChainId,
    destChainId: request.destChainId,
    sender: request.sender,
    recipient: request.recipient,
    shares: request.shares,
    nonce: request.nonce,
    deadline: request.deadline,
  });
  console.log(`Signature: ${sig.slice(0, 20)}...${sig.slice(-10)}`);
  return sig;
}

async function executeMint(
  destRpc: string,
  orchestratorKey: string,
  bridgeAddress: string,
  okuusdAddress: string,
  request: BridgeRequest,
  signature: string
): Promise<string> {
  console.log("--- Step 3: bridgeMint ---");
  const provider = new ethers.JsonRpcProvider(destRpc);
  const orchestrator = new ethers.Wallet(orchestratorKey, provider);
  const okuBridge = new ethers.Contract(bridgeAddress, OKUBRIDGE_ABI, orchestrator);

  const requestId = calculateRequestId(request);
  const processed = await okuBridge.processedRequests(requestId);
  if (processed) {
    console.log("Already processed — skipping mint.");
    return "already-processed";
  }

  const mintTx = await okuBridge.bridgeMint(
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
  const receipt = await mintTx.wait();
  console.log(`Mint tx: ${receipt.hash}`);
  return receipt.hash;
}

// ============ Main flows ============

async function fullRelay() {
  console.log("=== EVM → EVM Bridge Relay (full) ===\n");

  const sourceRpc = process.env.SOURCE_RPC!;
  const destRpc = process.env.DEST_RPC!;
  const privateKey = process.env.EVM_PRIVATE_KEY!;
  const orchestratorKey =
    process.env.EVM_ORCHESTRATOR_PRIVATE_KEY || privateKey;
  const srcBridge = process.env.SOURCE_OKUBRIDGE!;
  const srcOkuusd = process.env.SOURCE_OKUUSD!;
  const destBridge = process.env.DEST_OKUBRIDGE!;
  const recipient = ethers.getAddress(process.env.RECIPIENT!);
  const shares = BigInt(process.env.SHARES!);
  const destChainId = BigInt(process.env.DEST_CHAIN_ID!);

  for (const [k, v] of Object.entries({
    SOURCE_RPC: sourceRpc,
    DEST_RPC: destRpc,
    EVM_PRIVATE_KEY: privateKey,
    SOURCE_OKUBRIDGE: srcBridge,
    SOURCE_OKUUSD: srcOkuusd,
    DEST_OKUBRIDGE: destBridge,
    RECIPIENT: recipient,
    SHARES: shares.toString(),
    DEST_CHAIN_ID: destChainId.toString(),
  })) {
    if (!v) {
      console.error(`Missing required env var: ${k}`);
      process.exit(1);
    }
  }

  const deadline = Math.floor(Date.now() / 1000) + 3600;

  const burnResult = await executeBurn(
    sourceRpc,
    privateKey,
    srcBridge,
    srcOkuusd,
    destChainId,
    recipient,
    shares
  );

  const request: BridgeRequest = {
    sourceChainId: burnResult.sourceChainId,
    destChainId: burnResult.destChainId,
    sender: burnResult.sender,
    recipient: burnResult.recipient,
    shares: burnResult.shares,
    nonce: burnResult.nonce,
    deadline,
  };

  const requestId = calculateRequestId(request);
  const signature = await signRequest(orchestratorKey, request, destBridge);

  // Write to JSONL log
  const entry: BridgeLogEntry = {
    timestamp: new Date().toISOString(),
    requestId,
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
  };
  appendLog(entry);
  console.log(`\nLog written: ${LOG_PATH}`);
  console.log(`Request ID: ${requestId}`);

  try {
    const destTxHash = await executeMint(
      destRpc,
      orchestratorKey,
      destBridge,
      process.env.DEST_OKUUSD!,
      request,
      signature
    );
    updateLog(requestId, { destTxHash, status: "completed" });
    console.log(`\n✓ Relay complete!`);
    console.log(`  Source: ${burnResult.txHash}`);
    console.log(`  Dest:   ${destTxHash}`);
  } catch (err: any) {
    updateLog(requestId, { status: "failed", error: err.message });
    console.error(`\nMint failed: ${err.message}`);
    console.error(
      `Retry with: REQUEST_ID=${requestId} ts-node evm-to-evm/relay.ts --complete`
    );
    throw err;
  }
}

async function completePending() {
  console.log("=== EVM → EVM Bridge Relay (complete pending) ===\n");

  const requestId = process.env.REQUEST_ID;
  if (!requestId) {
    console.error("Missing REQUEST_ID environment variable");
    process.exit(1);
  }

  const entry = findPending(requestId);
  if (!entry) {
    console.error(`No pending entry found for REQUEST_ID=${requestId}`);
    process.exit(1);
  }

  const destRpc = process.env.DEST_RPC!;
  const orchestratorKey = process.env.EVM_ORCHESTRATOR_PRIVATE_KEY!;
  const destBridge = process.env.DEST_OKUBRIDGE!;

  const request: BridgeRequest = {
    sourceChainId: BigInt(entry.sourceChainId),
    destChainId: BigInt(entry.destChainId),
    sender: entry.sender,
    recipient: entry.recipient,
    shares: BigInt(entry.shares),
    nonce: BigInt(entry.nonce),
    deadline: entry.deadline,
  };

  try {
    const destTxHash = await executeMint(
      destRpc,
      orchestratorKey,
      destBridge,
      process.env.DEST_OKUUSD || "",
      request,
      entry.signature
    );
    updateLog(requestId, { destTxHash, status: "completed" });
    console.log(`\n✓ Bridge completed! Dest tx: ${destTxHash}`);
  } catch (err: any) {
    updateLog(requestId, { status: "failed", error: err.message });
    console.error(`Mint failed: ${err.message}`);
    throw err;
  }
}

// ============ Entry ============

async function main() {
  if (process.argv.includes("--complete")) {
    await completePending();
  } else {
    await fullRelay();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
