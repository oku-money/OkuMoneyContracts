/**
 * Unified Deployment Script for OkuMoney EVM Contracts
 *
 * Deploys all contracts and configures roles in a single execution.
 * Works for both local fork testing (via hardhat network) and live testnet.
 *
 * Usage:
 *   # Local fork (auto-forks OP Sepolia via hardhat.config.ts)
 *   npx hardhat run scripts/deploy/index.ts --network hardhat
 *
 *   # Live testnet
 *   npx hardhat run scripts/deploy/index.ts --network opSepolia
 *
 * Options (via env vars):
 *   SKIP_MOCK_USDC=true   - Skip MockUSDC deployment (use existing USDC)
 *   RESET_FORK=true       - Reset hardhat fork to clean state before deploying
 *   VERIFY=true           - Verify contracts on Etherscan after deployment
 */

import { ethers, network, upgrades } from "hardhat";
import { Contract } from "ethers";
import { saveAddress, loadAddressBook, saveAddressBook } from "../utils/addressBook";
import { getNetworkName, getChainConfig, SOLANA_DEVNET_CHAIN_ID } from "../config/chains";
import { ROLES } from "../config/roles";
import { logger } from "../utils/logger";

// ============================================================================
// Configuration
// ============================================================================

interface DeploymentConfig {
  maxSupply: bigint;
  minterAllowance: bigint;
  bridgeFee: bigint;
  minBridgeAmount: bigint;
  maxBridgeAmount: bigint;
  bridgeDeadline: bigint;
}

