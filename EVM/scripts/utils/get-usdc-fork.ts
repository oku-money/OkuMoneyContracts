/**
 * Helper script to get USDC on a forked network by impersonating a whale
 * Usage: NETWORK=localhost AMOUNT=100000 npx hardhat run scripts/utils/get-usdc-fork.ts --network localhost
 */

import { ethers, network } from "hardhat";
import { getChainConfig, getNetworkName } from "../config/chains";
import { getTokenAddress, getWhaleAddress } from "../../config/config";
import { logger } from "./logger";

// Backup whales if primary whale from config doesn't work
const BACKUP_USDC_WHALES: Record<string, string[]> = {
  optimism: [
    "0x0A59649758aa4d66E25f08Dd01271e891fe52199", // Coinbase 14
    "0xd6216fc19db775df9774a6e33526131da7d19a2c", // KuCoin Hot Wallet
    "0x28c6c06298d514db089934071355e5743bf21d60", // Binance 14
    "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1", // Optimism Gateway
  ],
  arbitrum: [
    "0xf89d7b9c864f589bbF53a82105107622B35EaA40", // USDC Bridge Escrow
    "0x47c031236e19d024b42f8AE6780E44A573170703", // Circle
  ],
  localhost: [
    "0x0A59649758aa4d66E25f08Dd01271e891fe52199", // Use Optimism whales for localhost
    "0xd6216fc19db775df9774a6e33526131da7d19a2c",
    "0x28c6c06298d514db089934071355e5743bf21d60",
    "0x99C9fc46f92E8a1c0deC1b1747d010903E884bE1",
  ],
};

async function main() {
  const networkName = getNetworkName();
  const chainConfig = getChainConfig(networkName);

  logger.section(`Getting USDC on ${chainConfig.name} Fork`);

  const [recipient] = await ethers.getSigners();
  logger.info(`Recipient address: ${recipient.address}`);

  // Get amount from environment or use default (100,000 USDC)
  const amountStr = process.env.AMOUNT || "100000";
  const usdcAmount = ethers.parseUnits(amountStr, 6);

  logger.info(`Requesting ${amountStr} USDC`);

  // Get USDC address from centralized config
  const usdcAddress = getTokenAddress(networkName, "usdc");

  // Check if USDC contract exists at the address
  const code = await ethers.provider.getCode(usdcAddress);
  if (code === "0x") {
    logger.error(`No contract found at USDC address: ${usdcAddress}`);
    logger.info("This usually means:");
    logger.info("1. The fork is not set up correctly");
    logger.info("2. You're forking from the wrong network");
    logger.info("3. You're forking from a block before USDC was deployed");
    logger.info("\nTo fix this:");
    logger.info("1. Stop the hardhat node (Ctrl+C)");
    logger.info("2. Start it again with: npx hardhat node");
    logger.info("   (This uses the hardhat.config.ts forking settings)");
    logger.info("\nOr manually specify the fork:");
    logger.info("   npx hardhat node --fork https://mainnet.optimism.io --fork-block-number 120000000");
    process.exit(1);
  }

  // Get USDC contract
  const usdc = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"],
    usdcAddress
  );

  // Check current balance
  let currentBalance: bigint;
  try {
    currentBalance = await usdc.balanceOf(recipient.address);
    logger.info(`Current USDC balance: ${ethers.formatUnits(currentBalance, 6)}`);
  } catch (error: any) {
    logger.error(`Failed to check USDC balance: ${error.message}`);
    logger.info("The USDC contract may not be compatible or the fork is corrupted");
    process.exit(1);
  }

  // Try primary whale from config first, then fall back to backup list
  const primaryWhale = getWhaleAddress(networkName, "usdc");
  const backupWhales = BACKUP_USDC_WHALES[networkName] || BACKUP_USDC_WHALES.localhost;
  const allWhales = primaryWhale ? [primaryWhale, ...backupWhales] : backupWhales;

  logger.step(1, "Finding USDC whale with sufficient balance");

  let successfulWhale: string | null = null;

  for (const whaleAddr of allWhales) {
    try {
      // Properly checksum the address
      const whale = ethers.getAddress(whaleAddr);
      const whaleBalance = await usdc.balanceOf(whale);
      logger.info(`Checking whale ${whale}: ${ethers.formatUnits(whaleBalance, 6)} USDC`);

      if (whaleBalance >= usdcAmount) {
        logger.success(`Found whale with sufficient balance: ${whale}`);
        successfulWhale = whale;
        break;
      }
    } catch (error: any) {
      logger.warning(`Failed to check whale ${whaleAddr}: ${error.message}`);
      continue; // Skip to next whale
    }
  }

  if (!successfulWhale) {
    logger.error("No whale found with sufficient USDC balance");
    logger.info("Check Etherscan for current USDC holders and add to config/config.ts");
    logger.info(`Optimism USDC: https://optimistic.etherscan.io/token/${usdcAddress}#balances`);
    logger.info(`Arbitrum USDC: https://arbiscan.io/token/${usdcAddress}#balances`);
    process.exit(1);
  }

  // Impersonate whale
  logger.step(2, "Impersonating whale account");
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [successfulWhale],
  });

  // Get whale signer
  const whaleSigner = await ethers.getSigner(successfulWhale);

  // Transfer USDC from whale to recipient
  logger.step(3, "Transferring USDC from whale to recipient");

  try {
    const tx = await usdc.connect(whaleSigner).transfer(recipient.address, usdcAmount);
    await tx.wait();
    logger.success("USDC transfer successful");
  } catch (error: any) {
    logger.error(`Transfer failed: ${error.message}`);
    logger.info("Whale may need ETH for gas. Try funding whale first:");
    logger.info(`await recipient.sendTransaction({ to: "${successfulWhale}", value: ethers.parseEther("1") })`);
    process.exit(1);
  }

  // Stop impersonating
  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [successfulWhale],
  });

  // Check final balance
  const finalBalance = await usdc.balanceOf(recipient.address);
  logger.info(`Final USDC balance: ${ethers.formatUnits(finalBalance, 6)}`);

  const received = finalBalance - currentBalance;
  logger.section("Summary");
  logger.success(`Received ${ethers.formatUnits(received, 6)} USDC`);
  logger.success("Ready to mint OkuUSD!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Failed to get USDC: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
