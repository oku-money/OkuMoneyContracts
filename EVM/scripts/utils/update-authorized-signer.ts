/**
 * Update the authorized signer on OkuBridge to match the default Hardhat signer
 * This is needed for local testing when the deployed signer differs from Hardhat's default
 */

import { ethers } from "hardhat";
import { loadAddress } from "../utils/addressBook";
import { getNetworkName, DEV_WALLET_ADDRESS } from "../config/chains";

async function main() {
  const network = getNetworkName();
  const [signer] = await ethers.getSigners();
  
  const bridgeAddress = loadAddress(network, "OkuBridge");
  console.log("Bridge address:", bridgeAddress);
  
  // Get current authorized signer
  const bridge = await ethers.getContractAt("OkuBridge", bridgeAddress);
  const currentSigner = await bridge.authorizedSigner();
  console.log("Current authorized signer:", currentSigner);
  console.log("Target signer:", signer.address);
  
  if (currentSigner.toLowerCase() === signer.address.toLowerCase()) {
    console.log("Signers already match, nothing to do");
    return;
  }
  
  // Impersonate the admin (current authorized signer who has BRIDGE_SIGNER_ADMIN role)
  // On localhost, the deployer has all roles
  const adminAddress = DEV_WALLET_ADDRESS;
  await ethers.provider.send("hardhat_impersonateAccount", [adminAddress]);
  const admin = await ethers.getSigner(adminAddress);
  
  // Connect bridge with admin
  const bridgeAsAdmin = bridge.connect(admin);
  
  // Set the new authorized signer
  console.log("Setting authorized signer to:", signer.address);
  const tx = await bridgeAsAdmin.updateAuthorizedSigner(signer.address);
  await tx.wait();
  console.log("Done!");
  
  // Verify
  const newSigner = await bridge.authorizedSigner();
  console.log("New authorized signer:", newSigner);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