function getDeploymentConfig(): DeploymentConfig {
  return {
    maxSupply: ethers.parseUnits("1000000000", 18), // 1 billion
    minterAllowance: ethers.parseUnits("1000000000", 18), // 1 billion
    bridgeFee: 10n, // 0.1% (10 bps)
    minBridgeAmount: ethers.parseUnits("1", 18), // 1 OkuM
    maxBridgeAmount: ethers.parseUnits("100000", 18), // 100,000 OkuM
    bridgeDeadline: 3600n, // 1 hour
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

async function waitForTx(tx: any, description: string): Promise<void> {
  logger.info(`  ${description}...`);
  const receipt = await tx.wait();
  logger.success(`  ${description} - block ${receipt.blockNumber}`);
}

async function deployUUPSProxy(
  contractName: string,
  initArgs: any[],
  networkName: string
): Promise<Contract> {
  const Factory = await ethers.getContractFactory(contractName);
  const proxy = await upgrades.deployProxy(Factory, initArgs, { kind: "uups" });
  await proxy.waitForDeployment();
  const address = await proxy.getAddress();
  saveAddress(networkName, contractName, address);
  return proxy;
}

async function deployTransparentProxy(
  contractName: string,
  initArgs: any[],
  networkName: string
): Promise<Contract> {
  const Factory = await ethers.getContractFactory(contractName);
  const proxy = await upgrades.deployProxy(Factory, initArgs, { kind: "transparent" });
  await proxy.waitForDeployment();
  const address = await proxy.getAddress();
  saveAddress(networkName, contractName, address);
  return proxy;
}

// ============================================================================
// Deployment Steps
// ============================================================================

async function deployMockUSDC(deployer: any, networkName: string): Promise<string> {
  logger.step(1, "Deploying MockUSDC");

  const MockUSDC = await ethers.getContractFactory("MockUSDC");
  const mockUsdc = await MockUSDC.deploy();
  await mockUsdc.waitForDeployment();

  const address = await mockUsdc.getAddress();
  saveAddress(networkName, "MockUSDC", address);
  logger.success(`  MockUSDC: ${address}`);

  return address;
}

async function deployCoreContracts(
  deployer: any,
  networkName: string,
  config: DeploymentConfig
): Promise<{ okuMoney: Contract; okuDollar: Contract; redemptionQueue: Contract }> {
  logger.step(2, "Deploying Core Contracts");

  // OkuMoney
  logger.info("  Deploying OkuMoney...");
  const okuMoney = await deployUUPSProxy(
    "OkuMoney",
    ["Oku Money", "OkuM", deployer.address, config.maxSupply],
    networkName
  );
  logger.success(`  OkuMoney: ${await okuMoney.getAddress()}`);

  // OkuDollar
  logger.info("  Deploying OkuDollar...");
  const minCollateralRatio = ethers.parseUnits("1", 18); // 100% (1e18 = 100%)
  const okuDollar = await deployUUPSProxy(
    "OkuDollar",
    [await okuMoney.getAddress(), "Oku Dollar", "usdOku", deployer.address, minCollateralRatio],
    networkName
  );
  logger.success(`  OkuDollar: ${await okuDollar.getAddress()}`);

  // RedemptionQueue
  logger.info("  Deploying RedemptionQueue...");
  const redemptionQueue = await deployUUPSProxy(
    "RedemptionQueue",
    [await okuMoney.getAddress(), deployer.address],
    networkName
  );
  logger.success(`  RedemptionQueue: ${await redemptionQueue.getAddress()}`);

  return { okuMoney, okuDollar, redemptionQueue };
}

async function deployPSM(
  deployer: any,
  networkName: string,
  okuMoneyAddress: string,
  okuDollarAddress: string,
  redemptionQueueAddress: string,
  usdcAddress: string
): Promise<Contract> {
  logger.step(3, "Deploying LitePSM");

  // LitePSM.initialize(okuMoney, usdOku, usdc, redemptionQueue, admin)
  const litePSM = await deployUUPSProxy(
    "LitePSM",
    [
      okuMoneyAddress,          // _okuMoney
      okuDollarAddress,         // _usdOku
      usdcAddress,              // _usdc
      redemptionQueueAddress,   // _redemptionQueue
      deployer.address,         // admin
    ],
    networkName
  );
  logger.success(`  LitePSM: ${await litePSM.getAddress()}`);

  return litePSM;
}

async function deployBridge(
  deployer: any,
  networkName: string,
  okuMoneyAddress: string,
  okuDollarAddress: string
): Promise<{ okuBridge: Contract; bridgeRouter: Contract }> {
  logger.step(4, "Deploying Bridge Contracts");

  // OkuBridge (Transparent Proxy)
  logger.info("  Deploying OkuBridge...");
  const okuBridge = await deployTransparentProxy(
    "OkuBridge",
    [
      okuMoneyAddress,
      deployer.address, // orchestrator signer (deployer for testnet)
      deployer.address, // fee recipient
      deployer.address, // admin
      [BigInt(SOLANA_DEVNET_CHAIN_ID)], // supported chains
    ],
    networkName
  );
  logger.success(`  OkuBridge: ${await okuBridge.getAddress()}`);

  // OkuBridgeRouter (UUPS Proxy)
  logger.info("  Deploying OkuBridgeRouter...");
  const bridgeRouter = await deployUUPSProxy(
    "OkuBridgeRouter",
    [
      okuDollarAddress,
      okuMoneyAddress,
      await okuBridge.getAddress(),
      deployer.address,
    ],
    networkName
  );
  logger.success(`  OkuBridgeRouter: ${await bridgeRouter.getAddress()}`);

  return { okuBridge, bridgeRouter };
}

async function configureRoles(
  deployer: any,
  okuMoney: Contract,
  okuDollar: Contract,
  redemptionQueue: Contract,
  litePSM: Contract,
  okuBridge: Contract,
  bridgeRouter: Contract,
  config: DeploymentConfig
): Promise<void> {
  logger.step(5, "Configuring Roles");

  const litePSMAddress = await litePSM.getAddress();
  const redemptionQueueAddress = await redemptionQueue.getAddress();
  const okuBridgeAddress = await okuBridge.getAddress();
  const bridgeRouterAddress = await bridgeRouter.getAddress();

  // OkuMoney minter roles
  await waitForTx(await okuMoney.grantRole(ROLES.OKUM_MINTER, litePSMAddress), "Grant OKUM_MINTER to LitePSM");
  await waitForTx(await okuMoney.grantRole(ROLES.OKUM_MINTER, redemptionQueueAddress), "Grant OKUM_MINTER to RedemptionQueue");
  await waitForTx(await okuMoney.grantRole(ROLES.OKUM_MINTER, okuBridgeAddress), "Grant OKUM_MINTER to OkuBridge");
  await waitForTx(await okuMoney.grantRole(ROLES.OKUM_MINTER, bridgeRouterAddress), "Grant OKUM_MINTER to OkuBridgeRouter");

  // OkuMoney admin roles (testnet only)
  await waitForTx(await okuMoney.grantRole(ROLES.OKUM_REBASER, deployer.address), "Grant OKUM_REBASER to Admin");
  await waitForTx(await okuMoney.grantRole(ROLES.OKUM_ALLOWANCE_MANAGER, deployer.address), "Grant OKUM_ALLOWANCE_MANAGER to Admin");

  // Minter allowances
  await waitForTx(await okuMoney.configureMinterAllowance(litePSMAddress, config.minterAllowance), "Set LitePSM minter allowance");
  await waitForTx(await okuMoney.configureMinterAllowance(redemptionQueueAddress, config.minterAllowance), "Set RedemptionQueue minter allowance");
  await waitForTx(await okuMoney.configureMinterAllowance(okuBridgeAddress, config.minterAllowance), "Set OkuBridge minter allowance");
  await waitForTx(await okuMoney.configureMinterAllowance(bridgeRouterAddress, config.minterAllowance), "Set OkuBridgeRouter minter allowance");

  // OkuDollar roles
  await waitForTx(await okuDollar.grantRole(ROLES.VAULT_REBASER, deployer.address), "Grant VAULT_REBASER to Admin");

  // RedemptionQueue roles
  await waitForTx(await redemptionQueue.grantRole(ROLES.QUEUE_PSM, litePSMAddress), "Grant QUEUE_PSM to LitePSM");

  // LitePSM roles
  await waitForTx(await litePSM.grantRole(ROLES.PSM_BUFFER_DEPOSITOR, deployer.address), "Grant PSM_BUFFER_DEPOSITOR to Admin");
}

async function configureBridge(
  okuBridge: Contract,
  config: DeploymentConfig
): Promise<void> {
  logger.step(6, "Configuring Bridge (Testnet Settings)");

  await waitForTx(await okuBridge.updateFee(config.bridgeFee), `Set bridge fee to ${config.bridgeFee} bps`);
  
  // Note: updateLimits takes uint128 values
  const minAmount = BigInt(config.minBridgeAmount.toString());
  const maxAmount = BigInt(config.maxBridgeAmount.toString());
  await waitForTx(await okuBridge.updateLimits(minAmount, maxAmount), "Set bridge limits");
  
  await waitForTx(await okuBridge.updateDeadline(config.bridgeDeadline), `Set bridge deadline to ${config.bridgeDeadline}s`);

  // Verify Solana Devnet is supported
  const isSolanaSupported = await okuBridge.supportedChains(SOLANA_DEVNET_CHAIN_ID);
  if (!isSolanaSupported) {
    await waitForTx(await okuBridge.addSupportedChain(SOLANA_DEVNET_CHAIN_ID), "Add Solana Devnet as supported chain");
  } else {
    logger.success(`  Solana Devnet (${SOLANA_DEVNET_CHAIN_ID}) already supported`);
  }
}

async function verifyDeployment(
  networkName: string,
  deployer: any,
  okuMoney: Contract,
  okuDollar: Contract,
  litePSM: Contract,
  okuBridge: Contract,
  bridgeRouter: Contract
): Promise<void> {
  logger.step(7, "Verifying Deployment");

  // Check roles
  const hasLitePSMMinter = await okuMoney.hasRole(ROLES.OKUM_MINTER, await litePSM.getAddress());
  const hasBridgeMinter = await okuMoney.hasRole(ROLES.OKUM_MINTER, await okuBridge.getAddress());

  logger.info(`  LitePSM has OKUM_MINTER: ${hasLitePSMMinter}`);
  logger.info(`  OkuBridge has OKUM_MINTER: ${hasBridgeMinter}`);

  // Check bridge config
  const bridgeFee = await okuBridge.bridgeFee();
  const authorizedSigner = await okuBridge.authorizedSigner();
  const isPaused = await okuBridge.paused();
  const isSolanaSupported = await okuBridge.supportedChains(SOLANA_DEVNET_CHAIN_ID);
  const bridgeLimits = await okuBridge.limits();

  logger.info(`  Bridge fee: ${bridgeFee} bps`);
  logger.info(`  Authorized signer: ${authorizedSigner}`);
  logger.info(`  Bridge paused: ${isPaused}`);
  logger.info(`  Solana Devnet supported: ${isSolanaSupported}`);
  logger.info(`  Min bridge: ${ethers.formatUnits(bridgeLimits.min, 18)} OkuM`);
  logger.info(`  Max bridge: ${ethers.formatUnits(bridgeLimits.max, 18)} OkuM`);

  // Verify all addresses saved
  const book = loadAddressBook();
  const contracts = book[networkName] || {};
  const expectedContracts = ["MockUSDC", "OkuMoney", "OkuDollar", "RedemptionQueue", "LitePSM", "OkuBridge", "OkuBridgeRouter"];

  const missing = expectedContracts.filter(c => !contracts[c]);
  if (missing.length > 0) {
    logger.warning(`  Missing contracts in address book: ${missing.join(", ")}`);
  } else {
    logger.success("  All contracts saved to address book");
  }
}

// ============================================================================
// Main Deployment Function
// ============================================================================

async function main() {
  const networkName = getNetworkName();
  const chainConfig = getChainConfig(networkName);
  const config = getDeploymentConfig();

  logger.header(`OkuMoney Deployment to ${chainConfig.name}`);
  logger.info(`Network: ${networkName} (chainId: ${chainConfig.chainId})`);

  const [deployer] = await ethers.getSigners();
  logger.info(`Deployer: ${deployer.address}`);
  logger.info(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH`);

  // Check if we should reset fork (hardhat network only)
  if (networkName === "hardhat" && process.env.RESET_FORK === "true") {
    logger.info("Resetting hardhat fork...");
    await network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: {
          jsonRpcUrl: process.env.FORK_URL || chainConfig.rpcUrl,
        },
      }],
    });
    logger.success("Fork reset complete");
  }

  // Clear existing addresses for this network (fresh deployment)
  const book = loadAddressBook();
  book[networkName] = {};
  saveAddressBook(book);
  logger.info("Cleared existing address book entries");

  console.log(); // spacing

  // Step 1: Deploy MockUSDC (skip if SKIP_MOCK_USDC=true)
  let usdcAddress: string;
  if (process.env.SKIP_MOCK_USDC === "true") {
    logger.step(1, "Using existing USDC");
    usdcAddress = chainConfig.usdc;
    logger.info(`  USDC: ${usdcAddress}`);
  } else {
    usdcAddress = await deployMockUSDC(deployer, networkName);
  }

  // Step 2: Deploy core contracts
  const { okuMoney, okuDollar, redemptionQueue } = await deployCoreContracts(deployer, networkName, config);

  // Step 3: Deploy PSM
  const litePSM = await deployPSM(
    deployer,
    networkName,
    await okuMoney.getAddress(),
    await okuDollar.getAddress(),
    await redemptionQueue.getAddress(),
    usdcAddress
  );

  // Step 4: Deploy bridge contracts
  const { okuBridge, bridgeRouter } = await deployBridge(
    deployer,
    networkName,
    await okuMoney.getAddress(),
    await okuDollar.getAddress()
  );

  // Step 5: Configure roles
  await configureRoles(
    deployer,
    okuMoney,
    okuDollar,
    redemptionQueue,
    litePSM,
    okuBridge,
    bridgeRouter,
    config
  );

  // Step 6: Configure bridge
  await configureBridge(okuBridge, config);

  // Step 7: Verify deployment
  await verifyDeployment(
    networkName,
    deployer,
    okuMoney,
    okuDollar,
    litePSM,
    okuBridge,
    bridgeRouter
  );

  // Summary
  logger.header("Deployment Complete");

  const addresses = loadAddressBook()[networkName];
  console.log();
  console.log("Deployed Contracts:");
  console.log("-------------------");
  for (const [name, address] of Object.entries(addresses)) {
    console.log(`  ${name}: ${address}`);
  }
  console.log();

  logger.info("Next steps:");
  logger.info("1. Update testnet-addresses.json with deployed addresses");
  logger.info("2. Deploy SVM contracts: cd SVM/oku-programs && NETWORK=devnet npm run deploy");
  logger.info("3. Test bridge: npx hardhat run scripts/bridge/bridge-burn-to-solana.ts --network " + networkName);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
