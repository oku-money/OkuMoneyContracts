#!/usr/bin/env ts-node
/**
 * svm-to-evm/2-mint.ts
 *
 * Step 2 of Solana → EVM bridge:
 *   - Reads pending/svm-to-evm.json written by step 1
 *   - Signs a BridgeRequest with EIP-712 (orchestrator ECDSA key)
 *   - Calls bridgeMint on the EVM OkuBridge
 *   - Updates the handoff file: status = "completed"
 *
 * Required env vars:
 *   EVM_RPC                        - EVM JSON-RPC URL
 *   EVM_ORCHESTRATOR_PRIVATE_KEY   - Orchestrator ECDSA private key (hex, 0x-prefixed)
 *   OKUBRIDGE_ADDRESS              - OkuBridge proxy address on EVM
 *
 * Usage:
 *   EVM_RPC=http://127.0.0.1:8545 \
 *   EVM_ORCHESTRATOR_PRIVATE_KEY=0x... \
 *   OKUBRIDGE_ADDRESS=0x... \
 *   ts-node svm-to-evm/2-mint.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import * as fs from "fs";
import { ethers } from "ethers";
import {
  getEvmRpc,
  getEvmOrchestratorPrivateKey,
  getOkuBridgeAddress,
  BRIDGE_REQUEST_TYPES,
  OKUBRIDGE_ABI,
  SVM_TO_EVM_PENDING,
} from "../config";

// ============ Types ============

interface SvmToEvmHandoff {
  direction: "svm-to-evm";
  sourceTxHash: string;
  sourceChainIdBridge: number;
  destChainId: number;
  solanaSender: string;
  evmRecipient: string;
  amount: string;
  shares: string;
  nonce: string;
  deadline: number;
  status: "pending" | "completed" | "failed";
  destTxHash?: string;
}

// ============ Helpers ============

/**
 * Derive the EIP-712 domain for the destination OkuBridge.
 * The domain uses the actual EVM chain ID and the bridge contract address.
 */
function buildDomain(destChainId: number, bridgeAddress: string) {
  return {
    name: "OkuBridge",
    version: "1",
    chainId: destChainId,
    verifyingContract: bridgeAddress,
  };
}

/**
 * Encode a Solana pubkey (base58) as a 20-byte EVM address placeholder.
 * Takes the first 20 bytes of the base58-decoded pubkey.
 * This is only used for the `sender` field in the BridgeRequest struct,
 * which is used for event tracking but not for fund routing.
 */
function solanaPubkeyToEvmAddress(base58Pubkey: string): string {
  const { PublicKey } = require("@solana/web3.js") as typeof import("@solana/web3.js");
  const bytes = new PublicKey(base58Pubkey).toBytes();
  return ethers.getAddress("0x" + Buffer.from(bytes.slice(0, 20)).toString("hex"));
}

// ============ Main ============

