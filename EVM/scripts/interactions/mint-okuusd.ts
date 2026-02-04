/**
 * Mint OkuUSD from USDC via LitePSM
 * Usage: NETWORK=localhost AMOUNT=10000 npx hardhat run scripts/interactions/mint-okuusd.ts --network localhost
 */

import { ethers } from "hardhat";
import { getNetworkName, getChainConfig } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract, waitForTx } from "../utils/deploy";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Minting OkuUSD on ${chainConfig.name}`);

  const [user] = await ethers.getSigners();
  logger.info(`User address: ${user.address}`);

  // Get amount from environment or use default (1000 USDC)
  const amountUSDC = process.env.AMOUNT || "1000";
  const usdcAmount = ethers.parseUnits(amountUSDC, 6); // USDC has 6 decimals

  logger.info(`Minting ${amountUSDC} okuUSD from ${amountUSDC} USDC`);

  // Load deployed contract addresses
  const litePSMAddress = loadAddress(network, "LitePSM");
  const okuUSDAddress = loadAddress(network, "OkuUSD");

  // Get contract instances
  const litePSM = await getDeployedContract("LitePSM", litePSMAddress);
  const okuUSD = await getDeployedContract("OkuUSD", okuUSDAddress);

  // Check if USDC contract exists at the address
  const code = await ethers.provider.getCode(chainConfig.usdc);
  if (code === "0x") {
    logger.error(`No contract found at USDC address: ${chainConfig.usdc}`);
    logger.info("Make sure you're connected to the correct network and USDC is deployed");
    logger.info("\nFor fork testing:");
    logger.info("1. Stop the hardhat node (Ctrl+C)");
    logger.info("2. Start it again with: npx hardhat node");
    logger.info("   (This uses the hardhat.config.ts forking settings)");
    process.exit(1);
  }

  // Get USDC contract
  const usdc = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"],
    chainConfig.usdc
  );

  // Check USDC balance
  let usdcBalance: bigint;
  try {
    usdcBalance = await usdc.balanceOf(user.address);
    logger.info(`USDC balance: ${ethers.formatUnits(usdcBalance, 6)}`);
  } catch (error: any) {
    logger.error(`Failed to check USDC balance: ${error.message}`);
    logger.info("The USDC contract may not be compatible or the network setup is incorrect");
    process.exit(1);
  }

  if (usdcBalance < usdcAmount) {
    logger.error(`Insufficient USDC balance. Need ${amountUSDC}, have ${ethers.formatUnits(usdcBalance, 6)}`);
    logger.info("For fork testing, you may need to impersonate a USDC whale account");
    process.exit(1);
  }

  // Check OkuUSD balance before minting
  const okuUSDBalanceBefore = await okuUSD.balanceOf(user.address);
  logger.info(`OkuUSD balance before: ${ethers.formatUnits(okuUSDBalanceBefore, 18)}`);

  // Approve USDC to LitePSM
  logger.step(1, "Approving USDC to LitePSM");
  await waitForTx(
    await usdc.approve(litePSMAddress, usdcAmount),
    "Approve USDC"
  );

  // Mint OkuUSD
  logger.step(2, "Minting OkuUSD");
  await waitForTx(
    await litePSM.mint(usdcAmount),
    "Mint OkuUSD"
  );

  // Check OkuUSD balance after minting
  const okuUSDBalanceAfter = await okuUSD.balanceOf(user.address);
  logger.info(`OkuUSD balance after: ${ethers.formatUnits(okuUSDBalanceAfter, 18)}`);

  const minted = okuUSDBalanceAfter - okuUSDBalanceBefore;
  logger.section("Mint Summary");
  logger.success(`Minted ${ethers.formatUnits(minted, 18)} okuUSD`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Mint failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
