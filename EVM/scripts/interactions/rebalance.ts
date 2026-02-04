/**
 * Update reward multiplier (rebase) on OkuUSD
 * Usage: NETWORK=localhost MULTIPLIER=1.05 npx hardhat run scripts/interactions/rebalance.ts --network localhost
 */

import { ethers } from "hardhat";
import { getNetworkName, getChainConfig } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract, waitForTx } from "../utils/deploy";

async function main() {
  const network = getNetworkName();
  const chainConfig = getChainConfig(network);

  logger.section(`Updating Reward Multiplier on ${chainConfig.name}`);

  const [admin] = await ethers.getSigners();
  logger.info(`Admin address: ${admin.address}`);

  // Get multiplier from environment or use default (1.05 = 5% yield)
  const multiplierStr = process.env.MULTIPLIER || "1.05";
  const multiplierFloat = parseFloat(multiplierStr);

  if (isNaN(multiplierFloat) || multiplierFloat <= 0) {
    logger.error(`Invalid multiplier: ${multiplierStr}. Must be a positive number.`);
    process.exit(1);
  }

  // Convert to 18 decimal fixed point
  const newMultiplier = ethers.parseUnits(multiplierStr, 18);

  logger.info(`Setting new reward multiplier to ${multiplierStr} (${(multiplierFloat - 1) * 100}% yield)`);

  // Load deployed contract addresses
  const okuUSDAddress = loadAddress(network, "OkuUSD");

  // Get contract instance
  const okuUSD = await getDeployedContract("OkuUSD", okuUSDAddress);

  // Check current multiplier
  const currentMultiplier = await okuUSD.rewardMultiplier();
  logger.info(`Current multiplier: ${ethers.formatUnits(currentMultiplier, 18)}`);

  if (newMultiplier <= currentMultiplier) {
    logger.warning("New multiplier is not greater than current multiplier");
    logger.warning("Note: updateRewardMultiplier may revert if new multiplier is not strictly greater");
  }

  // Update reward multiplier
  logger.step(1, "Updating reward multiplier");
  try {
    await waitForTx(
      await okuUSD.updateRewardMultiplier(newMultiplier),
      "Update reward multiplier"
    );
  } catch (error: any) {
    if (error.message.includes("InvalidMultiplier")) {
      logger.error("New multiplier must be strictly greater than current multiplier");
    } else if (error.message.includes("AccessControl")) {
      logger.error("Caller does not have REBASER_ROLE");
    } else {
      throw error;
    }
    process.exit(1);
  }

  // Check updated multiplier
  const updatedMultiplier = await okuUSD.rewardMultiplier();
  logger.info(`Updated multiplier: ${ethers.formatUnits(updatedMultiplier, 18)}`);

  logger.section("Rebalance Summary");
  logger.success(`Multiplier updated from ${ethers.formatUnits(currentMultiplier, 18)} to ${ethers.formatUnits(updatedMultiplier, 18)}`);

  const yieldPercent = ((Number(updatedMultiplier) / Number(currentMultiplier) - 1) * 100).toFixed(2);
  logger.success(`All OkuUSD balances increased by ${yieldPercent}%`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Rebalance failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
