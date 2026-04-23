/**
 * Unified Deployment Script for OkuMoney EVM Contracts
 *
 * Deploys all contracts and configures roles in a single execution.
 * Works for both local fork testing (via hardhat network) and live testnet.
 *
 * Usage:
 *   # Local fork (auto-forks Eth Sepolia via hardhat.config.ts)
 *   npx hardhat run scripts/deploy/index.ts --network localhost
 *
 *   # Live testnet
 *   npx hardhat run scripts/deploy/index.ts --network sepolia
 *
 * Options (via env vars):
 *   SKIP_MOCK_USDC=true   - Skip MockUSDC deployment (use existing USDC)
 *   RESET_FORK=true       - Reset hardhat fork to clean state before deploying
 *   VERIFY=true           - Verify contracts on Etherscan after deployment
 */

import { ethers, network, upgrades, run } from "hardhat";
import { Contract, Signer } from "ethers";
import { saveAddress, loadAddressBook, saveAddressBook } from "../utils/addressBook";
import { syncEvmRegistry } from "../utils/testnetRegistry";
import {
  getNetworkName,
  getChainConfig,
  getChainMetadata,
  getBridgeChainId,
  SOLANA_DEVNET_CHAIN_ID,
  DEV_WALLET_ADDRESS,
} from "../config/chains";
import { ROLES } from "../config/roles";
import { logger } from "../utils/logger";

// Networks that support Etherscan verification
const VERIFIABLE_NETWORKS = ["sepolia", "opSepolia", "mainnet", "optimism", "arbitrum", "base"];

// Check if current network is a live network (not local fork)
function isLiveNetwork(networkName: string): boolean {
  return !["localhost", "hardhat"].includes(networkName);
}

// Dev wallet address for impersonation on local fork (centralized in chains.ts)
const DEV_WALLET = DEV_WALLET_ADDRESS;

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
  networkName: string,
  deployer: Signer
): Promise<Contract> {
  const Factory = await ethers.getContractFactory(contractName, deployer);
  const proxy = await upgrades.deployProxy(Factory, initArgs, { kind: "uups" });
  await proxy.waitForDeployment();
  const address = await proxy.getAddress();
  saveAddress(networkName, contractName, address);
  return proxy;
}

async function deployTransparentProxy(
  contractName: string,
  initArgs: any[],
  networkName: string,
  deployer: Signer
): Promise<Contract> {
  const Factory = await ethers.getContractFactory(contractName, deployer);
  const proxy = await upgrades.deployProxy(Factory, initArgs, { kind: "transparent" });
  await proxy.waitForDeployment();
  const address = await proxy.getAddress();
  saveAddress(networkName, contractName, address);
  return proxy;
}

// ============================================================================
// Etherscan Verification
// ============================================================================

async function verifyContract(address: string, constructorArgs: any[] = []): Promise<boolean> {
  try {
    await run("verify:verify", {
      address,
      constructorArguments: constructorArgs,
    });
    logger.success(`    Verified: ${address}`);
    return true;
  } catch (error: any) {
    if (error.message.includes("Already Verified") || error.message.includes("already verified")) {
      logger.info(`    Already verified: ${address}`);
      return true;
    }
    logger.warning(`    Verification failed: ${error.message}`);
    return false;
  }
}

async function verifyProxy(proxyAddress: string, contractName: string): Promise<void> {
  try {
    // Get implementation address
    const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    logger.info(`    Implementation: ${implAddress}`);
    
    // Verify implementation contract
    await verifyContract(implAddress);
    
    // Also try to verify the proxy itself (links proxy to implementation on Etherscan)
    // This uses hardhat-upgrades' built-in proxy verification
    try {
      await run("verify:verify", {
        address: proxyAddress,
      });
    } catch (proxyError: any) {
      // Proxy verification often fails with "already verified" which is fine
      if (!proxyError.message.includes("Already Verified") && !proxyError.message.includes("already verified")) {
        logger.info(`    Proxy verification note: ${proxyError.message}`);
      }
    }
  } catch (error: any) {
    logger.warning(`    Could not verify ${contractName}: ${error.message}`);
  }
}

