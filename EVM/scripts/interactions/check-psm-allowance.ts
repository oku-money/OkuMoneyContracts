/**
 * Check PSM minter allowance and roles
 */
import { ethers } from "hardhat";
import { getNetworkName } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract } from "../utils/deploy";

async function main() {
  const network = getNetworkName();
  logger.section(`Checking PSM Allowance on ${network}`);

  const okuMoneyAddr = loadAddress(network, "OkuMoney");
  const litePSMAddr = loadAddress(network, "LitePSM");

  const okuMoney = await getDeployedContract("OkuMoney", okuMoneyAddr);

  // Check if LitePSM has MINTER role
  const MINTER_ROLE = await okuMoney.OKUM_MINTER();
  const hasRole = await okuMoney.hasRole(MINTER_ROLE, litePSMAddr);
  logger.info(`LitePSM has OKUM_MINTER role: ${hasRole}`);

  // Check minter allowance
  const allowance = await okuMoney.minterAllowance(litePSMAddr);
  logger.info(`LitePSM minter allowance: ${ethers.formatUnits(allowance, 18)}`);

  // Check okuMMultiplier
  const multiplier = await okuMoney.okuMMultiplier();
  logger.info(`OkuMoney multiplier: ${ethers.formatUnits(multiplier, 18)}`);

  // Check max supply
  const maxSupply = await okuMoney.maxSupply();
  const totalSupply = await okuMoney.totalSupply();
  logger.info(`Max supply: ${ethers.formatUnits(maxSupply, 18)}`);
  logger.info(`Total supply: ${ethers.formatUnits(totalSupply, 18)}`);

  // Check if PSM is paused
  const litePSM = await getDeployedContract("LitePSM", litePSMAddr);
  const isPaused = await litePSM.paused();
  logger.info(`LitePSM paused: ${isPaused}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Check failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
