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
import { saveAddress, loadAddressBook, saveAddressBook, hasAddress, loadAddress } from "../utils/addressBook";
import { syncEvmRegistry } from "../utils/testnetRegistry";
import {
  getChainMetadata,
  DEV_WALLET_ADDRESS,
} from "../config/chains";
import { resolveNetworkContext } from "../utils/networkContext";
import { ROLES } from "../config/roles";
import { logger } from "../utils/logger";

// Networks that support Etherscan-family verification.
// Etherscan V2 (single ETHERSCAN_API_KEY) covers Ethereum, Optimism, Arbitrum,
// Base, and BSC. Per-chain explorer keys (BSCSCAN_API_KEY, etc.) still work
// as fallbacks via the per-network `verify.etherscan` blocks in hardhat.config.ts.
const VERIFIABLE_NETWORKS = [
  "sepolia",
  "opSepolia",
  "baseSepolia",
  "bscTestnet",
  "mainnet",
  "optimism",
  "arbitrum",
  "base",
  "bsc",
];

// Dev wallet address for impersonation on local fork (centralized in chains.ts)
const DEV_WALLET = DEV_WALLET_ADDRESS;

// ============================================================================
// Configuration
// ============================================================================

interface DeploymentConfig {
  maxSupply: bigint;
  minterAllowance: bigint;
  // PSM oracle staleness threshold (seconds). Bounded by Constants.ORACLE_MIN/MAX_STALENESS
  // (60 .. 7 days). Operators can re-tune via configureOracle post-deploy.
  psmStalenessThreshold: bigint;
}

function getDeploymentConfig(): DeploymentConfig {
  return {
    maxSupply: ethers.parseUnits("1000000000", 18), // 1 billion
    minterAllowance: ethers.parseUnits("1000000000", 18), // 1 billion
    psmStalenessThreshold: 3600n, // 1 hour
  };
}

// ============================================================================
// Helper Functions
// ============================================================================

// ============================================================================
// Transient-error Retry Helpers
// ============================================================================
//
// Live deploys regularly hit RPC-level races that aren't real failures:
//
//   - "nonce too low" / "nonce too high": ethers' per-tx getTransactionCount
//     returned a stale value (chain advanced between getNonce and sendTx).
//   - "replacement transaction underpriced": OZ/ethers internally retried a
//     tx without bumping fee enough to satisfy the sequencer's 10% rule.
//   - "already known": same tx was submitted twice via different paths.
//   - "could not coalesce error" / network timeouts.
//
// All of these are recoverable by waiting briefly and retrying — re-running
// the operation re-fetches a fresh nonce and re-broadcasts. Without retry,
// any one of ~25 sequential txs in a full deploy can torpedo the whole run.

const TRANSIENT_PATTERNS = [
  /nonce too low/i,
  /nonce too high/i,
  /replacement transaction underpriced/i,
  /already known/i,
  /transaction underpriced/i,
  /could not coalesce error/i,
  /timeout/i,
  /ETIMEDOUT/i,
  /ECONNRESET/i,
  /ENOTFOUND/i,
  // BSC pending-tx response quirk (`to: ""` instead of `to: null`). Our
  // rpcCompat shim should normally prevent this from ever surfacing, but if
  // a path slips through, the same response a few seconds later (after the
  // tx mines) will have `to: null` correctly, so retry resolves it.
  /invalid value for value\.to/i,
  /invalid address.*value=""/i,
  /BAD_DATA/i,
];

