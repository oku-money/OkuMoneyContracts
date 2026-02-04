/**
 * Wrap OkuUSD to wOkuUSD (ERC4626 deposit)
 * Usage: NETWORK=localhost AMOUNT=5000 npx hardhat run scripts/interactions/wrap-okuusd.ts --network localhost
 */

import { ethers } from "hardhat";
import { getNetworkName, getChainConfig } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract, waitForTx } from "../utils/deploy";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Wrapping OkuUSD on ${chainConfig.name}`);

  const [user] = await ethers.getSigners();
  logger.info(`User address: ${user.address}`);

  // Get amount from environment or use default (1000 OkuUSD)
  const amountStr = process.env.AMOUNT || "1000";
  const okuUSDAmount = ethers.parseUnits(amountStr, 18);

  logger.info(`Wrapping ${amountStr} okuUSD to wOkuUSD`);

  // Load deployed contract addresses
  const wOkuUSDAddress = loadAddress(network, "wOkuUSD");
  const okuUSDAddress = loadAddress(network, "OkuUSD");

  // Get contract instances
  const wOkuUSD = await getDeployedContract("wOkuUSD", wOkuUSDAddress);
  const okuUSD = await getDeployedContract("OkuUSD", okuUSDAddress);

  // Check OkuUSD balance
  const okuUSDBalance = await okuUSD.balanceOf(user.address);
  logger.info(`OkuUSD balance: ${ethers.formatUnits(okuUSDBalance, 18)}`);

  if (okuUSDBalance < okuUSDAmount) {
    logger.error(`Insufficient OkuUSD balance. Need ${amountStr}, have ${ethers.formatUnits(okuUSDBalance, 18)}`);
    logger.info("Run mint-okuusd.ts first to mint OkuUSD");
    process.exit(1);
  }

  // Check wOkuUSD balance before wrapping
  const wOkuUSDBalanceBefore = await wOkuUSD.balanceOf(user.address);
  logger.info(`wOkuUSD balance before: ${ethers.formatUnits(wOkuUSDBalanceBefore, 18)}`);

  // Approve OkuUSD to wOkuUSD
  logger.step(1, "Approving OkuUSD to wOkuUSD");
  await waitForTx(
    await okuUSD.approve(wOkuUSDAddress, okuUSDAmount),
    "Approve OkuUSD"
  );

  // Deposit (wrap) OkuUSD to wOkuUSD
  logger.step(2, "Depositing OkuUSD to wOkuUSD");
  await waitForTx(
    await wOkuUSD.deposit(okuUSDAmount, user.address),
    "Deposit OkuUSD"
  );

  // Check wOkuUSD balance after wrapping
  const wOkuUSDBalanceAfter = await wOkuUSD.balanceOf(user.address);
  logger.info(`wOkuUSD balance after: ${ethers.formatUnits(wOkuUSDBalanceAfter, 18)}`);

  const wrapped = wOkuUSDBalanceAfter - wOkuUSDBalanceBefore;
  logger.section("Wrap Summary");
  logger.success(`Wrapped ${amountStr} okuUSD to ${ethers.formatUnits(wrapped, 18)} wOkuUSD shares`);

  // Show conversion rate
  const totalAssets = await wOkuUSD.totalAssets();
  const totalSupply = await wOkuUSD.totalSupply();
  if (totalSupply > 0n) {
    const rate = (Number(totalAssets) / Number(totalSupply)).toFixed(6);
    logger.info(`Current conversion rate: 1 wOkuUSD = ${rate} okuUSD`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Wrap failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
