/**
 * Bridge OkuMoney from EVM (OP Sepolia) to Solana (Devnet)
 *
 * This script:
 * 1. Mints OkuMoney via LitePSM (using MockUSDC)
 * 2. Approves OkuBridgeRouter to spend OkuMoney
 * 3. Calls bridgeRouter.bridgeOkuM() to burn tokens
 * 4. Parses the BridgeBurn event
 * 5. Writes bridge-request.json for the relay script
 *
 * Usage:
 *   NETWORK=op-sepolia npx hardhat run scripts/bridge/bridge-burn-to-solana.ts --network op-sepolia
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getNetworkName, SOLANA_DEVNET_CHAIN_ID } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract } from "../utils/deploy";

// Bridge request output interface (for relay script)
interface BridgeRequestOutput {
  requestId: string;
  sourceChainId: number;
  destChainId: number;
  sender: string;
  recipient: string; // bytes32 hex string
  amount: string; // 18-decimal amount as string
  nonce: number;
  deadline: number;
  timestamp: number;
  txHash: string;
}

async function main() {
  const network = getNetworkName();
  
  logger.section("Bridge OkuMoney: EVM -> Solana");

  const [deployer] = await ethers.getSigners();
  logger.info(`Sender address: ${deployer.address}`);

  // Load contract addresses
  const okuMoneyAddress = loadAddress(network, "OkuMoney");
  const litePSMAddress = loadAddress(network, "LitePSM");
  const bridgeRouterAddress = loadAddress(network, "OkuBridgeRouter");
  const mockUSDCAddress = loadAddress(network, "MockUSDC");

  logger.info(`OkuMoney: ${okuMoneyAddress}`);
  logger.info(`LitePSM: ${litePSMAddress}`);
  logger.info(`OkuBridgeRouter: ${bridgeRouterAddress}`);
  logger.info(`MockUSDC: ${mockUSDCAddress}`);

  // Get contract instances
  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddress);
  const litePSM = await getDeployedContract("LitePSM", litePSMAddress);
  const bridgeRouter = await getDeployedContract("OkuBridgeRouter", bridgeRouterAddress);
  const mockUSDC = await getDeployedContract("MockUSDC", mockUSDCAddress);

  // Configuration
  const BRIDGE_AMOUNT = ethers.parseUnits("10", 18); // 10 OkuMoney (18 decimals)
  const USDC_AMOUNT = ethers.parseUnits("10", 6); // 10 USDC (6 decimals)

  // Solana recipient - this should be a valid Solana wallet pubkey
  // For testing, use a placeholder or your actual Solana devnet wallet
  // Format: left-padded to 32 bytes
  const SOLANA_RECIPIENT_PUBKEY = process.env.SOLANA_RECIPIENT || 
    "11111111111111111111111111111111"; // Placeholder - replace with actual pubkey
  const recipientBytes32 = ethers.zeroPadValue(
    ethers.getBytes("0x" + Buffer.from(SOLANA_RECIPIENT_PUBKEY).toString("hex").slice(0, 64)),
    32
  );

  logger.section("Step 1: Mint MockUSDC");
  
  // Check current USDC balance
  const usdcBalance = await mockUSDC.balanceOf(deployer.address);
  logger.info(`Current USDC balance: ${ethers.formatUnits(usdcBalance, 6)} USDC`);
  
  if (usdcBalance < USDC_AMOUNT) {
    logger.info(`Minting ${ethers.formatUnits(USDC_AMOUNT, 6)} MockUSDC...`);
    const mintTx = await mockUSDC.mint(deployer.address, USDC_AMOUNT);
    await mintTx.wait();
    logger.success("MockUSDC minted");
  }

  logger.section("Step 2: Deposit USDC to LitePSM for OkuMoney");
  
  // Approve LitePSM to spend USDC
  logger.info("Approving LitePSM to spend USDC...");
  const approveTx1 = await mockUSDC.approve(litePSMAddress, USDC_AMOUNT);
  await approveTx1.wait();
  
  // Deposit USDC and get OkuMoney
  logger.info(`Depositing ${ethers.formatUnits(USDC_AMOUNT, 6)} USDC to LitePSM...`);
  const depositTx = await litePSM.deposit(USDC_AMOUNT, deployer.address);
  await depositTx.wait();
  
  const okuMoneyBalance = await okuMoney.balanceOf(deployer.address);
  logger.success(`OkuMoney balance: ${ethers.formatUnits(okuMoneyBalance, 18)} OkuM`);

  logger.section("Step 3: Bridge OkuMoney to Solana");
  
  // Approve OkuBridgeRouter to spend OkuMoney
  logger.info("Approving OkuBridgeRouter to spend OkuMoney...");
  const approveTx2 = await okuMoney.approve(bridgeRouterAddress, BRIDGE_AMOUNT);
  await approveTx2.wait();

  // Bridge via router
  logger.info(`Bridging ${ethers.formatUnits(BRIDGE_AMOUNT, 18)} OkuM to Solana Devnet (chain ${SOLANA_DEVNET_CHAIN_ID})...`);
  logger.info(`Recipient (bytes32): ${recipientBytes32}`);
  
  const bridgeTx = await bridgeRouter.bridgeOkuM(
    BRIDGE_AMOUNT,
    SOLANA_DEVNET_CHAIN_ID,
    recipientBytes32
  );
  const receipt = await bridgeTx.wait();

  logger.section("Step 4: Parse BridgeBurn Event");

  // Find BridgeBurn event from OkuBridge
  const okuBridgeAddress = loadAddress(network, "OkuBridge");
  const okuBridge = await getDeployedContract("OkuBridge", okuBridgeAddress);
  
  // Parse logs
  const bridgeBurnTopic = okuBridge.interface.getEvent("BridgeBurn")?.topicHash;
  const bridgeBurnLog = receipt.logs.find(
    (log: any) => log.address.toLowerCase() === okuBridgeAddress.toLowerCase() && 
                   log.topics[0] === bridgeBurnTopic
  );

  if (!bridgeBurnLog) {
    throw new Error("BridgeBurn event not found in transaction");
  }

  const parsedEvent = okuBridge.interface.parseLog({
    topics: bridgeBurnLog.topics,
    data: bridgeBurnLog.data,
  });

  if (!parsedEvent) {
    throw new Error("Failed to parse BridgeBurn event");
  }

  const { requestId, sender, recipient, sourceChainId, destChainId, amount, nonce, deadline } = parsedEvent.args;

  logger.success("BridgeBurn Event:");
  logger.info(`  Request ID: ${requestId}`);
  logger.info(`  Sender: ${sender}`);
  logger.info(`  Recipient: ${recipient}`);
  logger.info(`  Source Chain: ${sourceChainId}`);
  logger.info(`  Dest Chain: ${destChainId}`);
  logger.info(`  Amount: ${ethers.formatUnits(amount, 18)} OkuM (post-fee)`);
  logger.info(`  Nonce: ${nonce}`);
  logger.info(`  Deadline: ${deadline} (${new Date(Number(deadline) * 1000).toISOString()})`);

  logger.section("Step 5: Write Bridge Request File");

  const bridgeRequest: BridgeRequestOutput = {
    requestId: requestId,
    sourceChainId: Number(sourceChainId),
    destChainId: Number(destChainId),
    sender: sender,
    recipient: recipient,
    amount: amount.toString(),
    nonce: Number(nonce),
    deadline: Number(deadline),
    timestamp: Math.floor(Date.now() / 1000),
    txHash: receipt.hash,
  };

  const outputPath = path.join(__dirname, "..", "..", "bridge-request.json");
  fs.writeFileSync(outputPath, JSON.stringify(bridgeRequest, null, 2));
  logger.success(`Bridge request written to: ${outputPath}`);

  logger.section("Bridge Burn Complete");
  logger.info("");
  logger.info("Next steps:");
  logger.info("1. Copy bridge-request.json to SVM/oku-programs/");
  logger.info("2. Run relay-from-evm.ts on Solana Devnet to complete the bridge");
  logger.info("");
  logger.info("Decimal conversion note:");
  logger.info(`  EVM amount (18 decimals): ${amount.toString()}`);
  logger.info(`  SVM amount (6 decimals):  ${(BigInt(amount) / BigInt(1e12)).toString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Bridge burn failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
