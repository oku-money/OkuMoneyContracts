/**
 * Simple USDC deal script - directly sets USDC balance using hardhat_setStorageAt
 * This is more reliable than whale impersonation for testing
 *
 * Usage: AMOUNT=100000 npx hardhat run scripts/utils/deal-usdc.ts --network localhost
 */

import { ethers, network } from "hardhat";
import { getChainConfig, getNetworkName } from "../config/chains";
import { logger } from "./logger";

async function main() {
  const networkName = getNetworkName();
  const chainConfig = getChainConfig(networkName);

  logger.section(`Dealing USDC on ${chainConfig.name}`);

  const [recipient] = await ethers.getSigners();
  logger.info(`Recipient address: ${recipient.address}`);

  // Get amount from environment or use default (100,000 USDC)
  const amountStr = process.env.AMOUNT || "100000";
  const usdcAmount = ethers.parseUnits(amountStr, 6); // USDC has 6 decimals

  logger.info(`Dealing ${amountStr} USDC`);

  // Get USDC contract
  const usdc = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)", "function transfer(address,uint256) returns (bool)"],
    chainConfig.usdc
  );

  // Check current balance
  const balanceBefore = await usdc.balanceOf(recipient.address);
  logger.info(`USDC balance before: ${ethers.formatUnits(balanceBefore, 6)}`);

  logger.step(1, "Finding USDC storage slot for balances");

  // USDC on Optimism uses a standard ERC20 storage layout
  // For most ERC20 tokens, balances are in slot 0
  // We need to find the storage slot: keccak256(abi.encode(address, slot))

  let found = false;
  let balanceSlot = 0;

  // Try common balance slots (0-10)
  for (let slot = 0; slot < 20; slot++) {
    try {
      // Calculate storage slot for mapping: keccak256(address + slot)
      const paddedAddress = ethers.zeroPadValue(recipient.address, 32);
      const paddedSlot = ethers.zeroPadValue(ethers.toBeHex(slot), 32);
      const storageSlot = ethers.keccak256(ethers.concat([paddedAddress, paddedSlot]));

      // Get current value at this slot
      const currentValue = await ethers.provider.getStorage(chainConfig.usdc, storageSlot);

      // Try setting a test value
      await network.provider.send("hardhat_setStorageAt", [
        chainConfig.usdc,
        storageSlot,
        ethers.zeroPadValue(ethers.toBeHex(ethers.parseUnits("12345", 6)), 32),
      ]);

      // Check if balance changed
      const testBalance = await usdc.balanceOf(recipient.address);

      if (testBalance === ethers.parseUnits("12345", 6)) {
        logger.success(`Found balance slot: ${slot}`);
        balanceSlot = slot;
        found = true;

        // Restore original value before continuing
        await network.provider.send("hardhat_setStorageAt", [
          chainConfig.usdc,
          storageSlot,
          currentValue,
        ]);

        break;
      }
    } catch (error) {
      // Slot doesn't work, try next
      continue;
    }
  }

  if (!found) {
    logger.error("Could not find USDC balance storage slot");
    logger.info("Falling back to whale impersonation method...");
    logger.info("Run: npx hardhat run scripts/utils/get-usdc-fork.ts --network localhost");
    process.exit(1);
  }

  logger.step(2, "Setting USDC balance");

  // Calculate storage slot for this address
  const paddedAddress = ethers.zeroPadValue(recipient.address, 32);
  const paddedSlot = ethers.zeroPadValue(ethers.toBeHex(balanceSlot), 32);
  const storageSlot = ethers.keccak256(ethers.concat([paddedAddress, paddedSlot]));

  // Set the balance
  await network.provider.send("hardhat_setStorageAt", [
    chainConfig.usdc,
    storageSlot,
    ethers.zeroPadValue(ethers.toBeHex(usdcAmount), 32),
  ]);

  // Verify the balance
  const balanceAfter = await usdc.balanceOf(recipient.address);
  logger.info(`USDC balance after: ${ethers.formatUnits(balanceAfter, 6)}`);

  logger.section("Summary");
  logger.success(`Successfully dealt ${ethers.formatUnits(balanceAfter, 6)} USDC`);
  logger.success("Ready to mint OkuUSD!");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Failed to deal USDC: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