function isTransientError(err: any): boolean {
  const msg = (err?.message || String(err)).toString();
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Run an async operation, retrying on transient RPC errors with exponential backoff.
 * Real (non-transient) errors are rethrown immediately.
 */
async function withRetry<T>(
  description: string,
  fn: () => Promise<T>,
  opts: { retries?: number; baseDelayMs?: number } = {}
): Promise<T> {
  const retries = opts.retries ?? 5;
  const baseDelayMs = opts.baseDelayMs ?? 2000;
  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (!isTransientError(err) || attempt === retries) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt); // 2s, 4s, 8s, 16s, 32s
      const snippet = (err.message || String(err)).slice(0, 100);
      logger.warning(
        `  ${description}: transient error "${snippet}..." — retrying in ${delay}ms ` +
        `(attempt ${attempt + 1}/${retries})`
      );
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Send a state-changing tx and wait for confirmation, with transient-error retry.
 * Use this in place of the `await waitForTx(await c.method(args), "desc")` pattern.
 */
async function sendAndWait(
  description: string,
  sendFn: () => Promise<any>
): Promise<void> {
  await withRetry(description, async () => {
    const tx = await sendFn();
    logger.info(`  ${description}...`);
    const receipt = await tx.wait();
    logger.success(`  ${description} - block ${receipt.blockNumber}`);
  });
}

/**
 * Reuse an existing deployment if the address book has the contract AND there's
 * bytecode at that address on the current chain. Otherwise return null and let
 * the caller deploy fresh.
 *
 * Critical for live-network resumability: a partial-deploy failure (e.g. flaky
 * RPC mid-run) shouldn't force redeploying — and orphaning — every contract
 * that already made it on-chain in the failed run.
 */
async function tryAttach(
  contractName: string,
  bookKey: string,
  deployer: Signer
): Promise<Contract | null> {
  if (!hasAddress(bookKey, contractName)) return null;
  const addr = loadAddress(bookKey, contractName);
  const code = await ethers.provider.getCode(addr);
  if (!code || code === "0x") {
    logger.warning(`  ${contractName}: address book has ${addr} but no bytecode on-chain; will redeploy`);
    return null;
  }
  logger.success(`  ${contractName}: reusing existing deployment at ${addr}`);
  const Factory = await ethers.getContractFactory(contractName, deployer);
  return Factory.attach(addr) as unknown as Contract;
}

async function deployUUPSProxy(
  contractName: string,
  initArgs: any[],
  bookKey: string,
  deployer: Signer
): Promise<Contract> {
  const existing = await tryAttach(contractName, bookKey, deployer);
  if (existing) return existing;

  return await withRetry(`deploy ${contractName} (UUPS)`, async () => {
    const Factory = await ethers.getContractFactory(contractName, deployer);
    const proxy = await upgrades.deployProxy(Factory, initArgs, { kind: "uups" });
    await proxy.waitForDeployment();
    const address = await proxy.getAddress();
    saveAddress(bookKey, contractName, address);
    return proxy;
  });
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

  logger.step(7, "Verifying Contracts on Etherscan");
  logger.info("  Waiting 30s for Etherscan to index contracts...");
  await new Promise(resolve => setTimeout(resolve, 30000));

  const addresses = loadAddressBook()[networkName] || {};

  // Proxy contracts need special handling. OkuBridge/OkuBridgeRouter were removed
  // in the noBridge refactor; v1 cross-chain transfers are PSM-mediated mint/burn
  // orchestrated off-chain.
  const proxyContracts = ["OkuMoney", "OkuDollar", "RedemptionQueue", "LitePSM"];
  
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

async function deployMockUSDC(bookKey: string, deployer: Signer): Promise<string> {
  logger.step(1, "Deploying MockUSDC");

  const existing = await tryAttach("MockUSDC", bookKey, deployer);
  if (existing) {
    return await existing.getAddress();
  }

  return await withRetry("deploy MockUSDC", async () => {
    const MockUSDC = await ethers.getContractFactory("MockUSDC", deployer);
    const mockUsdc = await MockUSDC.deploy();
    await mockUsdc.waitForDeployment();

    const address = await mockUsdc.getAddress();
    saveAddress(bookKey, "MockUSDC", address);
    logger.success(`  MockUSDC: ${address}`);
    return address;
  });
}

async function deployCoreContracts(
  deployer: Signer,
  deployerAddress: string,
  bookKey: string,
  config: DeploymentConfig
): Promise<{ okuMoney: Contract; okuDollar: Contract }> {
  logger.step(2, "Deploying Core Contracts");

  // OkuMoney
  logger.info("  Deploying OkuMoney...");
  const okuMoney = await deployUUPSProxy(
    "OkuMoney",
    ["Oku Money", "OkuM", deployerAddress, config.maxSupply],
    bookKey,
    deployer
  );
  logger.success(`  OkuMoney: ${await okuMoney.getAddress()}`);

  // OkuDollar
  logger.info("  Deploying OkuDollar...");
  const minCollateralRatio = ethers.parseUnits("1", 18); // 100% (1e18 = 100%)
  const okuDollar = await deployUUPSProxy(
    "OkuDollar",
    [await okuMoney.getAddress(), "Oku Dollar", "usdOku", deployerAddress, minCollateralRatio],
    bookKey,
    deployer
  );
  logger.success(`  OkuDollar: ${await okuDollar.getAddress()}`);

  return { okuMoney, okuDollar };
}

async function deployRedemptionQueue(
  deployer: Signer,
  deployerAddress: string,
  bookKey: string,
  okuMoneyAddress: string,
  usdcAddress: string
): Promise<Contract> {
  logger.info("  Deploying RedemptionQueue...");
  // RedemptionQueue.initialize now takes (_okuMoney, _usdc, admin) so the queue can
  // resolve the USDC decimal multiplier from IERC20Metadata at init time.
  const redemptionQueue = await deployUUPSProxy(
    "RedemptionQueue",
    [okuMoneyAddress, usdcAddress, deployerAddress],
    bookKey,
    deployer
  );
  logger.success(`  RedemptionQueue: ${await redemptionQueue.getAddress()}`);
  return redemptionQueue;
}

async function deployPSM(
  deployer: Signer,
  deployerAddress: string,
  bookKey: string,
  okuMoneyAddress: string,
  okuDollarAddress: string,
  redemptionQueueAddress: string,
  usdcAddress: string,
  config: DeploymentConfig
): Promise<Contract> {
  logger.step(3, "Deploying LitePSM");

  // LitePSM.initialize(okuMoney, okuDollar, usdc, redemptionQueue, admin, stalenessThreshold)
  const litePSM = await deployUUPSProxy(
    "LitePSM",
    [
      okuMoneyAddress,                  // _okuMoney
      okuDollarAddress,                 // _okuDollar
      usdcAddress,                      // _usdc
      redemptionQueueAddress,           // _redemptionQueue
      deployerAddress,                  // admin
      config.psmStalenessThreshold,     // _stalenessThreshold (PoR oracle bound)
    ],
    bookKey,
    deployer
  );
  logger.success(`  LitePSM: ${await litePSM.getAddress()}`);

  return litePSM;
}

// NOTE: OkuBridge / OkuBridgeRouter / NTT adapter deployment was removed in the
// noBridge refactor. v1 cross-chain transfers are PSM-mediated mint/burn driven
// by the off-chain orchestrator (LitePSM holds OKUM_MINTER on every chain).
// When OkuBridge / NTT / CCIP are re-introduced, deployments are additive: deploy
// the new proxy, grant OKUM_MINTER, set minter allowance. No changes to existing
// contracts required. The BRIDGE_* / ROUTER_* / NTT_* role constants remain
// reserved in lib/Roles.sol for that future work.

async function configureRoles(
  deployerAddress: string,
  okuMoney: Contract,
  okuDollar: Contract,
  redemptionQueue: Contract,
  litePSM: Contract,
  config: DeploymentConfig
): Promise<void> {
  logger.step(4, "Configuring Roles");

  const litePSMAddress = await litePSM.getAddress();
  const redemptionQueueAddress = await redemptionQueue.getAddress();

  // OkuMoney minter roles. LitePSM is the sole user-facing OKUM_MINTER in the
  // noBridge model; RedemptionQueue mints rebase deltas; off-chain cross-chain
  // mint/burn flows route through LitePSM via the orchestrator's USDC custody.
  await sendAndWait("Grant OKUM_MINTER to LitePSM", () => okuMoney.grantRole(ROLES.OKUM_MINTER, litePSMAddress));
  await sendAndWait("Grant OKUM_MINTER to RedemptionQueue", () => okuMoney.grantRole(ROLES.OKUM_MINTER, redemptionQueueAddress));

  // OkuMoney admin roles (testnet only)
  await sendAndWait("Grant OKUM_REBASER to Admin", () => okuMoney.grantRole(ROLES.OKUM_REBASER, deployerAddress));
  await sendAndWait("Grant OKUM_ALLOWANCE_MANAGER to Admin", () => okuMoney.grantRole(ROLES.OKUM_ALLOWANCE_MANAGER, deployerAddress));

  // Minter allowances
  await sendAndWait("Set LitePSM minter allowance", () => okuMoney.configureMinterAllowance(litePSMAddress, config.minterAllowance));
  await sendAndWait("Set RedemptionQueue minter allowance", () => okuMoney.configureMinterAllowance(redemptionQueueAddress, config.minterAllowance));

  // OkuDollar roles
  await sendAndWait("Grant VAULT_REBASER to Admin", () => okuDollar.grantRole(ROLES.VAULT_REBASER, deployerAddress));

  // RedemptionQueue roles
  await sendAndWait("Grant QUEUE_PSM to LitePSM", () => redemptionQueue.grantRole(ROLES.QUEUE_PSM, litePSMAddress));

  // LitePSM roles — full operational set for testnet (all to deployer per TESTNET_DEPLOYMENT.md).
  // Production: run grantRolesMainnet.ts to distribute roles to cold/warm multisig + orchestrator.
  await sendAndWait("Grant PSM_BUFFER_DEPOSITOR to Admin", () => litePSM.grantRole(ROLES.PSM_BUFFER_DEPOSITOR, deployerAddress));
  await sendAndWait("Grant PSM_QUEUE_PROCESSOR to Admin", () => litePSM.grantRole(ROLES.PSM_QUEUE_PROCESSOR, deployerAddress));
  await sendAndWait("Grant PSM_BUFFER_WITHDRAWER to Admin", () => litePSM.grantRole(ROLES.PSM_BUFFER_WITHDRAWER, deployerAddress));
  await sendAndWait("Grant PSM_ORACLE_MANAGER to Admin", () => litePSM.grantRole(ROLES.PSM_ORACLE_MANAGER, deployerAddress));

  // OkuMoney additional admin roles
  await sendAndWait("Grant OKUM_PAUSER to Admin", () => okuMoney.grantRole(ROLES.OKUM_PAUSER, deployerAddress));
  await sendAndWait("Grant OKUM_UNPAUSER to Admin", () => okuMoney.grantRole(ROLES.OKUM_UNPAUSER, deployerAddress));
  await sendAndWait("Grant OKUM_BLACKLISTER to Admin", () => okuMoney.grantRole(ROLES.OKUM_BLACKLISTER, deployerAddress));
  await sendAndWait("Grant OKUM_UNBLACKLISTER to Admin", () => okuMoney.grantRole(ROLES.OKUM_UNBLACKLISTER, deployerAddress));
  await sendAndWait("Grant OKUM_CAP_MANAGER to Admin", () => okuMoney.grantRole(ROLES.OKUM_CAP_MANAGER, deployerAddress));

  // OkuDollar additional admin roles
  await sendAndWait("Grant VAULT_PAUSER to Admin", () => okuDollar.grantRole(ROLES.VAULT_PAUSER, deployerAddress));
  await sendAndWait("Grant VAULT_UNPAUSER to Admin", () => okuDollar.grantRole(ROLES.VAULT_UNPAUSER, deployerAddress));
  await sendAndWait("Grant VAULT_RESERVE_MANAGER to Admin", () => okuDollar.grantRole(ROLES.VAULT_RESERVE_MANAGER, deployerAddress));

  // OkuDollar blacklist roles (shared OKUM_ prefix — one grant covers both tokens)
  await sendAndWait("Grant OKUM_BLACKLISTER on OkuDollar to Admin", () => okuDollar.grantRole(ROLES.OKUM_BLACKLISTER, deployerAddress));
  await sendAndWait("Grant OKUM_UNBLACKLISTER on OkuDollar to Admin", () => okuDollar.grantRole(ROLES.OKUM_UNBLACKLISTER, deployerAddress));

  // RedemptionQueue additional role
  await sendAndWait("Grant QUEUE_RESCUER to Admin", () => redemptionQueue.grantRole(ROLES.QUEUE_RESCUER, deployerAddress));

  // Wire USDC consistency assertion (post-init verification that queue and PSM share the same USDC)
  await sendAndWait("Assert queue.usdc == psm.usdc", async () => {
    const psmUsdc = await litePSM.usdc();
    return redemptionQueue.assertUsdcMatch(psmUsdc);
  });
}

async function verifyDeployment(
  bookKey: string,
  okuMoney: Contract,
  litePSM: Contract,
  redemptionQueue: Contract
): Promise<void> {
  logger.step(6, "Verifying Deployment");

  // Check roles
  const hasLitePSMMinter = await okuMoney.hasRole(ROLES.OKUM_MINTER, await litePSM.getAddress());
  const hasQueueMinter = await okuMoney.hasRole(ROLES.OKUM_MINTER, await redemptionQueue.getAddress());

  logger.info(`  LitePSM has OKUM_MINTER: ${hasLitePSMMinter}`);
  logger.info(`  RedemptionQueue has OKUM_MINTER: ${hasQueueMinter}`);

  // Verify all addresses saved
  const book = loadAddressBook();
  const contracts = book[bookKey] || {};
  const expectedContracts = ["MockUSDC", "OkuMoney", "OkuDollar", "RedemptionQueue", "LitePSM"];

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
  // Single source of truth for "what chain are we on / where do we read+write addresses".
  // Returns: { networkName, bookKey, isFork, chainConfig }.
  const ctx = await resolveNetworkContext();
  const { networkName, bookKey, isFork, chainConfig } = ctx;
  const config = getDeploymentConfig();

  logger.header(`OkuMoney Deployment to ${chainConfig.name}${isFork ? " (LOCAL FORK)" : ""}`);
  logger.info(`Network: ${networkName} (chainId: ${chainConfig.chainId})`);
  logger.info(`Address book key: ${bookKey}`);

  // Get deployer - use impersonation for localhost (fork), real signer for live networks.
  let deployer: Signer;

  if (isFork) {
    // Impersonate dev wallet for local fork testing.
    // Uses actual on-chain balance from forked network (no artificial funding).
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

  // Check if we should reset fork (hardhat in-process network only)
  if (network.name === "hardhat" && process.env.RESET_FORK === "true") {
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

  // Address-book write strategy:
  //
  //   - Fork runs (bookKey = "fork:<chain>"): we DO clear book[bookKey] so each
  //     fork run starts fresh. The live "<chain>" key is untouched, so a flaky
  //     fork test never destroys real-deployment state.
  //
  //   - Live runs (bookKey = "<chain>"): we DO NOT clear. tryAttach() handles
  //     resumption — if a previous live run partially succeeded, we reuse
  //     anything that's still on-chain and only redeploy what's missing.
  if (isFork) {
    const book = loadAddressBook();
    book[bookKey] = {};
    saveAddressBook(book);
    logger.info(`Cleared address book entries for "${bookKey}" (local fork run)`);
  } else {
    logger.info(`Live network: addresses will be merged into address book under "${bookKey}" (existing entries reused if still on-chain)`);
  }

  console.log(); // spacing

  // Step 1: Deploy MockUSDC (skip if SKIP_MOCK_USDC=true)
  let usdcAddress: string;
  if (process.env.SKIP_MOCK_USDC === "true") {
    logger.step(1, "Using existing USDC");
    usdcAddress = chainConfig.usdc;
    logger.info(`  USDC: ${usdcAddress}`);
  } else {
    usdcAddress = await deployMockUSDC(bookKey, deployer);
  }

  // Step 2: Deploy core contracts (RedemptionQueue is deployed separately because it now
  // requires the USDC address for decimal-multiplier resolution at init time).
  const { okuMoney, okuDollar } = await deployCoreContracts(deployer, deployerAddress, bookKey, config);
  const redemptionQueue = await deployRedemptionQueue(
    deployer,
    deployerAddress,
    bookKey,
    await okuMoney.getAddress(),
    usdcAddress
  );

  // Step 3: Deploy PSM
  const litePSM = await deployPSM(
    deployer,
    deployerAddress,
    bookKey,
    await okuMoney.getAddress(),
    await okuDollar.getAddress(),
    await redemptionQueue.getAddress(),
    usdcAddress,
    config
  );

  // Step 4: Configure roles
  await configureRoles(
    deployerAddress,
    okuMoney,
    okuDollar,
    redemptionQueue,
    litePSM,
    config
  );

  // Step 5: (was bridge configuration — removed in noBridge refactor)

  // Step 6: Verify deployment state
  await verifyDeployment(
    bookKey,
    okuMoney,
    litePSM,
    redemptionQueue
  );

  // Step 7: Etherscan verification (live networks only — never on a fork)
  if (!isFork) {
    await verifyAllContracts(networkName);
  }

  // Summary
  logger.header("Deployment Complete");

  const addresses = loadAddressBook()[bookKey];
  console.log();
  console.log(`Deployed Contracts (book key: ${bookKey}):`);
  console.log("-------------------");
  for (const [name, address] of Object.entries(addresses)) {
    console.log(`  ${name}: ${address}`);
  }
  console.log();

  // Mirror into the repo-root testnet-addresses.json registry (live networks only)
  if (!isFork) {
    try {
      const metadata = getChainMetadata(networkName);
      syncEvmRegistry(networkName, {
        chainId: metadata.chainId,
        rpcUrl: metadata.rpcUrl,
        explorer: metadata.explorer,
        contracts: {
          okuMoney: addresses.OkuMoney,
          okuDollar: addresses.OkuDollar,
          litePSM: addresses.LitePSM,
          redemptionQueue: addresses.RedemptionQueue,
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
  logger.info("3. Test PSM flow: npx hardhat run scripts/interactions/test-flow.ts --network " + networkName);
}

main()
  .then(() => {
    // Diagnostic: confirm RPC compat shim engaged (helpful when debugging
    // BSC pending-tx issues — set DEBUG_RPC_PATCH=1 for per-call logs).
    try {
      const { rpcCompatStats } = require("../utils/rpcCompat");
      logger.info(`RPC compat: ${rpcCompatStats.sendCalls} send / ${rpcCompatStats.requestCalls} request calls intercepted; ${rpcCompatStats.fixedCount} responses fixed`);
    } catch {}
    process.exit(0);
  })
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    try {
      const { rpcCompatStats } = require("../utils/rpcCompat");
      logger.error(`RPC compat at failure: ${rpcCompatStats.sendCalls} send / ${rpcCompatStats.requestCalls} request calls intercepted; ${rpcCompatStats.fixedCount} responses fixed (zero send calls = patch was bypassed; non-zero with no fixes = no BSC bug responses came through this path)`);
    } catch {}
    console.error(error);
    process.exit(1);
  });
