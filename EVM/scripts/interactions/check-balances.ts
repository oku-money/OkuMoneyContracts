/**
 * Check OkuUSD and wOkuUSD balances on all deployed chains
 * Usage: npx hardhat run scripts/interactions/check-balances.ts
 */

import { ethers } from "hardhat";
import { getNetworkName, getChainConfig, CHAINS } from "../config/chains";
import { loadAddressBook, hasAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract } from "../utils/deploy";

async function checkBalancesForNetwork(network: string, userAddress: string) {
  const chainConfig = getChainConfig(network);

  logger.section(`Balances on ${chainConfig.name}`);

  // Check if contracts are deployed on this network
  if (!hasAddress(network, "OkuUSD")) {
    logger.warning(`No contracts deployed on ${network}`);
    return;
  }

  // Connect to the network
  const provider = new ethers.JsonRpcProvider(chainConfig.rpcUrl);

  // Load deployed contract addresses
  const addressBook = loadAddressBook();
  const addresses = addressBook[network];

  const okuUSDAddress = addresses.OkuUSD;
  const wOkuUSDAddress = addresses.wOkuUSD;

  // Get contract instances
  const okuUSD = new ethers.Contract(
    okuUSDAddress,
    ["function balanceOf(address) view returns (uint256)", "function rewardMultiplier() view returns (uint256)"],
    provider
  );

  const wOkuUSD = new ethers.Contract(
    wOkuUSDAddress,
    [
      "function balanceOf(address) view returns (uint256)",
      "function totalAssets() view returns (uint256)",
      "function totalSupply() view returns (uint256)",
      "function convertToAssets(uint256) view returns (uint256)",
    ],
    provider
  );

  // Get OkuUSD balance
  const okuUSDBalance = await okuUSD.balanceOf(userAddress);
  logger.info(`OkuUSD balance: ${ethers.formatUnits(okuUSDBalance, 18)}`);

  // Get reward multiplier
  const rewardMultiplier = await okuUSD.rewardMultiplier();
  logger.info(`Reward multiplier: ${ethers.formatUnits(rewardMultiplier, 18)}`);

  // Get wOkuUSD balance
  const wOkuUSDBalance = await wOkuUSD.balanceOf(userAddress);
  logger.info(`wOkuUSD shares: ${ethers.formatUnits(wOkuUSDBalance, 18)}`);

  // Convert wOkuUSD shares to assets
  if (wOkuUSDBalance > 0n) {
    const wOkuUSDAssets = await wOkuUSD.convertToAssets(wOkuUSDBalance);
    logger.info(`wOkuUSD value: ${ethers.formatUnits(wOkuUSDAssets, 18)} okuUSD`);
  }

  // Get wOkuUSD stats
  const totalAssets = await wOkuUSD.totalAssets();
  const totalSupply = await wOkuUSD.totalSupply();
  logger.info(`wOkuUSD total assets: ${ethers.formatUnits(totalAssets, 18)}`);
  logger.info(`wOkuUSD total supply: ${ethers.formatUnits(totalSupply, 18)}`);

  if (totalSupply > 0n) {
    const rate = (Number(totalAssets) / Number(totalSupply)).toFixed(6);
    logger.info(`Conversion rate: 1 wOkuUSD = ${rate} okuUSD`);
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
