/**
 * Wrap OkuMoney to OkuDollar (ERC4626 deposit)
 * Usage: NETWORK=localhost AMOUNT=5000 npx hardhat run scripts/interactions/wrap-okumoney.ts --network localhost
 */

import { ethers } from "hardhat";
import { getNetworkName, getChainConfig } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract, waitForTx } from "../utils/deploy";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Wrapping OkuMoney on ${chainConfig.name}`);

  const [user] = await ethers.getSigners();
  logger.info(`User address: ${user.address}`);

  // Get amount from environment or use default (1000 OkuMoney)
  const amountStr = process.env.AMOUNT || "1000";
  const okuMoneyAmount = ethers.parseUnits(amountStr, 18);

  logger.info(`Wrapping ${amountStr} OkuM to usdOku`);

  // Load deployed contract addresses
  const okuDollarAddress = loadAddress(network, "OkuDollar");
  const okuMoneyAddress = loadAddress(network, "OkuMoney");

  // Get contract instances
  const okuDollar = await getDeployedContract("OkuDollar", okuDollarAddress);
  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddress);

  // Check OkuMoney balance
  const okuMoneyBalance = await okuMoney.balanceOf(user.address);
  logger.info(`OkuMoney balance: ${ethers.formatUnits(okuMoneyBalance, 18)}`);

  if (okuMoneyBalance < okuMoneyAmount) {
    logger.error(`Insufficient OkuMoney balance. Need ${amountStr}, have ${ethers.formatUnits(okuMoneyBalance, 18)}`);
    logger.info("Run mint-okumoney.ts first to mint OkuMoney");
    process.exit(1);
  }

  // Check OkuDollar balance before wrapping
  const okuDollarBalanceBefore = await okuDollar.balanceOf(user.address);
  logger.info(`OkuDollar balance before: ${ethers.formatUnits(okuDollarBalanceBefore, 18)}`);

  // Approve OkuMoney to OkuDollar
  logger.step(1, "Approving OkuMoney to OkuDollar");
  await waitForTx(
    await okuMoney.approve(okuDollarAddress, okuMoneyAmount),
    "Approve OkuMoney"
  );

  // Wrap OkuMoney to OkuDollar (with 0 minAmountOut for testing)
  logger.step(2, "Wrapping OkuMoney to OkuDollar");
  await waitForTx(
    await okuDollar.wrap(okuMoneyAmount, user.address, 0n),
    "Wrap OkuMoney"
  );

  // Check OkuDollar balance after wrapping
  const okuDollarBalanceAfter = await okuDollar.balanceOf(user.address);
  logger.info(`OkuDollar balance after: ${ethers.formatUnits(okuDollarBalanceAfter, 18)}`);

  const wrapped = okuDollarBalanceAfter - okuDollarBalanceBefore;
  logger.section("Wrap Summary");
  logger.success(`Wrapped ${amountStr} OkuM to ${ethers.formatUnits(wrapped, 18)} usdOku`);

  // Show conversion rate
  const totalReserves = await okuDollar.totalOkuMReserves();
  const totalSupply = await okuDollar.totalSupply();
  if (totalSupply > 0n) {
    const rate = (Number(totalReserves) / Number(totalSupply)).toFixed(6);
    logger.info(`Current conversion rate: 1 usdOku = ${rate} OkuM`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Wrap failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