async function verifyAllContracts(networkName: string): Promise<void> {
  if (!VERIFIABLE_NETWORKS.includes(networkName)) {
    logger.info("Skipping verification (not a verifiable network)");
    return;
  }

  if (!process.env.ETHERSCAN_API_KEY) {
    logger.warning("Skipping verification (ETHERSCAN_API_KEY not set)");
    return;
  }

  logger.step(8, "Verifying Contracts on Etherscan");
  logger.info("  Waiting 30s for Etherscan to index contracts...");
  await new Promise(resolve => setTimeout(resolve, 30000));

  const addresses = loadAddressBook()[networkName] || {};
  
  // Proxy contracts need special handling
  const proxyContracts = ["OkuMoney", "OkuDollar", "RedemptionQueue", "LitePSM", "OkuBridge", "OkuBridgeRouter"];
  
  for (const contractName of Object.keys(addresses)) {
    const address = addresses[contractName];
    logger.info(`  Verifying ${contractName} at ${address}...`);

    if (proxyContracts.includes(contractName)) {
      await verifyProxy(address, contractName);
    } else {
      // Non-proxy contracts (like MockUSDC)
      await verifyContract(address);
    }
  }

  logger.success("Verification complete");
}

// ============================================================================
// Deployment Steps
// ============================================================================

async function deployMockUSDC(networkName: string, deployer: Signer): Promise<string> {
  logger.step(1, "Deploying MockUSDC");

  const MockUSDC = await ethers.getContractFactory("MockUSDC", deployer);
  const mockUsdc = await MockUSDC.deploy();
  await mockUsdc.waitForDeployment();

  const address = await mockUsdc.getAddress();
  saveAddress(networkName, "MockUSDC", address);
  logger.success(`  MockUSDC: ${address}`);

  return address;
}

async function deployCoreContracts(
  deployer: Signer,
  deployerAddress: string,
  networkName: string,
  config: DeploymentConfig
): Promise<{ okuMoney: Contract; okuDollar: Contract; redemptionQueue: Contract }> {
  logger.step(2, "Deploying Core Contracts");

  // OkuMoney
  logger.info("  Deploying OkuMoney...");
  const okuMoney = await deployUUPSProxy(
    "OkuMoney",
    ["Oku Money", "OkuM", deployerAddress, config.maxSupply],
    networkName,
    deployer
  );
  logger.success(`  OkuMoney: ${await okuMoney.getAddress()}`);

  // OkuDollar
  logger.info("  Deploying OkuDollar...");
  const minCollateralRatio = ethers.parseUnits("1", 18); // 100% (1e18 = 100%)
  const okuDollar = await deployUUPSProxy(
    "OkuDollar",
    [await okuMoney.getAddress(), "Oku Dollar", "usdOku", deployerAddress, minCollateralRatio],
    networkName,
    deployer
  );
  logger.success(`  OkuDollar: ${await okuDollar.getAddress()}`);

  // RedemptionQueue
  logger.info("  Deploying RedemptionQueue...");
  const redemptionQueue = await deployUUPSProxy(
    "RedemptionQueue",
    [await okuMoney.getAddress(), deployerAddress],
    networkName,
    deployer
  );
  logger.success(`  RedemptionQueue: ${await redemptionQueue.getAddress()}`);

  return { okuMoney, okuDollar, redemptionQueue };
}

async function deployPSM(
  deployer: Signer,
  deployerAddress: string,
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
      deployerAddress,          // admin
    ],
    networkName,
    deployer
  );
  logger.success(`  LitePSM: ${await litePSM.getAddress()}`);

  return litePSM;
}

async function deployBridge(
  deployer: Signer,
  deployerAddress: string,
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
      deployerAddress, // orchestrator signer (deployer for testnet)
      deployerAddress, // fee recipient
      deployerAddress, // admin
      [BigInt(SOLANA_DEVNET_CHAIN_ID)], // supported chains
    ],
    networkName,
    deployer
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
      deployerAddress,
    ],
    networkName,
    deployer
  );
  logger.success(`  OkuBridgeRouter: ${await bridgeRouter.getAddress()}`);

  return { okuBridge, bridgeRouter };
}

