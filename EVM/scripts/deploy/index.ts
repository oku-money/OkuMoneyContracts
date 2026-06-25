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
import {
  CREATE2_FACTORY,
  saltFor,
} from "../config/deploymentVersion";
import {
  create2FactoryAvailable,
  deployContractDeterministic,
  buildERC1967ProxyInitCode,
  computeCreate2Address,
} from "../utils/create2Deploy";

// Networks that support Etherscan-family verification.
// Etherscan V2 (single ETHERSCAN_API_KEY) covers Ethereum, Optimism, Arbitrum,
// Base, and BSC. Per-chain explorer keys (BSCSCAN_API_KEY, etc.) still work
// as fallbacks via the per-network `verify.etherscan` blocks in hardhat.config.ts.
const VERIFIABLE_NETWORKS = [
  "sepolia",
  "opSepolia",
  "baseSepolia",
  "arbSepolia",
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
  // OracleRelay (USDC peg circuit-breaker) defaults — operators can re-tune via the
  // RELAY_FEED_MANAGER / RELAY_CONFIG_MANAGER setters post-deploy.
  oracleRelayStalenessThreshold: bigint;
  oracleRelayMinPriceE18: bigint;
  oracleRelayMaxPriceE18: bigint;
  // Per-chain USDC/USD Chainlink aggregator address. When empty (testnet), the
  // OracleRelay deploy is skipped; LitePSM and RedemptionQueue start with
  // oracleRelay = address(0) (peg check disabled, mirrors old bootstrap behavior).
  oracleRelayPriceFeed: string;
}

