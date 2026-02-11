/**
 * Configure OkuBridge for testing
 */
import { ethers } from "hardhat";
import { loadAddress } from "../utils/addressBook";
import { getDeployedContract } from "../utils/deploy";
import { logger } from "../utils/logger";

async function main() {
  logger.section("Configuring OkuBridge for Testing");

  const network = "localhost";
  const bridgeAddress = loadAddress(network, "OkuBridge");
  const bridge = await getDeployedContract("OkuBridge", bridgeAddress);

  const [admin] = await ethers.getSigners();
  logger.info(`Admin address: ${admin.address}`);
  logger.info(`Bridge address: ${bridgeAddress}`);

  // Add Arbitrum (42161) as supported chain
  logger.step(1, "Adding Arbitrum (42161) as supported chain");
  const tx1 = await bridge.addSupportedChain(42161n);
  await tx1.wait();
  logger.success("Chain 42161 added");

  // Add localhost (31337) for same-chain testing
  logger.step(1.5, "Adding localhost (31337) for testing");
  const tx1b = await bridge.addSupportedChain(31337n);
  await tx1b.wait();
  logger.success("Chain 31337 added");

  // Set admin as authorized signer (for testing)
  logger.step(2, "Setting authorized signer");
  const tx2 = await bridge.updateAuthorizedSigner(admin.address);
  await tx2.wait();
  logger.success(`Authorized signer set to: ${admin.address}`);

  // Verify configuration
  logger.step(3, "Verifying configuration");
  const isSupported = await bridge.supportedChains(42161n);
  const authorizedSigner = await bridge.authorizedSigner();

  logger.info(`Chain 42161 supported: ${isSupported}`);
  logger.info(`Authorized signer: ${authorizedSigner}`);

  if (isSupported && authorizedSigner === admin.address) {
    logger.success("Bridge configured successfully!");
  } else {
    logger.error("Bridge configuration failed!");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
