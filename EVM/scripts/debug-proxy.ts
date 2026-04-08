/**
 * Debug proxy deployment - check implementation slot
 */
import { ethers } from "hardhat";

async function main() {
  const litePSMAddress = "0x9D32cfA5955f9D5735f5edD445a3E867A949d615";
  
  // Check bytecode at proxy
  const code = await ethers.provider.getCode(litePSMAddress);
  console.log("LitePSM proxy bytecode length:", code.length);
  
  // EIP-1967 implementation slot
  const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implData = await ethers.provider.getStorage(litePSMAddress, implSlot);
  console.log("Implementation slot data:", implData);
  
  // Convert to address
  const implAddr = "0x" + implData.slice(26);
  console.log("Implementation address:", implAddr);
  
  // Check implementation bytecode
  const implCode = await ethers.provider.getCode(implAddr);
  console.log("Implementation bytecode length:", implCode.length);
  
  // Try calling a view function directly
  const Factory = await ethers.getContractFactory("LitePSM");
  const litePSM = Factory.attach(litePSMAddress);
  
  try {
    const okuMoney = await litePSM.okuMoney();
    console.log("LitePSM.okuMoney():", okuMoney);
  } catch (e: any) {
    console.log("Error calling okuMoney():", e.message);
  }
  
  // Try calling usdc()
  try {
    const usdc = await litePSM.usdc();
    console.log("LitePSM.usdc():", usdc);
  } catch (e: any) {
    console.log("Error calling usdc():", e.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
