/**
 * Fork Setup: Configure missing allowances by impersonating the deployer
 * 
 * This script sets up the fork state to match what it should be after a proper deployment.
 * On Sepolia, the deployer is 0x3CB68a6762041aA05E762814A8791CA9d98E79A0
 */
import { ethers, network } from "hardhat";
import { DEV_WALLET_ADDRESS } from "../config/chains";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";
import { getDeployedContract, waitForTx } from "../utils/deploy";
import { ROLES } from "../config/roles";
import { resolveNetworkContext } from "../utils/networkContext";

// Use centralized deployer address
const DEPLOYER = DEV_WALLET_ADDRESS;

async function main() {
  const { networkName, bookKey, isFork } = await resolveNetworkContext();
  if (!isFork) {
    throw new Error(`fork-setup.ts is only useful on a local fork; current network "${network.name}" is live.`);
  }
  logger.section(`Fork Setup for ${networkName} (book key: ${bookKey})`);

  // Get contracts from the resolved book key. OkuBridge / OkuBridgeRouter were
  // removed in the noBridge refactor.
  const okuMoneyAddr = loadAddress(bookKey, "OkuMoney");
  const litePSMAddr = loadAddress(bookKey, "LitePSM");
  const redemptionQueueAddr = loadAddress(bookKey, "RedemptionQueue");

  // Impersonate deployer
  logger.info(`Impersonating deployer: ${DEPLOYER}`);
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [DEPLOYER],
  });

  // Fund deployer with ETH for gas
  const [funder] = await ethers.getSigners();
  await funder.sendTransaction({
    to: DEPLOYER,
    value: ethers.parseEther("1"),
  });

  const deployer = await ethers.getSigner(DEPLOYER);
  const okuMoney = (await getDeployedContract("OkuMoney", okuMoneyAddr)).connect(deployer);

  // Check current state
  const currentAllowance = await okuMoney.minterAllowance(litePSMAddr);
  logger.info(`Current LitePSM allowance: ${ethers.formatUnits(currentAllowance, 18)}`);

  if (currentAllowance > 0n) {
    logger.success("Minter allowance already configured!");
    await network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [DEPLOYER],
    });
    return;
  }

  // Grant ALLOWANCE_MANAGER role to deployer first (using admin role).
  // Role aliases were removed from the contracts in favour of the shared `Roles` library.
  const ALLOWANCE_MANAGER_ROLE = ROLES.OKUM_ALLOWANCE_MANAGER;
  const hasAllowanceManager = await okuMoney.hasRole(ALLOWANCE_MANAGER_ROLE, DEPLOYER);
  
  if (!hasAllowanceManager) {
    logger.step(0, "Granting ALLOWANCE_MANAGER role to deployer");
    await waitForTx(
      await okuMoney.grantRole(ALLOWANCE_MANAGER_ROLE, DEPLOYER),
      "Grant ALLOWANCE_MANAGER"
    );
  }

  // Configure minter allowances (1 billion tokens each)
  const minterAllowance = ethers.parseUnits("1000000000", 18);

  logger.step(1, "Configuring LitePSM minter allowance");
  await waitForTx(
    await okuMoney.configureMinterAllowance(litePSMAddr, minterAllowance),
    "Configure LitePSM allowance"
  );

  logger.step(2, "Configuring RedemptionQueue minter allowance");
  await waitForTx(
    await okuMoney.configureMinterAllowance(redemptionQueueAddr, minterAllowance),
    "Configure RedemptionQueue allowance"
  );

  // Verify
  const newAllowance = await okuMoney.minterAllowance(litePSMAddr);
  logger.success(`LitePSM allowance now: ${ethers.formatUnits(newAllowance, 18)}`);

  // Stop impersonating
  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [DEPLOYER],
  });

  logger.section("Fork Setup Complete");
  logger.success("All minter allowances configured");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Fork setup failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
