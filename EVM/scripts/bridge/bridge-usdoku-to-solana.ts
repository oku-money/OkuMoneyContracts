/**
 * Bridge OkuDollar (usdOku) from EVM to Solana via unwrap
 *
 * This script:
 * 1. Mints OkuMoney via LitePSM
 * 2. Wraps OkuMoney to OkuDollar (usdOku)
 * 3. Approves OkuBridgeRouter to spend OkuDollar
 * 4. Calls bridgeRouter.bridgeUsdOku() which unwraps and burns
 * 5. Parses the BridgeBurn event
 * 6. Writes bridge-request.json for the relay script
 *
 * Usage:
 *   NETWORK=op-sepolia npx hardhat run scripts/bridge/bridge-usdoku-to-solana.ts --network op-sepolia
 */

import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { getNetworkName, SOLANA_DEVNET_CHAIN_ID } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract } from "../utils/deploy";

// Bridge request output interface
interface BridgeRequestOutput {
  requestId: string;
  sourceChainId: number;
  destChainId: number;
  sender: string;
  recipient: string;
  amount: string;
  nonce: number;
  deadline: number;
  timestamp: number;
  txHash: string;
  bridgeType: string;
}

async function main() {
  const network = getNetworkName();
  
  logger.section("Bridge OkuDollar: EVM -> Solana");

  const [deployer] = await ethers.getSigners();
  logger.info(`Sender address: ${deployer.address}`);

  // Load contract addresses
  const okuMoneyAddress = loadAddress(network, "OkuMoney");
  const okuDollarAddress = loadAddress(network, "OkuDollar");
  const litePSMAddress = loadAddress(network, "LitePSM");
  const bridgeRouterAddress = loadAddress(network, "OkuBridgeRouter");
  const mockUSDCAddress = loadAddress(network, "MockUSDC");

  logger.info(`OkuMoney: ${okuMoneyAddress}`);
  logger.info(`OkuDollar: ${okuDollarAddress}`);
  logger.info(`LitePSM: ${litePSMAddress}`);
  logger.info(`OkuBridgeRouter: ${bridgeRouterAddress}`);
  logger.info(`MockUSDC: ${mockUSDCAddress}`);

  // Get contract instances
  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddress);
  const okuDollar = await getDeployedContract("OkuDollar", okuDollarAddress);
  const litePSM = await getDeployedContract("LitePSM", litePSMAddress);
  const bridgeRouter = await getDeployedContract("OkuBridgeRouter", bridgeRouterAddress);
  const mockUSDC = await getDeployedContract("MockUSDC", mockUSDCAddress);

  // Configuration
  const USDC_AMOUNT = ethers.parseUnits("10", 6); // 10 USDC (6 decimals)
  
  // Solana recipient
  const SOLANA_RECIPIENT_PUBKEY = process.env.SOLANA_RECIPIENT || 
    "11111111111111111111111111111111";
  const recipientBytes32 = ethers.zeroPadValue(
    ethers.getBytes("0x" + Buffer.from(SOLANA_RECIPIENT_PUBKEY).toString("hex").slice(0, 64)),
    32
  );

  logger.section("Step 1: Mint MockUSDC");
  
  const usdcBalance = await mockUSDC.balanceOf(deployer.address);
  logger.info(`Current USDC balance: ${ethers.formatUnits(usdcBalance, 6)} USDC`);
  
  if (usdcBalance < USDC_AMOUNT) {
    logger.info(`Minting ${ethers.formatUnits(USDC_AMOUNT, 6)} MockUSDC...`);
    const mintTx = await mockUSDC.mint(deployer.address, USDC_AMOUNT);
    await mintTx.wait();
    logger.success("MockUSDC minted");
  }

  logger.section("Step 2: Deposit USDC to LitePSM for OkuMoney");
  
  logger.info("Approving LitePSM to spend USDC...");
  const approveTx1 = await mockUSDC.approve(litePSMAddress, USDC_AMOUNT);
  await approveTx1.wait();
  
  logger.info(`Depositing ${ethers.formatUnits(USDC_AMOUNT, 6)} USDC to LitePSM...`);
  const depositTx = await litePSM.deposit(USDC_AMOUNT, deployer.address);
  await depositTx.wait();
  
  const okuMoneyBalance = await okuMoney.balanceOf(deployer.address);
  logger.success(`OkuMoney balance: ${ethers.formatUnits(okuMoneyBalance, 18)} OkuM`);

  logger.section("Step 3: Wrap OkuMoney to OkuDollar");

  // Approve OkuDollar to spend OkuMoney
  logger.info("Approving OkuDollar to spend OkuMoney...");
  const approveTx2 = await okuMoney.approve(okuDollarAddress, okuMoneyBalance);
  await approveTx2.wait();

  // Wrap OkuMoney to OkuDollar
  logger.info(`Wrapping ${ethers.formatUnits(okuMoneyBalance, 18)} OkuM to usdOku...`);
  const wrapTx = await okuDollar.wrap(okuMoneyBalance, deployer.address);
  await wrapTx.wait();

  const okuDollarBalance = await okuDollar.balanceOf(deployer.address);
  logger.success(`OkuDollar balance: ${ethers.formatUnits(okuDollarBalance, 18)} usdOku`);

  logger.section("Step 4: Bridge OkuDollar to Solana");
  
  // Approve OkuBridgeRouter to spend OkuDollar
  logger.info("Approving OkuBridgeRouter to spend OkuDollar...");
  const approveTx3 = await okuDollar.approve(bridgeRouterAddress, okuDollarBalance);
  await approveTx3.wait();

  // Bridge via router
  logger.info(`Bridging ${ethers.formatUnits(okuDollarBalance, 18)} usdOku to Solana Devnet (chain ${SOLANA_DEVNET_CHAIN_ID})...`);
  logger.info(`Recipient (bytes32): ${recipientBytes32}`);
  
  const bridgeTx = await bridgeRouter.bridgeUsdOku(
    okuDollarBalance,
    SOLANA_DEVNET_CHAIN_ID,
    recipientBytes32
  );
  const receipt = await bridgeTx.wait();

  logger.section("Step 5: Parse BridgeBurn Event");

  const okuBridgeAddress = loadAddress(network, "OkuBridge");
  const okuBridge = await getDeployedContract("OkuBridge", okuBridgeAddress);
  
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
  logger.info(`  Deadline: ${deadline}`);

  logger.section("Step 6: Write Bridge Request File");

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
    bridgeType: "usdOku",
  };

  const outputPath = path.join(__dirname, "..", "..", "bridge-request.json");
  fs.writeFileSync(outputPath, JSON.stringify(bridgeRequest, null, 2));
  logger.success(`Bridge request written to: ${outputPath}`);

  logger.section("Bridge Burn Complete (OkuDollar Path)");
  logger.info("");
  logger.info("The OkuDollar was unwrapped to OkuMoney before bridging.");
  logger.info("On the destination (Solana), the recipient will receive OkuMoney tokens.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Bridge burn failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
