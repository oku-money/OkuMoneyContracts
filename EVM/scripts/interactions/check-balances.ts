/**
 * Check OkuMoney and OkuDollar balances on all deployed chains
 * Usage: npx hardhat run scripts/interactions/check-balances.ts
 */

import { ethers } from "hardhat";
import { getNetworkName, getChainConfig } from "../config/chains";
import { loadAddressBook, hasAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract } from "../utils/deploy";

async function checkBalancesForNetwork(network: string, userAddress: string) {
  const chainConfig = getChainConfig(network);

  logger.section(`Balances on ${chainConfig.name}`);

  // Check if contracts are deployed on this network
  if (!hasAddress(network, "OkuMoney")) {
    logger.warning(`No contracts deployed on ${network}`);
    return;
  }

  // Connect to the network
  const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);

  // Load deployed contract addresses
  const addressBook = loadAddressBook();
  const addresses = addressBook[network];

  const okuMoneyAddress = addresses.OkuMoney;
  const okuDollarAddress = addresses.OkuDollar;

  // Get contract instances
  const okuMoney = new ethers.Contract(
    okuMoneyAddress,
    ["function balanceOf(address) view returns (uint256)", "function okuMPrice() view returns (uint256)"],
    provider
  );

  const okuDollar = new ethers.Contract(
    okuDollarAddress,
    [
      "function balanceOf(address) view returns (uint256)",
      "function totalAssets() view returns (uint256)",
      "function totalSupply() view returns (uint256)",
      "function convertToAssets(uint256) view returns (uint256)",
      "function usdMultiplier() view returns (uint256)",
    ],
    provider
  );

  // Get OkuMoney balance
  const okuMoneyBalance = await okuMoney.balanceOf(userAddress);
  logger.info(`OkuMoney balance: ${ethers.formatUnits(okuMoneyBalance, 18)} OkuM`);

  // Get OkuM price
  try {
    const okuMPrice = await okuMoney.okuMPrice();
    logger.info(`OkuM Price: ${ethers.formatUnits(okuMPrice, 18)}`);
  } catch (e) {
    // okuMPrice might not exist on older versions
  }

  // Get OkuDollar balance
  const okuDollarBalance = await okuDollar.balanceOf(userAddress);
  logger.info(`OkuDollar balance: ${ethers.formatUnits(okuDollarBalance, 18)} usdOku`);

  // Convert OkuDollar to OkuMoney assets
  if (okuDollarBalance > 0n) {
    const okuDollarAssets = await okuDollar.convertToAssets(okuDollarBalance);
    logger.info(`OkuDollar value: ${ethers.formatUnits(okuDollarAssets, 18)} OkuM`);
  }

  // Get OkuDollar stats
  const totalAssets = await okuDollar.totalAssets();
  const totalSupply = await okuDollar.totalSupply();
  logger.info(`OkuDollar total assets: ${ethers.formatUnits(totalAssets, 18)} OkuM`);
  logger.info(`OkuDollar total supply: ${ethers.formatUnits(totalSupply, 18)} usdOku`);

  // Get USD multiplier
  try {
    const usdMultiplier = await okuDollar.usdMultiplier();
    logger.info(`USD Multiplier: ${ethers.formatUnits(usdMultiplier, 18)}`);
  } catch (e) {
    // Might not exist
  }

  if (totalSupply > 0n) {
    const rate = (Number(totalAssets) / Number(totalSupply)).toFixed(6);
    logger.info(`Conversion rate: 1 usdOku = ${rate} OkuM`);
  }
}

async function main() {
  logger.section("Checking Balances Across All Networks");

  const [user] = await ethers.getSigners();
  logger.info(`User address: ${user.address}\n`);

  // Load address book to see which networks have deployments
  const addressBook = loadAddressBook();
  const deployedNetworks = Object.keys(addressBook);

  if (deployedNetworks.length === 0) {
    logger.warning("No contracts deployed yet. Run deployment scripts first.");
    process.exit(0);
  }

  // Check balances on each deployed network
  for (const network of deployedNetworks) {
    try {
      await checkBalancesForNetwork(network, user.address);
    } catch (error: any) {
      logger.error(`Failed to check balances on ${network}: ${error.message}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Check balances failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