async function configureRoles(
  deployerAddress: string,
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
  await waitForTx(await okuMoney.grantRole(ROLES.OKUM_REBASER, deployerAddress), "Grant OKUM_REBASER to Admin");
  await waitForTx(await okuMoney.grantRole(ROLES.OKUM_ALLOWANCE_MANAGER, deployerAddress), "Grant OKUM_ALLOWANCE_MANAGER to Admin");

  // Minter allowances
  await waitForTx(await okuMoney.configureMinterAllowance(litePSMAddress, config.minterAllowance), "Set LitePSM minter allowance");
  await waitForTx(await okuMoney.configureMinterAllowance(redemptionQueueAddress, config.minterAllowance), "Set RedemptionQueue minter allowance");
  await waitForTx(await okuMoney.configureMinterAllowance(okuBridgeAddress, config.minterAllowance), "Set OkuBridge minter allowance");
  await waitForTx(await okuMoney.configureMinterAllowance(bridgeRouterAddress, config.minterAllowance), "Set OkuBridgeRouter minter allowance");

  // OkuDollar roles
  await waitForTx(await okuDollar.grantRole(ROLES.VAULT_REBASER, deployerAddress), "Grant VAULT_REBASER to Admin");

  // RedemptionQueue roles
  await waitForTx(await redemptionQueue.grantRole(ROLES.QUEUE_PSM, litePSMAddress), "Grant QUEUE_PSM to LitePSM");

  // LitePSM roles
  await waitForTx(await litePSM.grantRole(ROLES.PSM_BUFFER_DEPOSITOR, deployerAddress), "Grant PSM_BUFFER_DEPOSITOR to Admin");
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

  // Get deployer - use impersonation for localhost (fork), real signer for live networks
  let deployer: Signer;
  const isLocalNetwork = networkName === "localhost" || networkName === "hardhat";
  
  if (isLocalNetwork) {
    // Impersonate dev wallet for local fork testing
    // Uses actual on-chain balance from forked network (no artificial funding)
    logger.info(`Impersonating dev wallet: ${DEV_WALLET}`);
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [DEV_WALLET],
    });
    deployer = await ethers.getSigner(DEV_WALLET);
  } else {
    // Use real signer from private key for live networks
    const signers = await ethers.getSigners();
    deployer = signers[0];
  }

  const deployerAddress = await deployer.getAddress();
  logger.info(`Deployer: ${deployerAddress}`);
  logger.info(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployerAddress))} ETH`);

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

  // Clear existing addresses for local networks only
  // Live network deployments are preserved for reference
  if (!isLiveNetwork(networkName)) {
    const book = loadAddressBook();
    book[networkName] = {};
    saveAddressBook(book);
    logger.info("Cleared existing address book entries (local network)");
  } else {
    logger.info("Live network: addresses will be appended to address book");
  }

  console.log(); // spacing

  // Step 1: Deploy MockUSDC (skip if SKIP_MOCK_USDC=true)
  let usdcAddress: string;
  if (process.env.SKIP_MOCK_USDC === "true") {
    logger.step(1, "Using existing USDC");
    usdcAddress = chainConfig.usdc;
    logger.info(`  USDC: ${usdcAddress}`);
  } else {
    usdcAddress = await deployMockUSDC(networkName, deployer);
  }

  // Step 2: Deploy core contracts
  const { okuMoney, okuDollar, redemptionQueue } = await deployCoreContracts(deployer, deployerAddress, networkName, config);

  // Step 3: Deploy PSM
  const litePSM = await deployPSM(
    deployer,
    deployerAddress,
    networkName,
    await okuMoney.getAddress(),
    await okuDollar.getAddress(),
    await redemptionQueue.getAddress(),
    usdcAddress
  );

  // Step 4: Deploy bridge contracts
  const { okuBridge, bridgeRouter } = await deployBridge(
    deployer,
    deployerAddress,
    networkName,
    await okuMoney.getAddress(),
    await okuDollar.getAddress()
  );

  // Step 5: Configure roles
  await configureRoles(
    deployerAddress,
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

  // Step 7: Verify deployment state
  await verifyDeployment(
    networkName,
    okuMoney,
    okuDollar,
    litePSM,
    okuBridge,
    bridgeRouter
  );

  // Step 8: Etherscan verification (live networks only)
  if (isLiveNetwork(networkName)) {
    await verifyAllContracts(networkName);
  }

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

  // Mirror into the repo-root testnet-addresses.json registry (live networks only)
  if (isLiveNetwork(networkName)) {
    try {
      const metadata = getChainMetadata(networkName);
      let bridgeChainId: number | undefined;
      try {
        bridgeChainId = getBridgeChainId(metadata.chainId);
      } catch {
        // Not all chains have a bridge mapping (e.g., certain mainnets pre-support)
      }
      syncEvmRegistry(networkName, {
        chainId: metadata.chainId,
        bridgeChainId,
        rpcUrl: metadata.rpcUrl,
        explorer: metadata.explorer,
        contracts: {
          okuMoney: addresses.OkuMoney,
          okuDollar: addresses.OkuDollar,
          litePSM: addresses.LitePSM,
          redemptionQueue: addresses.RedemptionQueue,
          okuBridge: addresses.OkuBridge,
          okuBridgeRouter: addresses.OkuBridgeRouter,
          mockUSDC: addresses.MockUSDC,
        },
        deployer: deployerAddress,
      });
    } catch (err: any) {
      logger.warning(`Registry sync failed (non-fatal): ${err.message}`);
    }
  }

  logger.info("Next steps:");
  logger.info("1. Check the updated testnet-addresses.json at the repo root");
  logger.info("2. Deploy SVM: cd ../SVM/oku-programs && NETWORK=devnet npm run deploy:programs && npm run deploy:init");
  logger.info("3. Test bridge: npx hardhat run scripts/bridge/bridge-burn-to-solana.ts --network " + networkName);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
