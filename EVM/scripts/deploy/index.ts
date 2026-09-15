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
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
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
}

function getDeploymentConfig(): DeploymentConfig {
  return {
    maxSupply: ethers.parseUnits("1000000000", 18), // 1 billion
    minterAllowance: ethers.parseUnits("1000000000", 18), // 1 billion
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
  // REMOVED: trailing `minCollateralRatio` initialize arg — collateralization is
  // exactly 1.0 by construction under the single-multiplier design.
  logger.info("  Deploying OkuDollar...");
  const okuDollar = await deployUUPSProxy(
    "OkuDollar",
    [await okuMoney.getAddress(), "Oku Dollar", "usdOku", deployerAddress],
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
  // On-chain wiring check: initialize() reverts AssetMismatch if okuDollar.asset()
  // != okuMoney, so a swapped/mismatched address pair fails loudly here rather than
  // silently mispricing every PSM/vault operation downstream.
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
  // REMOVED: VAULT_REBASER grant — OkuDollar has no rate of its own. The
  // OKUM_REBASER grant on OkuMoney above is what drives the shared multiplier.

  // RedemptionQueue roles
  await sendAndWait("Grant QUEUE_PSM to LitePSM", () => redemptionQueue.grantRole(ROLES.QUEUE_PSM, litePSMAddress));

  // LitePSM roles — full operational set for testnet (all to deployer; see
  // contracts/README.md § Deployment runbook for the production RBAC split).
  // Production: run grantRolesMainnet.ts to distribute roles to cold/warm multisig + orchestrator.
  await sendAndWait("Grant PSM_BUFFER_DEPOSITOR to Admin", () => litePSM.grantRole(ROLES.PSM_BUFFER_DEPOSITOR, deployerAddress));
  await sendAndWait("Grant PSM_QUEUE_PROCESSOR to Admin", () => litePSM.grantRole(ROLES.PSM_QUEUE_PROCESSOR, deployerAddress));
  await sendAndWait("Grant PSM_BUFFER_WITHDRAWER to Admin", () => litePSM.grantRole(ROLES.PSM_BUFFER_WITHDRAWER, deployerAddress));

  // OkuMoney additional admin roles
  await sendAndWait("Grant OKUM_PAUSER to Admin", () => okuMoney.grantRole(ROLES.OKUM_PAUSER, deployerAddress));
  await sendAndWait("Grant OKUM_UNPAUSER to Admin", () => okuMoney.grantRole(ROLES.OKUM_UNPAUSER, deployerAddress));
  await sendAndWait("Grant OKUM_BLACKLISTER to Admin", () => okuMoney.grantRole(ROLES.OKUM_BLACKLISTER, deployerAddress));
  await sendAndWait("Grant OKUM_UNBLACKLISTER to Admin", () => okuMoney.grantRole(ROLES.OKUM_UNBLACKLISTER, deployerAddress));
  await sendAndWait("Grant OKUM_CAP_MANAGER to Admin", () => okuMoney.grantRole(ROLES.OKUM_CAP_MANAGER, deployerAddress));

  // OkuDollar additional admin roles
  await sendAndWait("Grant VAULT_PAUSER to Admin", () => okuDollar.grantRole(ROLES.VAULT_PAUSER, deployerAddress));
  await sendAndWait("Grant VAULT_UNPAUSER to Admin", () => okuDollar.grantRole(ROLES.VAULT_UNPAUSER, deployerAddress));
  // REMOVED: VAULT_RESERVE_MANAGER grant (role deleted). VAULT_RESCUER replaces it
  // as the only asset-touching vault role — it withdraws OkuM donated to the vault.
  await sendAndWait("Grant VAULT_RESCUER to Admin", () => okuDollar.grantRole(ROLES.VAULT_RESCUER, deployerAddress));

  // OkuDollar blacklist roles (shared OKUM_ prefix — one grant covers both tokens)
  await sendAndWait("Grant OKUM_BLACKLISTER on OkuDollar to Admin", () => okuDollar.grantRole(ROLES.OKUM_BLACKLISTER, deployerAddress));
  await sendAndWait("Grant OKUM_UNBLACKLISTER on OkuDollar to Admin", () => okuDollar.grantRole(ROLES.OKUM_UNBLACKLISTER, deployerAddress));

  // RedemptionQueue additional role
  await sendAndWait("Grant QUEUE_RESCUER to Admin", () => redemptionQueue.grantRole(ROLES.QUEUE_RESCUER, deployerAddress));
}

/**
 * The complete set of role grants {@link configureRoles} is expected to have
 * made, as `[label, contract-key, role, holder-kind]` tuples.
 *
 * Exported so the deploy drill asserts against the SAME source of truth the
 * deploy itself verifies — a test with its own hand-copied list would silently
 * drift from `configureRoles` the moment a role is added or removed.
 */
export type RoleHolderKind = "litePSM" | "redemptionQueue" | "deployer";

export interface ExpectedRoleGrant {
  label: string;
  contract: "okuMoney" | "okuDollar" | "redemptionQueue" | "litePSM";
  role: string;
  holder: RoleHolderKind;
}

export function expectedRoleGrants(): ExpectedRoleGrant[] {
  return [
    // OkuMoney — contract-to-contract grants. Without these, mint/redeem revert.
    { label: "OkuMoney.OKUM_MINTER -> LitePSM", contract: "okuMoney", role: ROLES.OKUM_MINTER, holder: "litePSM" },
    { label: "OkuMoney.OKUM_MINTER -> RedemptionQueue", contract: "okuMoney", role: ROLES.OKUM_MINTER, holder: "redemptionQueue" },
    { label: "OkuMoney.OKUM_BURNER -> LitePSM", contract: "okuMoney", role: ROLES.OKUM_BURNER, holder: "litePSM" },
    { label: "OkuMoney.OKUM_BURNER -> RedemptionQueue", contract: "okuMoney", role: ROLES.OKUM_BURNER, holder: "redemptionQueue" },

    // OkuMoney — operational/admin grants.
    { label: "OkuMoney.OKUM_REBASER -> Admin", contract: "okuMoney", role: ROLES.OKUM_REBASER, holder: "deployer" },
    { label: "OkuMoney.OKUM_ALLOWANCE_MANAGER -> Admin", contract: "okuMoney", role: ROLES.OKUM_ALLOWANCE_MANAGER, holder: "deployer" },
    { label: "OkuMoney.OKUM_PAUSER -> Admin", contract: "okuMoney", role: ROLES.OKUM_PAUSER, holder: "deployer" },
    { label: "OkuMoney.OKUM_UNPAUSER -> Admin", contract: "okuMoney", role: ROLES.OKUM_UNPAUSER, holder: "deployer" },
    { label: "OkuMoney.OKUM_BLACKLISTER -> Admin", contract: "okuMoney", role: ROLES.OKUM_BLACKLISTER, holder: "deployer" },
    { label: "OkuMoney.OKUM_UNBLACKLISTER -> Admin", contract: "okuMoney", role: ROLES.OKUM_UNBLACKLISTER, holder: "deployer" },
    { label: "OkuMoney.OKUM_CAP_MANAGER -> Admin", contract: "okuMoney", role: ROLES.OKUM_CAP_MANAGER, holder: "deployer" },

    // RedemptionQueue.
    { label: "RedemptionQueue.QUEUE_PSM -> LitePSM", contract: "redemptionQueue", role: ROLES.QUEUE_PSM, holder: "litePSM" },
    { label: "RedemptionQueue.QUEUE_RESCUER -> Admin", contract: "redemptionQueue", role: ROLES.QUEUE_RESCUER, holder: "deployer" },

    // LitePSM operational set.
    { label: "LitePSM.PSM_BUFFER_DEPOSITOR -> Admin", contract: "litePSM", role: ROLES.PSM_BUFFER_DEPOSITOR, holder: "deployer" },
    { label: "LitePSM.PSM_QUEUE_PROCESSOR -> Admin", contract: "litePSM", role: ROLES.PSM_QUEUE_PROCESSOR, holder: "deployer" },
    { label: "LitePSM.PSM_BUFFER_WITHDRAWER -> Admin", contract: "litePSM", role: ROLES.PSM_BUFFER_WITHDRAWER, holder: "deployer" },

    // OkuDollar.
    { label: "OkuDollar.VAULT_PAUSER -> Admin", contract: "okuDollar", role: ROLES.VAULT_PAUSER, holder: "deployer" },
    { label: "OkuDollar.VAULT_UNPAUSER -> Admin", contract: "okuDollar", role: ROLES.VAULT_UNPAUSER, holder: "deployer" },
    { label: "OkuDollar.VAULT_RESCUER -> Admin", contract: "okuDollar", role: ROLES.VAULT_RESCUER, holder: "deployer" },
    { label: "OkuDollar.OKUM_BLACKLISTER -> Admin", contract: "okuDollar", role: ROLES.OKUM_BLACKLISTER, holder: "deployer" },
    { label: "OkuDollar.OKUM_UNBLACKLISTER -> Admin", contract: "okuDollar", role: ROLES.OKUM_UNBLACKLISTER, holder: "deployer" },
  ];
}

async function verifyDeployment(
  bookKey: string,
  deployerAddress: string,
  okuMoney: Contract,
  okuDollar: Contract,
  litePSM: Contract,
  redemptionQueue: Contract
): Promise<void> {
  logger.step(6, "Verifying Deployment");

  const litePSMAddress = await litePSM.getAddress();
  const queueAddress = await redemptionQueue.getAddress();

  const contracts: Record<string, Contract> = {
    okuMoney,
    okuDollar,
    redemptionQueue,
    litePSM,
  };
  const holders: Record<RoleHolderKind, string> = {
    litePSM: litePSMAddress,
    redemptionQueue: queueAddress,
    deployer: deployerAddress,
  };

  // Assert the FULL role matrix, not a 4-role spot check.
  //
  // This previously logged four `hasRole` results and, on a missing
  // OKUM_BURNER, printed "redeem paths will revert!" as a *warning* and then
  // exited 0 — a deployment with a broken redeem path reported success. Role
  // misconfiguration is the failure mode most likely to brick a fresh deploy
  // (or silently leave a privilege hole), so it must fail loudly here, while
  // the operator is still watching, rather than surface later as a revert.
  const grants = expectedRoleGrants();
  const missingRoles: string[] = [];

  for (const g of grants) {
    const held = await contracts[g.contract].hasRole(g.role, holders[g.holder]);
    if (held) {
      logger.info(`  OK  ${g.label}`);
    } else {
      logger.error(`  MISSING  ${g.label}`);
      missingRoles.push(g.label);
    }
  }

  // Minter allowances are separate from the role itself: `OkuMoney.mint`
  // checks BOTH `onlyRole(OKUM_MINTER)` and `minterAllowance[msg.sender]`, so
  // a role grant without an allowance still reverts with ExceedsAllowance.
  const psmAllowance = await okuMoney.minterAllowance(litePSMAddress);
  const queueAllowance = await okuMoney.minterAllowance(queueAddress);
  if (psmAllowance === 0n) missingRoles.push("LitePSM minter allowance is zero");
  if (queueAllowance === 0n) missingRoles.push("RedemptionQueue minter allowance is zero");
  logger.info(`  LitePSM minter allowance: ${psmAllowance}`);
  logger.info(`  RedemptionQueue minter allowance: ${queueAllowance}`);

  // Verify all addresses saved
  const book = loadAddressBook();
  const bookContracts = book[bookKey] || {};
  const expectedContracts = ["MockUSDC", "OkuMoney", "OkuDollar", "RedemptionQueue", "LitePSM"];
  const missingContracts = expectedContracts.filter(c => !bookContracts[c]);

  if (missingRoles.length > 0 || missingContracts.length > 0) {
    const parts: string[] = [];
    if (missingRoles.length > 0) {
      parts.push(`missing role grants / allowances:\n  - ${missingRoles.join("\n  - ")}`);
    }
    if (missingContracts.length > 0) {
      parts.push(`missing contracts in address book: ${missingContracts.join(", ")}`);
    }
    throw new Error(`Deployment verification FAILED — ${parts.join("; ")}`);
  }

  logger.success(`  All ${grants.length} role grants verified`);
  logger.success("  All contracts saved to address book");
}

// ============================================================================
// Main Deployment Function
// ============================================================================

/** Contract handles + context returned by {@link runDeploy}, for in-process callers. */
export interface DeployResult {
  ctx: NetworkContext;
  bookKey: string;
  deployerAddress: string;
  okuMoney: any;
  okuDollar: any;
  redemptionQueue: any;
  litePSM: any;
  usdcAddress: string;
}

export interface RunDeployOptions {
  /**
   * Override the deployer signer. Defaults to the CLI behaviour: impersonate
   * `DEV_WALLET` on a fork, or use `getSigners()[0]` on a live network.
   *
   * In-process callers (the deploy drill, the operator drill) pass an explicit
   * signer so the resulting role matrix is anchored to a signer the test also
   * holds — without this, a fork deploy grants every role to `DEV_WALLET` and
   * a test using `getSigners()[0]` as admin would hold none of them.
   */
  deployer?: Signer;
}

/**
 * Full deployment, callable in-process.
 *
 * Extracted from the former `main()` so tests can exercise the REAL deploy
 * path — proxies, address-book writes, and the complete role matrix — rather
 * than re-implementing a parallel fixture that can drift from production. The
 * CLI entry point at the bottom of this file is now a thin wrapper.
 */
export async function runDeploy(
  opts: RunDeployOptions = {}
): Promise<DeployResult> {
  // Single source of truth for "what chain are we on / where do we read+write addresses".
  // Returns: { networkName, bookKey, isFork, chainConfig }.
  const ctx = await resolveNetworkContext();
  const { networkName, bookKey, isFork, chainConfig } = ctx;
  const config = getDeploymentConfig();

  logger.header(`OkuMoney Deployment to ${chainConfig.name}${isFork ? " (LOCAL FORK)" : ""}`);
  logger.info(`Network: ${networkName} (chainId: ${chainConfig.chainId})`);
  logger.info(`Address book key: ${bookKey}`);

  // Get deployer - caller override, else impersonation for localhost (fork),
  // else real signer for live networks.
  let deployer: Signer;

  if (opts.deployer) {
    deployer = opts.deployer;
    logger.info("Using caller-supplied deployer signer");
  } else if (isFork) {
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
    deployerAddress,
    okuMoney,
    okuDollar,
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
  logger.info("3. Test PSM flow: npx hardhat run scripts/test/test-onchain.ts --network " + networkName);

  return {
    ctx,
    bookKey,
    deployerAddress,
    okuMoney,
    okuDollar,
    redemptionQueue,
    litePSM,
    usdcAddress,
  };
}

// CLI entry point. Guarded so importing this module (e.g. from the deploy
// drill) does NOT kick off a deployment and then kill the host process via
// `process.exit` — the same `require.main === module` pattern the operator
// scripts use.
if (require.main === module) {
  runDeploy()
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
}