function getDeploymentConfig(): DeploymentConfig {
  return {
    maxSupply: ethers.parseUnits("1000000000", 18), // 1 billion
    minterAllowance: ethers.parseUnits("1000000000", 18), // 1 billion
    oracleRelayStalenessThreshold: 3600n, // 1 hour
    oracleRelayMinPriceE18: ethers.parseUnits("0.97", 18), // $0.97
    oracleRelayMaxPriceE18: ethers.parseUnits("1.03", 18), // $1.03
    // Per-chain Chainlink USDC/USD feed: pulled from chainConfig at main() entry.
    // Leave empty here; main() injects the chain-specific value if present.
    oracleRelayPriceFeed: "",
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
 *
 * `FRESH_DEPLOY=true` short-circuits this: skip the attach check entirely and
 * always redeploy. Use when intentionally abandoning a prior deployment
 * (e.g. moving to a new deterministic address scheme or after a storage-
 * incompatible source change). The pre-existing on-chain contracts are
 * orphaned but harmless — their addresses simply stop being referenced.
 */
async function tryAttach(
  contractName: string,
  bookKey: string,
  deployer: Signer
): Promise<Contract | null> {
  if (process.env.FRESH_DEPLOY === "true") {
    logger.info(`  ${contractName}: FRESH_DEPLOY=true — skipping attach check`);
    return null;
  }
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

  const Factory = await ethers.getContractFactory(contractName, deployer);

  // CREATE2 path: when the Arachnid factory exists on this chain, deploy
  // both the impl and the ERC1967 proxy through it so the proxy address is
  // identical across every chain that has the factory + the same source
  // tree. Per-chain constructor variations (USDC address, Chainlink feed)
  // still produce different addresses on chains where those args differ.
  //
  // See scripts/config/deploymentVersion.ts for the salt scheme.
  if (await create2FactoryAvailable(ethers.provider)) {
    return await withRetry(`deploy ${contractName} (UUPS via CREATE2)`, async () => {
      // 1. Impl deploy (no constructor args; OZ initializers handle setup).
      const implSalt = saltFor(`${contractName}.impl`);
      const { address: implAddress, reused: implReused } = await deployContractDeterministic(
        Factory,
        implSalt,
        [],
        deployer,
        `${contractName} impl`
      );
      logger.info(
        `  ${contractName} impl ${implReused ? "reused" : "deployed"} ` +
          `at ${implAddress} (CREATE2)`
      );

      // 2. Proxy deploy: ERC1967Proxy(impl, initCalldata) constructor args.
      const initCalldata = Factory.interface.encodeFunctionData(
        "initialize",
        initArgs
      );
      const proxyInitCode = await buildERC1967ProxyInitCode(
        implAddress,
        initCalldata
      );
      const proxySalt = saltFor(`${contractName}.proxy`);
      const predictedProxy = computeCreate2Address(proxySalt, proxyInitCode);

      // Resumability check: if the proxy is already at the predicted
      // address (prior partial run), skip re-broadcast — we'd revert with
      // "already deployed" anyway.
      const existingCode = await ethers.provider.getCode(predictedProxy);
      let proxyAddress: string;
      let proxyReused: boolean;
      if (existingCode && existingCode !== "0x" && existingCode.length > 2) {
        proxyAddress = predictedProxy;
        proxyReused = true;
      } else {
        // Send the deploy tx directly to the factory: calldata = salt ++ initCode.
        const calldata = proxySalt + proxyInitCode.slice(2);
        const tx = await deployer.sendTransaction({
          to: CREATE2_FACTORY,
          data: calldata,
        });
        const receipt = await tx.wait();
        if (!receipt || receipt.status !== 1) {
          throw new Error(
            `CREATE2 proxy deploy for ${contractName} failed (tx ${tx.hash})`
          );
        }
        // Poll for bytecode at the predicted address. Load-balanced public
        // RPCs can return stale `getCode` results for several seconds after
        // a tx mines; the receipt already confirmed success, we just need
        // to give the RPC network a chance to propagate.
        const pollMaxMs = 30_000;
        const pollIntervalMs = 2_000;
        const pollStart = Date.now();
        let found = false;
        let lastCode = "0x";
        while (Date.now() - pollStart < pollMaxMs) {
          try {
            lastCode = await ethers.provider.getCode(predictedProxy);
            if (lastCode && lastCode !== "0x" && lastCode.length > 2) {
              found = true;
              break;
            }
          } catch {
            // Transient — keep polling within budget.
          }
          await new Promise((r) => setTimeout(r, pollIntervalMs));
        }
        if (!found) {
          throw new Error(
            `CREATE2 proxy deploy for ${contractName} reported success (tx ${tx.hash}) but ` +
              `no bytecode at predicted address ${predictedProxy} after ${pollMaxMs / 1000}s of polling. ` +
              `Last getCode result: ${lastCode.slice(0, 80)}`
          );
        }
        proxyAddress = predictedProxy;
        proxyReused = false;
      }
      logger.info(
        `  ${contractName} proxy ${proxyReused ? "reused" : "deployed"} ` +
          `at ${proxyAddress} (CREATE2)`
      );

      // 3. Register with the OZ manifest so the upgrade script's storage-layout
      //    validation still works. forceImport is metadata-only (no on-chain tx)
      //    and idempotent.
      try {
        await upgrades.forceImport(proxyAddress, Factory, { kind: "uups" });
      } catch (e: any) {
        // Already-imported is fine; anything else is logged but non-fatal
        // (the upgrade script can re-import on demand).
        const msg = (e?.message ?? String(e)).toString();
        if (!/already/i.test(msg)) {
          logger.warning(
            `  forceImport of ${contractName} into OZ manifest failed (non-fatal): ${msg.slice(0, 120)}`
          );
        }
      }

      saveAddress(bookKey, contractName, proxyAddress);
      return Factory.attach(proxyAddress).connect(deployer) as Contract;
    });
  }

  // Fallback: standard OZ-plugin deploy (non-deterministic addresses).
  logger.warning(
    `  CREATE2 factory not available at ${CREATE2_FACTORY} on this chain — ` +
      `falling back to nonce-based CREATE deploy for ${contractName}`
  );
  return await withRetry(`deploy ${contractName} (UUPS, fallback CREATE)`, async () => {
    const proxy = await upgrades.deployProxy(Factory, initArgs, { kind: "uups" });
    await proxy.waitForDeployment();
    const address = await proxy.getAddress();
    saveAddress(bookKey, contractName, address);
    return proxy as unknown as Contract;
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

  const MockUSDC = await ethers.getContractFactory("MockUSDC", deployer);

  // CREATE2 path: MockUSDC must be deterministic across chains so the
  // downstream PSM + queue proxies (whose constructor args include the
  // USDC address) also end up with identical addresses across chains.
  if (await create2FactoryAvailable(ethers.provider)) {
    return await withRetry("deploy MockUSDC (CREATE2)", async () => {
      const salt = saltFor("MockUSDC");
      // MockUSDC has no constructor args (mints to msg.sender via initializer).
      const { address, reused } = await deployContractDeterministic(
        MockUSDC,
        salt,
        [],
        deployer,
        "MockUSDC"
      );
      saveAddress(bookKey, "MockUSDC", address);
      logger.success(`  MockUSDC ${reused ? "reused" : "deployed"} at ${address} (CREATE2)`);
      return address;
    });
  }

  // Fallback: standard CREATE deploy.
  logger.warning(
    `  CREATE2 factory not available at ${CREATE2_FACTORY} — ` +
      `falling back to nonce-based CREATE deploy for MockUSDC`
  );
  return await withRetry("deploy MockUSDC (fallback CREATE)", async () => {
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
  _config: DeploymentConfig
): Promise<Contract> {
  logger.step(3, "Deploying LitePSM");

  // LitePSM.initialize(okuMoney, okuDollar, usdc, redemptionQueue, admin).
  // The OracleRelay address (USDC peg circuit-breaker) is wired post-deploy via
  // litePSM.setOracleRelay(...), so a deploy can complete with the relay disabled
  // (testnet bootstrap path).
  const litePSM = await deployUUPSProxy(
    "LitePSM",
    [
      okuMoneyAddress,                  // _okuMoney
      okuDollarAddress,                 // _okuDollar
      usdcAddress,                      // _usdc
      redemptionQueueAddress,           // _redemptionQueue
      deployerAddress,                  // admin
    ],
    bookKey,
    deployer
  );
  logger.success(`  LitePSM: ${await litePSM.getAddress()}`);

  return litePSM;
}

async function deployOracleRelay(
  deployer: Signer,
  deployerAddress: string,
  bookKey: string,
  priceFeedAddress: string,
  config: DeploymentConfig
): Promise<Contract | null> {
  if (!priceFeedAddress || priceFeedAddress === ethers.ZeroAddress) {
    logger.info("  OracleRelay: skipped (no Chainlink USDC/USD feed configured for this chain)");
    return null;
  }

  logger.step(3, "Deploying OracleRelay");
  // OracleRelay.initialize(priceFeed, staleness, minPriceE18, maxPriceE18, admin)
  const oracleRelay = await deployUUPSProxy(
    "OracleRelay",
    [
      priceFeedAddress,
      config.oracleRelayStalenessThreshold,
      config.oracleRelayMinPriceE18,
      config.oracleRelayMaxPriceE18,
      deployerAddress,
    ],
    bookKey,
    deployer
  );
  logger.success(`  OracleRelay: ${await oracleRelay.getAddress()}`);
  return oracleRelay;
}

async function configureRoles(
  deployerAddress: string,
  okuMoney: Contract,
  okuDollar: Contract,
  redemptionQueue: Contract,
  litePSM: Contract,
  oracleRelay: Contract | null,
  config: DeploymentConfig
): Promise<void> {
  logger.step(4, "Configuring Roles");

  const litePSMAddress = await litePSM.getAddress();
  const redemptionQueueAddress = await redemptionQueue.getAddress();

  // EVM-J3: Fail-fast check that queue and PSM share the same USDC before
  // we start granting roles. A mismatch here would leave the chain with a
  // partially-roled deployment that the operator would have to manually
  // un-grant from. Doing this first means a mismatch reverts with no state
  // change on the proxies.
  const psmUsdc = (await litePSM.usdc()).toString();
  const queueUsdc = (await redemptionQueue.usdc()).toString();
  if (psmUsdc.toLowerCase() !== queueUsdc.toLowerCase()) {
    throw new Error(
      `USDC mismatch: PSM=${psmUsdc} queue=${queueUsdc}. Aborting before role grants.`
    );
  }
  logger.info(`  USDC match verified: ${psmUsdc}`);

  // OkuMoney minter roles. LitePSM is the sole user-facing OKUM_MINTER in the
  // noBridge model; RedemptionQueue mints rebase deltas; off-chain cross-chain
  // mint/burn flows route through LitePSM via the orchestrator's USDC custody.
  await sendAndWait("Grant OKUM_MINTER to LitePSM", () => okuMoney.grantRole(ROLES.OKUM_MINTER, litePSMAddress));
  await sendAndWait("Grant OKUM_MINTER to RedemptionQueue", () => okuMoney.grantRole(ROLES.OKUM_MINTER, redemptionQueueAddress));

  // Cycle 4 (EVM-15): OKUM_BURNER was split out of OKUM_MINTER. Both consumers
  // of `OkuMoney.burn(...)` need the burner role:
  //   - LitePSM redeem flows (`_redeemOkuMShared`)
  //   - RedemptionQueue.processQueue (per-entry burn after USDC payout)
  // Without these grants every redeem reverts with AccessControlUnauthorizedAccount.
  await sendAndWait("Grant OKUM_BURNER to LitePSM", () => okuMoney.grantRole(ROLES.OKUM_BURNER, litePSMAddress));
  await sendAndWait("Grant OKUM_BURNER to RedemptionQueue", () => okuMoney.grantRole(ROLES.OKUM_BURNER, redemptionQueueAddress));

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

  // LitePSM roles — full operational set for testnet (all to deployer; see
  // contracts/README.md § Deployment runbook for the production RBAC split).
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

  // QUEUE_ORACLE_MANAGER is granted to admin at queue.initialize, but mirror an
  // explicit grant here for parity with the PSM_ORACLE_MANAGER pattern. The PSM
  // already received PSM_ORACLE_MANAGER above.
  await sendAndWait("Grant QUEUE_ORACLE_MANAGER to Admin", () => redemptionQueue.grantRole(ROLES.QUEUE_ORACLE_MANAGER, deployerAddress));

  // Wire the OracleRelay (USDC peg circuit-breaker) onto LitePSM and the queue.
  // The relay is optional: when no Chainlink USDC/USD feed is configured for
  // this chain the relay is null and we leave oracleRelay = address(0)
  // (peg check disabled — explicit operator-controlled enablement).
  if (oracleRelay !== null) {
    const relayAddress = await oracleRelay.getAddress();
    // Relay roles are already granted to admin at initialize-time, but mirror the
    // explicit grant here for symmetry with the PSM_/QUEUE_/VAULT_ patterns above.
    await sendAndWait("Grant RELAY_FEED_MANAGER to Admin", () => oracleRelay.grantRole(ROLES.RELAY_FEED_MANAGER, deployerAddress));
    await sendAndWait("Grant RELAY_CONFIG_MANAGER to Admin", () => oracleRelay.grantRole(ROLES.RELAY_CONFIG_MANAGER, deployerAddress));
    await sendAndWait("Wire OracleRelay onto LitePSM", () => litePSM.setOracleRelay(relayAddress));
    await sendAndWait("Wire OracleRelay onto RedemptionQueue", () => redemptionQueue.setOracleRelay(relayAddress));

    // EVM-J4: Post-wire invariant — PSM and Queue MUST point at the same relay.
    // If one setOracleRelay tx lands and the other reverts, the consumers desync
    // and the operator must rotate the relay on the surviving consumer. This
    // check catches it at deploy time instead of in the next user mint/redeem.
    const psmRelay = await litePSM.oracleRelay();
    const queueRelay = await redemptionQueue.oracleRelay();
    if (psmRelay !== queueRelay) {
      throw new Error(
        `OracleRelay wiring mismatch: LitePSM=${psmRelay}, RedemptionQueue=${queueRelay}`
      );
    }
    logger.success("  OracleRelay wiring matches across PSM and Queue");
  }
  void config;
}

async function verifyDeployment(
  bookKey: string,
  okuMoney: Contract,
  litePSM: Contract,
  redemptionQueue: Contract
): Promise<void> {
  logger.step(6, "Verifying Deployment");

  // Check roles
  const litePSMAddress = await litePSM.getAddress();
  const queueAddress = await redemptionQueue.getAddress();
  const hasLitePSMMinter = await okuMoney.hasRole(ROLES.OKUM_MINTER, litePSMAddress);
  const hasQueueMinter = await okuMoney.hasRole(ROLES.OKUM_MINTER, queueAddress);
  // Cycle 4 (EVM-15): OKUM_BURNER is required for redeem paths.
  const hasLitePSMBurner = await okuMoney.hasRole(ROLES.OKUM_BURNER, litePSMAddress);
  const hasQueueBurner = await okuMoney.hasRole(ROLES.OKUM_BURNER, queueAddress);

  logger.info(`  LitePSM has OKUM_MINTER: ${hasLitePSMMinter}`);
  logger.info(`  RedemptionQueue has OKUM_MINTER: ${hasQueueMinter}`);
  logger.info(`  LitePSM has OKUM_BURNER: ${hasLitePSMBurner}`);
  logger.info(`  RedemptionQueue has OKUM_BURNER: ${hasQueueBurner}`);
  if (!hasLitePSMBurner || !hasQueueBurner) {
    logger.warning("  Missing OKUM_BURNER grants — redeem paths will revert!");
  }

  // Verify all addresses saved
  const book = loadAddressBook();
  const contracts = book[bookKey] || {};
  // OracleRelay is conditionally deployed (skipped when no Chainlink USDC/USD feed is
  // configured for the chain), so it is NOT included in the "must exist" list.
  const expectedContracts = ["MockUSDC", "OkuMoney", "OkuDollar", "RedemptionQueue", "LitePSM"];

  const missing = expectedContracts.filter(c => !contracts[c]);
  if (missing.length > 0) {
    logger.warning(`  Missing contracts in address book: ${missing.join(", ")}`);
  } else {
    logger.success("  All contracts saved to address book");
  }

  if (contracts["OracleRelay"]) {
    logger.success(`  OracleRelay: ${contracts["OracleRelay"]}`);
  } else {
    logger.info("  OracleRelay: not deployed (no Chainlink USDC/USD feed configured)");
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

  // Step 3b: Deploy OracleRelay (when a Chainlink USDC/USD feed is configured for
  // this chain). Skipped on chains where the feed address is empty — those
  // deployments boot with the peg check disabled and rely on later
  // setOracleRelay(...) to enable it.
  const relayPriceFeed = (chainConfig as any).chainlinkUsdcUsdFeed ?? "";
  const oracleRelay = await deployOracleRelay(
    deployer,
    deployerAddress,
    bookKey,
    relayPriceFeed,
    config
  );

  // Step 4: Configure roles
  await configureRoles(
    deployerAddress,
    okuMoney,
    okuDollar,
    redemptionQueue,
    litePSM,
    oracleRelay,
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
          oracleRelay: addresses.OracleRelay, // optional — may be undefined for chains without a Chainlink USDC/USD feed
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
  logger.info("3. Test PSM flow: npx hardhat run scripts/test/test-onchain.ts --network " + networkName);
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
