#!/usr/bin/env ts-node
/**
 * evm-to-svm/1-burn.ts
 *
 * Step 1 of EVM → Solana bridge:
 *   - Approves OkuUSD for OkuBridge (if needed)
 *   - Calls bridgeBurn on the EVM OkuBridge
 *   - Parses the BridgeBurn event
 *   - Writes pending/evm-to-svm.json for step 2
 *
 * Required env vars:
 *   EVM_RPC             - EVM JSON-RPC URL (e.g. http://127.0.0.1:8545 for local fork)
 *   EVM_PRIVATE_KEY     - Hex private key of the user wallet
 *   OKUBRIDGE_ADDRESS   - OkuBridge proxy address on EVM
 *   OKUUSD_ADDRESS      - OkuUSD proxy address on EVM
 *   SOLANA_RECIPIENT    - Base58 Solana wallet pubkey (destination)
 *   AMOUNT              - Token amount to bridge (e.g. "10" for 10 OkuUSD)
 *
 * Optional env vars:
 *   SOLANA_CHAIN_ID     - Override Solana bridge chain ID (default: 1151)
 *
 * Usage (local Hardhat fork):
 *   EVM_RPC=http://127.0.0.1:8545 \
 *   EVM_PRIVATE_KEY=0x... \
 *   OKUBRIDGE_ADDRESS=0x... \
 *   OKUUSD_ADDRESS=0x... \
 *   SOLANA_RECIPIENT=<base58> \
 *   AMOUNT=10 \
 *   ts-node evm-to-svm/1-burn.ts
 */

import * as dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { PublicKey } from "@solana/web3.js";
import {
  getEvmRpc,
  getEvmPrivateKey,
  getOkuBridgeAddress,
  getOkuUsdAddress,
  SOLANA_BRIDGE_CHAIN_ID,
  OKUBRIDGE_ABI,
  OKUUSD_ABI,
  EVM_TO_SVM_PENDING,
  PENDING_DIR,
} from "../config";

// ============ Types ============

interface EvmToSvmHandoff {
  direction: "evm-to-svm";
  sourceTxHash: string;
  sourceChainId: number;
  destChainIdBridge: number;
  evmSender: string;
  solanaRecipient: string;
  shares: string;
  amount: string;
  nonce: string;
  deadline: number;
  status: "pending" | "completed" | "failed";
  destTxHash?: string;
}

// ============ Main ============

