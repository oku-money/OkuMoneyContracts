import { HardhatRuntimeEnvironment } from "hardhat/types";
import { DeployFunction } from "hardhat-deploy/types";

const func: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;
  const { deployer } = await getNamedAccounts();

  console.log("Deploying BridgeToken with deployer:", deployer);

  const result = await deploy("BridgeToken", {
    from: deployer,
    args: ["BridgeTestToken", "BTT", deployer],
    log: true,
    autoMine: true,
  });

  console.log("BridgeToken deployed to:", result.address);
};

func.tags = ["BridgeToken"];
export default func;
