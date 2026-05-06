/**
 * Mint OkuMoney on EVM from a Solana bridge request
 *
 * This script:
 * 1. Reads bridge request params from bridge-request.json or CLI args
 * 2. Constructs the EIP-712 BridgeRequest typed data
 * 3. Signs with the deployer's private key (acting as orchestrator)
 * 4. Calls okuBridge.bridgeMint(request, signature)
 * 5. Verifies recipient's OkuMoney balance increased
 *
 * Usage:
 *   NETWORK=op-sepolia npx hardhat run scripts/bridge/bridge-mint-from-solana.ts --network op-sepolia
 *
 * With custom request file:
 *   NETWORK=op-sepolia REQUEST_FILE=./custom-request.json npx hardhat run scripts/bridge/bridge-mint-from-solana.ts --network op-sepolia
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getEvmChainIdFromBridge } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract } from "../utils/deploy";
import { resolveNetworkContext } from "../utils/networkContext";

// Bridge request input interface (from SVM burn event)
interface BridgeRequestInput {
  sourceChainId: number;
  destChainId: number;
  sender: string; // Solana pubkey as hex or base58
  recipient: string; // EVM address (as bytes32)
  amount: string; // 6-decimal SVM amount as string
  nonce: number;
  deadline: number;
}

async function main() {
  const { networkName, bookKey } = await resolveNetworkContext();

  logger.section(`Bridge Mint: Solana -> EVM (${networkName})`);

  const [deployer] = await ethers.getSigners();
  logger.info(`Orchestrator (signer): ${deployer.address}`);
  logger.info(`Address book key: ${bookKey}`);

  // Load contract addresses
  const okuBridgeAddress = loadAddress(bookKey, "OkuBridge");
  const okuMoneyAddress = loadAddress(bookKey, "OkuMoney");

  logger.info(`OkuBridge: ${okuBridgeAddress}`);
  logger.info(`OkuMoney: ${okuMoneyAddress}`);

  // Get contract instances
  const okuBridge = await getDeployedContract("OkuBridge", okuBridgeAddress);
  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddress);

  // Load bridge request from scripts/bridge/ directory
  const requestFile = process.env.REQUEST_FILE || 
    path.join(__dirname, "bridge-request.json");
  
  if (!fs.existsSync(requestFile)) {
    throw new Error(`Bridge request file not found: ${requestFile}`);
  }

  logger.info(`Loading bridge request from: ${requestFile}`);
  const requestData: BridgeRequestInput = JSON.parse(fs.readFileSync(requestFile, "utf-8"));

  // Convert 6-decimal SVM amount to 18-decimal EVM amount
  const svmAmount = BigInt(requestData.amount);
  const evmAmount = svmAmount * BigInt(1e12);

  logger.section("Bridge Request Details");
  logger.info(`Source Chain: ${requestData.sourceChainId} (Solana)`);
  logger.info(`Dest Chain: ${requestData.destChainId} (EVM)`);
  logger.info(`Sender: ${requestData.sender}`);
  logger.info(`Recipient: ${requestData.recipient}`);
  logger.info(`SVM Amount (6 dec): ${requestData.amount}`);
  logger.info(`EVM Amount (18 dec): ${evmAmount.toString()}`);
  logger.info(`Nonce: ${requestData.nonce}`);
  logger.info(`Deadline: ${requestData.deadline}`);

  // Check deadline
  const now = Math.floor(Date.now() / 1000);
  if (now > requestData.deadline) {
    throw new Error(`Bridge request has expired. Deadline: ${requestData.deadline}, Now: ${now}`);
  }
  logger.info(`Time until deadline: ${requestData.deadline - now} seconds`);

  // Extract recipient EVM address from bytes32
  const recipientBytes32 = requestData.recipient;
  const recipientAddress = ethers.getAddress("0x" + recipientBytes32.slice(-40));
  logger.info(`Recipient EVM address: ${recipientAddress}`);

  // Check current balance
  const balanceBefore = await okuMoney.balanceOf(recipientAddress);
  logger.info(`Recipient balance before: ${ethers.formatUnits(balanceBefore, 18)} OkuM`);

  logger.section("Constructing EIP-712 Signature");

  // Convert internal protocol chain IDs to EIP-155 chain IDs
  // SVM uses u16 internal IDs (e.g., 111 for Sepolia), EVM uses EIP-155 IDs (e.g., 11155111)
  // The EVM contract validates destChainId == block.chainid, so we must use EIP-155 IDs
  const evmDestChainId = getEvmChainIdFromBridge(requestData.destChainId);
  logger.info(`Converting destChainId: ${requestData.destChainId} (internal) -> ${evmDestChainId} (EIP-155)`);

  // Construct the BridgeRequest struct
  // Note: sender is padded to bytes32 on Solana side, we need address for EVM
  // For SVM->EVM, sender is Solana pubkey (32 bytes) stored as bytes32
  // The contract expects address, so we take the last 20 bytes
  const senderAddress = ethers.getAddress("0x" + requestData.sender.slice(-40));

  const bridgeRequest = {
    sourceChainId: requestData.sourceChainId, // Keep internal ID for source (Solana = 103)
    destChainId: evmDestChainId, // Use EIP-155 ID for destination (block.chainid validation)
    sender: senderAddress,
    recipient: recipientBytes32,
    amount: evmAmount,
    nonce: requestData.nonce,
    deadline: requestData.deadline,
  };

  // EIP-712 domain (must match OkuBridge initialization)
  const domain = {
    name: "OkuBridge",
    version: "1",
    chainId: await deployer.provider!.getNetwork().then(n => n.chainId),
    verifyingContract: okuBridgeAddress,
  };

  // EIP-712 types
  const types = {
    BridgeRequest: [
      { name: "sourceChainId", type: "uint256" },
      { name: "destChainId", type: "uint256" },
      { name: "sender", type: "address" },
      { name: "recipient", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint256" },
    ],
  };

  logger.info("Signing EIP-712 message...");
  const signature = await deployer.signTypedData(domain, types, bridgeRequest);
  logger.success(`Signature: ${signature.slice(0, 20)}...${signature.slice(-20)}`);

  logger.section("Submitting bridgeMint Transaction");

  const tx = await okuBridge.bridgeMint(
    [
      bridgeRequest.sourceChainId,
      bridgeRequest.destChainId,
      bridgeRequest.sender,
      bridgeRequest.recipient,
      bridgeRequest.amount,
      bridgeRequest.nonce,
      bridgeRequest.deadline,
    ],
    signature
  );

  logger.info(`Transaction submitted: ${tx.hash}`);
  const receipt = await tx.wait();
  logger.success(`Transaction confirmed in block ${receipt.blockNumber}`);

  // Verify balance increased
  const balanceAfter = await okuMoney.balanceOf(recipientAddress);
  const balanceIncrease = balanceAfter - balanceBefore;

  logger.section("Bridge Mint Complete");
  logger.success(`Recipient balance after: ${ethers.formatUnits(balanceAfter, 18)} OkuM`);
  logger.success(`Balance increase: ${ethers.formatUnits(balanceIncrease, 18)} OkuM`);

  // Compare as strings to avoid BigInt comparison issues
  if (balanceIncrease.toString() !== evmAmount.toString()) {
    logger.warning(`Expected increase: ${ethers.formatUnits(evmAmount, 18)} OkuM`);
    logger.warning(`Actual increase: ${ethers.formatUnits(balanceIncrease, 18)} OkuM`);
  } else {
    logger.success("Bridge transfer completed successfully!");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Bridge mint failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
