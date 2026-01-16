import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const bridgeToken = await get("BridgeToken");
  console.log("Using BridgeToken at:", bridgeToken.address);

  // Use mock for local/test networks, real address for production
  let oftAdapterAddress: string;

  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("Deploying MockOFTAdapter for local testing...");
    const mockOft = await deploy("MockOFTAdapter", {
      from: deployer,
      args: [bridgeToken.address],
      log: true,
      autoMine: true,
    });
    oftAdapterAddress = mockOft.address;
    console.log("MockOFTAdapter deployed to:", oftAdapterAddress);
  } else {
    oftAdapterAddress = process.env.OFT_ADAPTER_ADDRESS || "";
    if (!oftAdapterAddress) {
      throw new Error("OFT_ADAPTER_ADDRESS not set for production deployment");
    }
    console.log("Using existing OFT Adapter at:", oftAdapterAddress);
  }

  console.log("Deploying OFTBridgeAdapter...");
  const oftAdapter = await deploy("OFTBridgeAdapter", {
    from: deployer,
    args: [oftAdapterAddress, bridgeToken.address, deployer],
    log: true,
    autoMine: true,
  });
  console.log("OFTBridgeAdapter deployed to:", oftAdapter.address);

  // Grant MINTER_ROLE to adapter
  const BridgeToken = await hre.ethers.getContractAt("BridgeToken", bridgeToken.address);
  const MINTER_ROLE = await BridgeToken.MINTER_ROLE();
  const hasRole = await BridgeToken.hasRole(MINTER_ROLE, oftAdapter.address);

  if (!hasRole) {
    console.log("Granting MINTER_ROLE to OFTBridgeAdapter...");
    const tx = await BridgeToken.grantRole(MINTER_ROLE, oftAdapter.address);
    await tx.wait();
    console.log("MINTER_ROLE granted to OFTBridgeAdapter");
  } else {
    console.log("OFTBridgeAdapter already has MINTER_ROLE");
  }

  // For local testing, also grant MINTER_ROLE to MockOFTAdapter
  if (network.name === "hardhat" || network.name === "localhost") {
    const mockHasRole = await BridgeToken.hasRole(MINTER_ROLE, oftAdapterAddress);
    if (!mockHasRole) {
      console.log("Granting MINTER_ROLE to MockOFTAdapter...");
      const tx = await BridgeToken.grantRole(MINTER_ROLE, oftAdapterAddress);
      await tx.wait();
      console.log("MINTER_ROLE granted to MockOFTAdapter");
    }
  }
};

func.tags = ["OFTAdapter"];
func.dependencies = ["BridgeToken"];
export default func;
