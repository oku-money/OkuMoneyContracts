/**
 * Mint OkuMoney from USDC via LitePSM
 * Usage: NETWORK=localhost AMOUNT=10000 npx hardhat run scripts/interactions/mint-okumoney.ts --network localhost
 */

import { ethers } from "hardhat";
import { getNetworkName, getChainConfig } from "../config/chains";
import { loadAddress, hasAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract, waitForTx } from "../utils/deploy";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Minting OkuMoney on ${chainConfig.name}`);

  const [user] = await ethers.getSigners();
  logger.info(`User address: ${user.address}`);

  // Get amount from environment or use default (1000 USDC)
  const amountUSDC = process.env.AMOUNT || "1000";
  const usdcAmount = ethers.parseUnits(amountUSDC, 6); // USDC has 6 decimals

  logger.info(`Minting ${amountUSDC} OkuM from ${amountUSDC} USDC`);

  // Load deployed contract addresses
  const litePSMAddress = loadAddress(network, "LitePSM");
  const okuMoneyAddress = loadAddress(network, "OkuMoney");

  // Get contract instances
  const litePSM = await getDeployedContract("LitePSM", litePSMAddress);
  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddress);

  // Determine USDC address (MockUSDC for testnet, real USDC for mainnet)
  const usdcAddress = hasAddress(network, "MockUSDC")
    ? loadAddress(network, "MockUSDC")
    : chainConfig.usdc;

  // Check if USDC contract exists
  const code = await ethers.provider.getCode(usdcAddress);
  if (code === "0x") {
    logger.error(`No contract found at USDC address: ${usdcAddress}`);
    logger.info("Make sure you're connected to the correct network and USDC is deployed");
    process.exit(1);
  }

  // Get USDC contract
  const usdc = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function mint(address,uint256)"],
    usdcAddress
  );

  // Check USDC balance
  let usdcBalance: bigint;
  try {
    usdcBalance = await usdc.balanceOf(user.address);
    logger.info(`USDC balance: ${ethers.formatUnits(usdcBalance, 6)}`);
  } catch (error: any) {
    logger.error(`Failed to check USDC balance: ${error.message}`);
    process.exit(1);
  }

  // If using MockUSDC and balance is insufficient, mint some
  if (usdcBalance < usdcAmount && hasAddress(network, "MockUSDC")) {
    logger.info("Minting MockUSDC...");
    try {
      const mintTx = await usdc.mint(user.address, usdcAmount);
      await mintTx.wait();
      usdcBalance = await usdc.balanceOf(user.address);
      logger.success(`MockUSDC minted. New balance: ${ethers.formatUnits(usdcBalance, 6)}`);
    } catch (e) {
      logger.warning("Could not mint MockUSDC");
    }
  }

  if (usdcBalance < usdcAmount) {
    logger.error(`Insufficient USDC balance. Need ${amountUSDC}, have ${ethers.formatUnits(usdcBalance, 6)}`);
    process.exit(1);
  }

  // Check OkuMoney balance before minting
  const okuMoneyBalanceBefore = await okuMoney.balanceOf(user.address);
  logger.info(`OkuMoney balance before: ${ethers.formatUnits(okuMoneyBalanceBefore, 18)}`);

  // Approve USDC to LitePSM
  logger.step(1, "Approving USDC to LitePSM");
  await waitForTx(
    await usdc.approve(litePSMAddress, usdcAmount),
    "Approve USDC"
  );

  // Mint OkuMoney from USDC via LitePSM
  logger.step(2, "Minting OkuMoney from USDC");
  await waitForTx(
    await litePSM.mintOkuM(usdcAmount),
    "Mint OkuMoney"
  );

  // Check OkuMoney balance after minting
  const okuMoneyBalanceAfter = await okuMoney.balanceOf(user.address);
  logger.info(`OkuMoney balance after: ${ethers.formatUnits(okuMoneyBalanceAfter, 18)}`);

  const minted = okuMoneyBalanceAfter - okuMoneyBalanceBefore;
  logger.section("Mint Summary");
  logger.success(`Minted ${ethers.formatUnits(minted, 18)} OkuM`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Mint failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
