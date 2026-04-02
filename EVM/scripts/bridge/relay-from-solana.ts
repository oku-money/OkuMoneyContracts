/**
 * Relay a bridge request from Solana to EVM (Orchestrator Simulation)
 *
 * This script acts as the orchestrator for testnet:
 * 1. Reads SVM burn event data from bridge-request.json
 * 2. Converts 6-decimal SVM amount to 18-decimal EVM amount
 * 3. Constructs EIP-712 BridgeRequest struct
 * 4. Signs with deployer key (ECDSA)
 * 5. Submits okuBridge.bridgeMint(request, signature) on OP Sepolia
 *
 * Usage:
 *   NETWORK=op-sepolia npx hardhat run scripts/bridge/relay-from-solana.ts --network op-sepolia
 *   NETWORK=op-sepolia npx hardhat run scripts/bridge/relay-from-solana.ts --network op-sepolia --request ../SVM/oku-programs/bridge-request.json
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getNetworkName, SOLANA_DEVNET_CHAIN_ID } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract } from "../utils/deploy";

// Bridge request from SVM (post-burn event data)
interface SVMBridgeRequest {
  sourceChainId: number; // Should be 103 (Solana Devnet)
  destChainId: number; // Should be 11155420 (OP Sepolia)
  sender: string; // Solana pubkey as base58 or hex
  recipient: string; // EVM address as bytes32 hex (right-padded)
  amount: string; // 6-decimal SVM amount (post-fee)
  nonce: number;
  deadline: number;
  requestId?: string;
  txSignature?: string;
}

async function main() {
  const network = getNetworkName();
  
  logger.section("Relay Bridge Request: Solana -> EVM");
  logger.info("Acting as orchestrator (testnet mode)");

  const [deployer] = await ethers.getSigners();
  logger.info(`Orchestrator address: ${deployer.address}`);

  // Load contract addresses
  const okuBridgeAddress = loadAddress(network, "OkuBridge");
  const okuMoneyAddress = loadAddress(network, "OkuMoney");

  // Get contract instances
  const okuBridge = await getDeployedContract("OkuBridge", okuBridgeAddress);
  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddress);

  // Verify deployer is the authorized signer
  const authorizedSigner = await okuBridge.authorizedSigner();
  if (authorizedSigner.toLowerCase() !== deployer.address.toLowerCase()) {
    logger.warning(`Warning: Deployer is not the authorized signer`);
    logger.warning(`Authorized signer: ${authorizedSigner}`);
    logger.warning(`Deployer: ${deployer.address}`);
    logger.warning(`The transaction will fail unless you are the authorized signer`);
  }

  // Load bridge request
  const requestArg = process.argv.find(arg => arg.startsWith("--request="));
  const requestFile = requestArg 
    ? requestArg.split("=")[1]
    : process.env.REQUEST_FILE || path.join(__dirname, "..", "..", "bridge-request.json");
  
  if (!fs.existsSync(requestFile)) {
    throw new Error(`Bridge request file not found: ${requestFile}`);
  }

  logger.info(`Loading bridge request from: ${requestFile}`);
  const svmRequest: SVMBridgeRequest = JSON.parse(fs.readFileSync(requestFile, "utf-8"));

  // Validate source chain
  if (svmRequest.sourceChainId !== SOLANA_DEVNET_CHAIN_ID) {
    logger.warning(`Source chain is ${svmRequest.sourceChainId}, expected ${SOLANA_DEVNET_CHAIN_ID} (Solana Devnet)`);
  }

  logger.section("SVM Bridge Request");
  logger.info(`Source Chain: ${svmRequest.sourceChainId}`);
  logger.info(`Dest Chain: ${svmRequest.destChainId}`);
  logger.info(`Sender: ${svmRequest.sender}`);
  logger.info(`Recipient: ${svmRequest.recipient}`);
  logger.info(`Amount (6 dec): ${svmRequest.amount}`);
  logger.info(`Nonce: ${svmRequest.nonce}`);
  logger.info(`Deadline: ${svmRequest.deadline}`);
  if (svmRequest.txSignature) {
    logger.info(`SVM TX: ${svmRequest.txSignature}`);
  }

  // Decimal conversion: 6 -> 18 decimals
  const svmAmount = BigInt(svmRequest.amount);
  const evmAmount = svmAmount * BigInt(1e12);

  logger.section("Decimal Conversion");
  logger.info(`SVM amount (6 decimals): ${svmAmount.toString()}`);
  logger.info(`EVM amount (18 decimals): ${evmAmount.toString()}`);
  logger.info(`Human readable: ${ethers.formatUnits(evmAmount, 18)} OkuM`);

  // Check deadline
  const now = Math.floor(Date.now() / 1000);
  if (now > svmRequest.deadline) {
    throw new Error(`Bridge request has expired. Deadline: ${svmRequest.deadline}, Now: ${now}`);
  }
  logger.info(`Time until deadline: ${svmRequest.deadline - now} seconds`);

  // Parse recipient address
  // On SVM->EVM, recipient is an EVM address stored as bytes32 (left-padded with zeros)
  // Example: 0x000000000000000000000000abc123...
  const recipientBytes32 = svmRequest.recipient;
  const recipientAddress = ethers.getAddress("0x" + recipientBytes32.slice(-40));
  logger.info(`Recipient EVM address: ${recipientAddress}`);

  // Parse sender
  // On SVM, sender is a Solana pubkey (32 bytes). For EIP-712, we need an address.
  // We take the last 20 bytes as a pseudo-address for signature purposes.
  const senderBytes = svmRequest.sender;
  let senderAddress: string;
  if (senderBytes.startsWith("0x") && senderBytes.length === 66) {
    // Already hex, take last 20 bytes
    senderAddress = ethers.getAddress("0x" + senderBytes.slice(-40));
  } else {
    // Assume it's base58 Solana pubkey - convert to hex, take last 20 bytes
    // For simplicity, just use a zero address placeholder
    // In production, proper pubkey handling would be needed
    senderAddress = ethers.ZeroAddress;
    logger.warning(`Using zero address for sender (base58 pubkey handling not implemented)`);
  }

  // Check current balance
  const balanceBefore = await okuMoney.balanceOf(recipientAddress);
  logger.info(`Recipient balance before: ${ethers.formatUnits(balanceBefore, 18)} OkuM`);

  logger.section("Constructing EIP-712 Signature");

  const bridgeRequest = {
    sourceChainId: svmRequest.sourceChainId,
    destChainId: svmRequest.destChainId,
    sender: senderAddress,
    recipient: recipientBytes32,
    amount: evmAmount,
    nonce: svmRequest.nonce,
    deadline: svmRequest.deadline,
  };

  // EIP-712 domain
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
  logger.success(`Signature generated`);

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

  logger.section("Relay Complete");
  logger.success(`Recipient: ${recipientAddress}`);
  logger.success(`Balance before: ${ethers.formatUnits(balanceBefore, 18)} OkuM`);
  logger.success(`Balance after: ${ethers.formatUnits(balanceAfter, 18)} OkuM`);
  logger.success(`Minted: ${ethers.formatUnits(balanceIncrease, 18)} OkuM`);
  logger.info(`TX Hash: ${receipt.hash}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Relay failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
