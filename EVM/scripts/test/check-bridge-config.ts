/**
 * Check bridge configuration on localhost
 */

import { ethers } from "hardhat";
import { loadAddress } from "../utils/addressBook";
import { logger } from "../utils/logger";

async function main() {
  const network = "localhost";
  
  logger.section("OkuBridge Configuration Check");
  
  const bridgeAddr = loadAddress(network, "OkuBridge");
  const bridge = await ethers.getContractAt("OkuBridge", bridgeAddr);
  
  const chainId = (await ethers.provider.getNetwork()).chainId;
  logger.info(`Current chain ID: ${chainId}`);
  logger.info(`Bridge address: ${bridgeAddr}`);
  
  // Check supported chains
  const chains = [103, 420, 101, 10, 11155420, 31337];
  
  logger.section("Supported Chains");
  for (const id of chains) {
    const supported = await bridge.supportedChains(id);
    logger.info(`Chain ${id}: ${supported ? 'YES' : 'NO'}`);
  }
  
  // Check authorized signer
  const signer = await bridge.authorizedSigner();
  logger.info(`Authorized signer: ${signer}`);
  
  // Check inbound nonces
  logger.section("Inbound Nonces");
  for (const id of chains) {
    const nonce = await bridge.inboundNonce(id);
    if (nonce > 0n || [103, 420].includes(id)) {
      logger.info(`Chain ${id}: nonce = ${nonce}`);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