async function main() {
  // Load handoff file
  if (!fs.existsSync(SVM_TO_EVM_PENDING)) {
    console.error(`Handoff file not found: ${SVM_TO_EVM_PENDING}`);
    console.error("Run svm-to-evm/1-burn.ts first.");
    process.exit(1);
  }

  const handoff: SvmToEvmHandoff = JSON.parse(
    fs.readFileSync(SVM_TO_EVM_PENDING, "utf-8")
  );

  if (handoff.status !== "pending") {
    console.error(`Handoff status is "${handoff.status}", expected "pending".`);
    process.exit(1);
  }

  // Check deadline
  const now = Math.floor(Date.now() / 1000);
  if (now > handoff.deadline) {
    console.error(
      `Handoff deadline has passed (${new Date(handoff.deadline * 1000).toISOString()}).` +
        " Re-run step 1 to create a fresh burn."
    );
    process.exit(1);
  }

  console.log("=== Solana → EVM Bridge: Step 2 (Mint) ===");
  console.log(`Source tx:     ${handoff.sourceTxHash}`);
  console.log(`Solana sender: ${handoff.solanaSender}`);
  console.log(`EVM recipient: ${handoff.evmRecipient}`);
  console.log(`Shares:        ${handoff.shares}`);
  console.log(`Amount:        ${handoff.amount}`);
  console.log(`Nonce:         ${handoff.nonce}`);
  console.log(`Dest chain:    ${handoff.destChainId}`);
  console.log(`Deadline:      ${new Date(handoff.deadline * 1000).toISOString()}`);
  console.log("");

  const evmRpc = getEvmRpc();
  const orchestratorKey = getEvmOrchestratorPrivateKey();
  const bridgeAddress = getOkuBridgeAddress();

  // Connect to EVM
  const provider = new ethers.JsonRpcProvider(evmRpc);
  const orchestrator = new ethers.Wallet(orchestratorKey, provider);
  const network = await provider.getNetwork();
  const actualChainId = Number(network.chainId);

  console.log(`EVM RPC:       ${evmRpc}`);
  console.log(`Orchestrator:  ${orchestrator.address}`);
  console.log(`Chain ID:      ${actualChainId}`);
  console.log(`OkuBridge:     ${bridgeAddress}`);

  // Verify the orchestrator matches the bridge's authorizedSigner
  const okuBridge = new ethers.Contract(bridgeAddress, OKUBRIDGE_ABI, orchestrator);
  const authorizedSigner = await okuBridge.authorizedSigner();
  if (authorizedSigner.toLowerCase() !== orchestrator.address.toLowerCase()) {
    console.error(
      `Orchestrator mismatch: bridge.authorizedSigner=${authorizedSigner}, ` +
        `orchestrator=${orchestrator.address}`
    );
    process.exit(1);
  }
  console.log(`\nAuthorized signer matches ✓`);

  // Check if request already processed
  // Re-create the request_id by hashing the bridge request params
  // (The EVM contract calculates requestId as keccak256 of ABI-encoded fields)
  const evmSenderAddress = solanaPubkeyToEvmAddress(handoff.solanaSender);
  const recipientAddress = ethers.getAddress(handoff.evmRecipient);

  const bridgeRequest = {
    sourceChainId: BigInt(handoff.sourceChainIdBridge),
    destChainId: BigInt(handoff.destChainId),
    sender: evmSenderAddress,
    recipient: recipientAddress,
    shares: BigInt(handoff.shares),
    nonce: BigInt(handoff.nonce),
    deadline: BigInt(handoff.deadline),
  };

  const requestId = ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["uint256", "uint256", "address", "address", "uint256", "uint256", "uint256"],
      [
        bridgeRequest.sourceChainId,
        bridgeRequest.destChainId,
        bridgeRequest.sender,
        bridgeRequest.recipient,
        bridgeRequest.shares,
        bridgeRequest.nonce,
        bridgeRequest.deadline,
      ]
    )
  );

  const alreadyProcessed = await okuBridge.processedRequests(requestId);
  if (alreadyProcessed) {
    console.error(`Request ${requestId} has already been processed on EVM.`);
    handoff.status = "completed";
    fs.writeFileSync(SVM_TO_EVM_PENDING, JSON.stringify(handoff, null, 2));
    process.exit(0);
  }

  // Build EIP-712 domain for the destination chain
  const domain = buildDomain(handoff.destChainId, bridgeAddress);

  console.log(`\nSigning EIP-712 BridgeRequest...`);
  console.log(`  sourceChainId: ${bridgeRequest.sourceChainId}`);
  console.log(`  destChainId:   ${bridgeRequest.destChainId}`);
  console.log(`  sender:        ${bridgeRequest.sender}`);
  console.log(`  recipient:     ${bridgeRequest.recipient}`);
  console.log(`  shares:        ${bridgeRequest.shares}`);
  console.log(`  nonce:         ${bridgeRequest.nonce}`);
  console.log(`  deadline:      ${bridgeRequest.deadline}`);

  const signature = await orchestrator.signTypedData(
    domain,
    BRIDGE_REQUEST_TYPES,
    bridgeRequest
  );
  console.log(`Signature: ${signature.slice(0, 20)}...${signature.slice(-10)}`);

  // Call bridgeMint
  console.log(`\nCalling bridgeMint...`);
  const mintTx = await okuBridge.bridgeMint(
    {
      sourceChainId: bridgeRequest.sourceChainId,
      destChainId: bridgeRequest.destChainId,
      sender: bridgeRequest.sender,
      recipient: bridgeRequest.recipient,
      shares: bridgeRequest.shares,
      nonce: bridgeRequest.nonce,
      deadline: bridgeRequest.deadline,
    },
    signature
  );
  const mintReceipt = await mintTx.wait();
  console.log(`\n✓ Bridge mint confirmed!`);
  console.log(`  EVM tx:   ${mintReceipt.hash}`);

  // Update handoff file
  handoff.status = "completed";
  handoff.destTxHash = mintReceipt.hash;
  fs.writeFileSync(SVM_TO_EVM_PENDING, JSON.stringify(handoff, null, 2));
  console.log(`\n✓ Handoff file updated: ${SVM_TO_EVM_PENDING}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
