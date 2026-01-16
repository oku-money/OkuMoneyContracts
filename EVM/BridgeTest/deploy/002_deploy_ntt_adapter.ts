import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts, network } = hre;
  const { deploy, get } = deployments;
  const { deployer } = await getNamedAccounts();

  const bridgeToken = await get("BridgeToken");
  console.log("Using BridgeToken at:", bridgeToken.address);

  // Use mock for local/test networks, real address for production
  let nttManagerAddress: string;

  if (network.name === "hardhat" || network.name === "localhost") {
    console.log("Deploying MockNttManager for local testing...");
    const mockNtt = await deploy("MockNttManager", {
      from: deployer,
      args: [bridgeToken.address],
      log: true,
      autoMine: true,
    });
    nttManagerAddress = mockNtt.address;
    console.log("MockNttManager deployed to:", nttManagerAddress);
  } else {
    nttManagerAddress = process.env.NTT_MANAGER_ADDRESS || "";
    if (!nttManagerAddress) {
      throw new Error("NTT_MANAGER_ADDRESS not set for production deployment");
    }
    console.log("Using existing NTT Manager at:", nttManagerAddress);
  }

  console.log("Deploying NttBridgeAdapter...");
  const nttAdapter = await deploy("NttBridgeAdapter", {
    from: deployer,
    args: [nttManagerAddress, bridgeToken.address, deployer],
    log: true,
    autoMine: true,
  });
  console.log("NttBridgeAdapter deployed to:", nttAdapter.address);

  // Grant MINTER_ROLE to adapter
  const BridgeToken = await hre.ethers.getContractAt("BridgeToken", bridgeToken.address);
  const MINTER_ROLE = await BridgeToken.MINTER_ROLE();
  const hasRole = await BridgeToken.hasRole(MINTER_ROLE, nttAdapter.address);

  if (!hasRole) {
    console.log("Granting MINTER_ROLE to NttBridgeAdapter...");
    const tx = await BridgeToken.grantRole(MINTER_ROLE, nttAdapter.address);
    await tx.wait();
    console.log("MINTER_ROLE granted to NttBridgeAdapter");
  } else {
    console.log("NttBridgeAdapter already has MINTER_ROLE");
  }

  // For local testing, also grant MINTER_ROLE to MockNttManager
  if (network.name === "hardhat" || network.name === "localhost") {
    const mockHasRole = await BridgeToken.hasRole(MINTER_ROLE, nttManagerAddress);
    if (!mockHasRole) {
      console.log("Granting MINTER_ROLE to MockNttManager...");
      const tx = await BridgeToken.grantRole(MINTER_ROLE, nttManagerAddress);
      await tx.wait();
      console.log("MINTER_ROLE granted to MockNttManager");
    }
  }
};

func.tags = ["NttAdapter"];
func.dependencies = ["BridgeToken"];
export default func;