async function main() {
  // Parse inputs
  const evmRpc = getEvmRpc();
  const privateKey = getEvmPrivateKey();
  const okubridgeAddress = getOkuBridgeAddress();
  const okuusdAddress = getOkuUsdAddress();

  const solanaRecipientStr = process.env.SOLANA_RECIPIENT;
  if (!solanaRecipientStr) {
    console.error("Missing SOLANA_RECIPIENT environment variable");
    process.exit(1);
  }

  const amountStr = process.env.AMOUNT;
  if (!amountStr) {
    console.error("Missing AMOUNT environment variable");
    process.exit(1);
  }

  const destChainIdBridge = parseInt(
    process.env.SOLANA_CHAIN_ID || String(SOLANA_BRIDGE_CHAIN_ID),
    10
  );

  // Validate Solana recipient
  let solanaRecipient: PublicKey;
  try {
    solanaRecipient = new PublicKey(solanaRecipientStr);
  } catch {
    console.error(`Invalid SOLANA_RECIPIENT: ${solanaRecipientStr}`);
    process.exit(1);
  }

  console.log("=== EVM → Solana Bridge: Step 1 (Burn) ===");
  console.log(`EVM RPC:          ${evmRpc}`);
  console.log(`OkuBridge:        ${okubridgeAddress}`);
  console.log(`OkuUSD:           ${okuusdAddress}`);
  console.log(`Solana recipient: ${solanaRecipient.toBase58()}`);
  console.log(`Amount:           ${amountStr} OkuUSD`);
  console.log(`Dest chain ID:    ${destChainIdBridge} (Solana bridge ID)`);
  console.log("");

  // Connect to EVM
  const provider = new ethers.JsonRpcProvider(evmRpc);
  const wallet = new ethers.Wallet(privateKey, provider);
  const network = await provider.getNetwork();
  const sourceChainId = Number(network.chainId);

  console.log(`Connected to chain ID: ${sourceChainId}`);
  console.log(`User address: ${wallet.address}`);

  // Load contracts
  const okuBridge = new ethers.Contract(okubridgeAddress, OKUBRIDGE_ABI, wallet);
  const okuUsd = new ethers.Contract(okuusdAddress, OKUUSD_ABI, wallet);

  // Verify destination chain is supported
  const isSupported = await okuBridge.supportedChains(destChainIdBridge);
  if (!isSupported) {
    console.error(
      `Destination chain ${destChainIdBridge} is not supported by OkuBridge.` +
        ` Add it via bridge.supportedChains or admin functions.`
    );
    process.exit(1);
  }

  // Convert token amount to shares
  const tokenAmount = ethers.parseUnits(amountStr, 6); // OkuUSD has 6 decimals
  const shares = await okuUsd.tokensToShares(tokenAmount);
  console.log(`Token amount: ${tokenAmount} (raw)`);
  console.log(`Shares:       ${shares} (raw)`);

  // Check balance
  const balance = await okuUsd.balanceOf(wallet.address);
  if (balance < tokenAmount) {
    console.error(
      `Insufficient OkuUSD balance: ${ethers.formatUnits(balance, 6)} < ${amountStr}`
    );
    process.exit(1);
  }

  // Approve if needed
  const allowance = await okuUsd.allowance(wallet.address, okubridgeAddress);
  if (allowance < tokenAmount) {
    console.log("Approving OkuUSD for OkuBridge...");
    const approveTx = await okuUsd.approve(okubridgeAddress, tokenAmount);
    const approveReceipt = await approveTx.wait();
    console.log(`Approve tx: ${approveReceipt.hash}`);
  } else {
    console.log("OkuUSD already approved.");
  }

  // The EVM bridgeBurn `recipient` for EVM→SVM uses the first 20 bytes of the
  // Solana wallet pubkey as a placeholder.  The real 32-byte recipient (ATA) is
  // supplied by the orchestrator in step 2 via the 80-byte SVM message.
  const recipientBytes = solanaRecipient.toBytes();
  const recipientAddress = ethers.getAddress(
    "0x" + Buffer.from(recipientBytes.slice(0, 20)).toString("hex")
  );

  // Get nonce before burn (for reference)
  const nonceBefore = await okuBridge.outboundNonce(destChainIdBridge);
  console.log(`\nOutbound nonce before: ${nonceBefore}`);

  // Execute bridgeBurn
  console.log(`Calling bridgeBurn(destChainId=${destChainIdBridge}, recipient=${recipientAddress}, shares=${shares})...`);
  const burnTx = await okuBridge.bridgeBurn(destChainIdBridge, recipientAddress, shares);
  const burnReceipt = await burnTx.wait();
  console.log(`Burn tx: ${burnReceipt.hash}`);

  // Parse BridgeBurn event
  const okuBridgeIface = new ethers.Interface(OKUBRIDGE_ABI);
  let burnEvent: ethers.LogDescription | null = null;
  for (const log of burnReceipt.logs) {
    try {
      const parsed = okuBridgeIface.parseLog({ topics: log.topics as string[], data: log.data });
      if (parsed && parsed.name === "BridgeBurn") {
        burnEvent = parsed;
        break;
      }
    } catch {
      // skip unparseable logs
    }
  }

  if (!burnEvent) {
    console.error("BridgeBurn event not found in receipt logs");
    process.exit(1);
  }

  const eventShares: bigint = burnEvent.args.shares;
  const eventNonce: bigint = burnEvent.args.nonce;
  const eventSender: string = burnEvent.args.sender;

  console.log(`\nBridgeBurn event:`);
  console.log(`  requestId: ${burnEvent.args.requestId}`);
  console.log(`  sender:    ${eventSender}`);
  console.log(`  shares:    ${eventShares}`);
  console.log(`  nonce:     ${eventNonce}`);

  // Read rewardMultiplier to convert shares → token amount for the SVM message
  const rewardMultiplier: bigint = await okuUsd.rewardMultiplier();
  const PRECISION = BigInt("1000000000000000000"); // 1e18
  const svmAmount = (eventShares * rewardMultiplier) / PRECISION;
  console.log(`\nrewardMultiplier: ${rewardMultiplier}`);
  console.log(`SVM token amount: ${svmAmount} (raw, 6 decimals)`);

  // Set deadline: 1 hour from now
  const deadline = Math.floor(Date.now() / 1000) + 3600;

  // Write handoff file
  fs.mkdirSync(PENDING_DIR, { recursive: true });

  const handoff: EvmToSvmHandoff = {
    direction: "evm-to-svm",
    sourceTxHash: burnReceipt.hash,
    sourceChainId,
    destChainIdBridge,
    evmSender: eventSender,
    solanaRecipient: solanaRecipient.toBase58(),
    shares: eventShares.toString(),
    amount: svmAmount.toString(),
    nonce: eventNonce.toString(),
    deadline,
    status: "pending",
  };

  fs.writeFileSync(EVM_TO_SVM_PENDING, JSON.stringify(handoff, null, 2));

  console.log(`\n✓ Handoff file written: ${EVM_TO_SVM_PENDING}`);
  console.log(`\nNext step:`);
  console.log(
    `  SOLANA_RPC=https://api.devnet.solana.com \\`
  );
  console.log(
    `  SOLANA_ORCHESTRATOR_KEYPAIR=~/.config/solana/id.json \\`
  );
  console.log(
    `  LITE_PSM_PROGRAM_ID=<program_id> \\`
  );
  console.log(
    `  OKUSD_MINT=<mint_address> \\`
  );
  console.log(`  ts-node evm-to-svm/2-mint.ts`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
