/**
 * Unified Deployment Script for the OkuMoney (OkuM / USDOku) EVM Contracts
 *
 * Deploys all contracts, configures roles, and performs the post-deploy wiring
 * that the two-token model REQUIRES in order to function at all. Works for both
 * local fork testing (via the hardhat/localhost network) and live testnet.
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
 *   FRESH_DEPLOY=true     - Ignore address-book reuse; always redeploy
 *   VERIFY=true           - Verify contracts on Etherscan after deployment
 *   DEPLOY_TIN / DEPLOY_TOUT - override the initial fee schedule (bps)
 *
 * ---------------------------------------------------------------------------
 * WHY THE ORDER BELOW IS NOT NEGOTIABLE
 * ---------------------------------------------------------------------------
 *
 *   1. MockUSDC (testnet only)
 *   2. OkuM             — owns `asset()` / `usdcDecimalMultiplier()`, which the
 *                         module and queue cross-assert against in their own
 *                         initializers. It must exist first or they revert.
 *   3. RedemptionQueue  — the module's initializer takes its address.
 *   4. SubscriptionModule
 *   5. USDOku           — no dependency on any of the above (its initializer
 *                         takes only name/symbol/admin), but it is deployed
 *                         after so the wrapper can follow immediately.
 *   6. USDOkuWrapper    — binds OkuM + USDOku.
 *   7. Role wiring      — contract grants only; never to an EOA.
 *   8. FAIL-CLOSED WIRING. Two writes without which the system is inert:
 *        usdOku.setSolvencySource(wrapper) — else `setUsdOkuRate` reverts
 *                                          `SolvencyGapExceeded` as soon as any
 *                                          liability exists
 *        module.setUsdOkuWrapper(wrapper) — else `mintUsdOku`/`redeemUsdOku`
 *                                          revert `UsdOkuWrapperNotSet`
 *
 *      Down from four. `okuM.setStepFeeSource(module)` is gone entirely — the
 *      token no longer reads the fee schedule, because step coverage is a
 *      static relationship between constants rather than a runtime check. And
 *      `module.setFees` is no longer required: `initialize` seeds both legs at
 *      the coverage floor, so the deployment is accrual-ready before any
 *      configuration. `setFees` is now an optional raise, applied below only
 *      when the configured values differ from the shipped floor.
 *      All four are deliberately fail-closed in the contracts: a
 *      half-configured deployment cannot mark a multiplier it cannot cover,
 *      and cannot offer a one-transaction USDOku path it hasn't wired.
 *   9. OkuMultiplierAdapter (non-proxy, immutable)
 *  10. verifyDeployment
 */

import { ethers, network, upgrades, run } from "hardhat";
import { Contract, Signer } from "ethers";
import { saveAddress, loadAddressBook, saveAddressBook, hasAddress, loadAddress } from "../utils/addressBook";
import { syncEvmRegistry } from "../utils/addressRegistry";
import {
  getChainMetadata,
  DEV_WALLET_ADDRESS,
} from "../config/chains";
import { resolveNetworkContext } from "../utils/networkContext";
import { ROLES } from "../config/roles";
import { logger } from "../utils/logger";
import { MAX_STEP_BPS } from "../operator/_shared";
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

/** Every UUPS proxy in the system. Drives Etherscan proxy verification. */
const PROXY_CONTRACTS = [
  "OkuM",
  "USDOku",
  "USDOkuWrapper",
  "SubscriptionModule",
  "RedemptionQueue",
];

/** Contract names expected in the address book after a complete testnet run. */
const EXPECTED_CONTRACTS = [
  "MockUSDC",
  "OkuM",
  "RedemptionQueue",
  "SubscriptionModule",
  "USDOku",
  "USDOkuWrapper",
  "OkuMultiplierAdapter",
];

/** `type(IScaledUIAmount).interfaceId` — ERC-8056 core. */
const IID_SCALED_UI_CORE = "0xa60bf13d";



// Dev wallet address for impersonation on local fork (centralized in chains.ts)
const DEV_WALLET = DEV_WALLET_ADDRESS;

// ============================================================================
// Configuration
// ============================================================================

interface DeploymentConfig {
  maxSupply: bigint;
  minterAllowance: bigint;
  /** Mint fee, bps. Part of the step-coverage budget. */
  tin: bigint;
  /** Redemption fee, bps. Part of the step-coverage budget. */
  tout: bigint;
}

function getDeploymentConfig(): DeploymentConfig {
  return {
    maxSupply: ethers.parseUnits("1000000000", 18), // 1 billion
    minterAllowance: ethers.parseUnits("1000000000", 18), // 1 billion

    // Default fee schedule: BOTH LEGS AT THE STEP-COVERAGE FLOOR.
    //
    // `MAX_STEP_BPS` is the floor under each leg and the ceiling on a single
    // step, so shipping at the floor is the cheapest schedule the contracts
    // admit while still covering every admissible mark. It matches what
    // `initialize` already seeded, so the default deploy performs no `setFees`
    // call at all.
    //
    // `tin: 0` is NO LONGER VALID and would be rejected on-chain. The old
    // "keep subscription free, put all coverage on the exit" split worked under
    // a COMBINED coverage rule; the rule is now per-leg, because a cross-chain
    // round trip pays `tin` on the chain it mints on and `tout` on the chain it
    // redeems on, so a zero leg anywhere is a free leg for that pairing.
    tin: BigInt(process.env.DEPLOY_TIN ?? MAX_STEP_BPS.toString()),
    tout: BigInt(process.env.DEPLOY_TOUT ?? MAX_STEP_BPS.toString()),
  };
}

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
// any one of ~35 sequential txs in a full deploy can torpedo the whole run.

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

async function verifyAllContracts(networkName: string, stepNo: number): Promise<void> {
  if (!VERIFIABLE_NETWORKS.includes(networkName)) {
    logger.info("Skipping verification (not a verifiable network)");
    return;
  }

  if (!process.env.ETHERSCAN_API_KEY) {
    logger.warning("Skipping verification (ETHERSCAN_API_KEY not set)");
    return;
  }

  logger.step(stepNo, "Verifying Contracts on Etherscan");
  logger.info("  Waiting 30s for Etherscan to index contracts...");
  await new Promise(resolve => setTimeout(resolve, 30000));

  const addresses = loadAddressBook()[networkName] || {};

  for (const contractName of Object.keys(addresses)) {
    const address = addresses[contractName];
    logger.info(`  Verifying ${contractName} at ${address}...`);

    if (PROXY_CONTRACTS.includes(contractName)) {
      await verifyProxy(address, contractName);
    } else {
      // Non-proxy contracts (MockUSDC, OkuMultiplierAdapter).
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
  // downstream module + queue proxies (whose initializer args include the
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

async function deployOkuM(
  deployer: Signer,
  deployerAddress: string,
  bookKey: string,
  usdcAddress: string,
  config: DeploymentConfig
): Promise<Contract> {
  logger.step(2, "Deploying OkuM (the share token)");

  // OkuM MUST be deployed before the module and the queue: both cross-assert
  // `okuM.asset()` and `okuM.usdcDecimalMultiplier()` in their initializers, so
  // the token is the single source of truth for the USDC binding.
  //
  // Symbol is "OkuM", deliberately without an `r`/`s` prefix — an `r` prefix
  // reads as *rebasing*, which is precisely backwards for a fixed-balance
  // share token. USDOku is the leg that rebases.
  const okuM = await deployUUPSProxy(
    "OkuM",
    ["Oku Money", "OkuM", usdcAddress, deployerAddress, config.maxSupply],
    bookKey,
    deployer
  );
  logger.success(`  OkuM: ${await okuM.getAddress()}`);
  return okuM;
}

async function deployRedemptionQueue(
  deployer: Signer,
  deployerAddress: string,
  bookKey: string,
  okuMAddress: string,
  usdcAddress: string
): Promise<Contract> {
  logger.info("  Deploying RedemptionQueue...");
  const redemptionQueue = await deployUUPSProxy(
    "RedemptionQueue",
    [okuMAddress, usdcAddress, deployerAddress],
    bookKey,
    deployer
  );
  logger.success(`  RedemptionQueue: ${await redemptionQueue.getAddress()}`);
  return redemptionQueue;
}

async function deploySubscriptionModule(
  deployer: Signer,
  deployerAddress: string,
  bookKey: string,
  okuMAddress: string,
  redemptionQueueAddress: string,
  usdcAddress: string
): Promise<Contract> {
  logger.step(3, "Deploying SubscriptionModule");

  const subscriptionModule = await deployUUPSProxy(
    "SubscriptionModule",
    [okuMAddress, usdcAddress, redemptionQueueAddress, deployerAddress],
    bookKey,
    deployer
  );
  logger.success(`  SubscriptionModule: ${await subscriptionModule.getAddress()}`);
  return subscriptionModule;
}

async function deployUsdOku(
  deployer: Signer,
  deployerAddress: string,
  bookKey: string
): Promise<Contract> {
  logger.step(4, "Deploying USDOku (the rebasing dollar token)");

  // No USDC binding and no OkuM reference in the initializer: USDOku never
  // prices a conversion, so it needs neither. The wrapper is what ties it to
  // OkuM, and `setSolvencySource` (step 6) is what lets its rate authority see
  // realized backing.
  const usdOku = await deployUUPSProxy(
    "USDOku",
    ["USD Oku", "USDOku", deployerAddress],
    bookKey,
    deployer
  );
  logger.success(`  USDOku: ${await usdOku.getAddress()}`);
  return usdOku;
}

async function deployUsdOkuWrapper(
  deployer: Signer,
  deployerAddress: string,
  bookKey: string,
  okuMAddress: string,
  usdOkuAddress: string
): Promise<Contract> {
  logger.info("  Deploying USDOkuWrapper...");
  const wrapper = await deployUUPSProxy(
    "USDOkuWrapper",
    [okuMAddress, usdOkuAddress, deployerAddress],
    bookKey,
    deployer
  );
  logger.success(`  USDOkuWrapper: ${await wrapper.getAddress()}`);
  return wrapper;
}

async function deployOracleAdapter(
  deployer: Signer,
  bookKey: string,
  okuMAddress: string,
  stepNo: number
): Promise<Contract | null> {
  logger.step(stepNo, "Deploying OkuMultiplierAdapter");

  // Bounds: `M_oku` starts at 1e18 and only rises. `minAnswer` sits just below
  // to catch a corrupted read; `maxAnswer` of 10e18 is decades of headroom at
  // any plausible T-Bill mark cadence, and a value above it should stop a
  // lending market rather than be silently priced. `stalenessThreshold` of
  // 7 days means a lapsed mark surfaces to consumers within a week — the
  // multiplier stays flat and truthful in the meantime, but nobody should keep
  // pricing collateral off an unmarked index indefinitely.
  //
  // There is deliberately NO adapter for `M_usd`: it is a declared payout rate,
  // not a value a lending market should price collateral against.
  const minAnswer = ethers.parseUnits("0.99", 18);
  const maxAnswer = ethers.parseUnits("10", 18);
  const staleness = 7 * 24 * 60 * 60;

  const existing = await tryAttach("OkuMultiplierAdapter", bookKey, deployer);
  if (existing) return existing;

  const Factory = await ethers.getContractFactory("OkuMultiplierAdapter", deployer);
  const deployed = await Factory.deploy(okuMAddress, minAnswer, maxAnswer, staleness);
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  saveAddress(bookKey, "OkuMultiplierAdapter", address);
  logger.success(`  OkuMultiplierAdapter: ${address}`);
  return (await ethers.getContractAt("OkuMultiplierAdapter", address, deployer)) as unknown as Contract;
}

async function configureRoles(
  deployerAddress: string,
  okuM: Contract,
  redemptionQueue: Contract,
  subscriptionModule: Contract,
  usdOku: Contract,
  usdOkuWrapper: Contract,
  config: DeploymentConfig,
  stepNo: number
): Promise<void> {
  logger.step(stepNo, "Configuring Roles");

  const moduleAddress = await subscriptionModule.getAddress();
  const queueAddress = await redemptionQueue.getAddress();
  const wrapperAddress = await usdOkuWrapper.getAddress();
  const okuMAddress = await okuM.getAddress();
  const usdOkuAddress = await usdOku.getAddress();

  // Fail-fast: OkuM, the module and the queue must agree on the USDC binding
  // and its decimal multiplier BEFORE any role is granted, so a mismatch aborts
  // with no partially-roled proxies to unwind. The initializers already
  // cross-assert this on-chain; re-checking here turns a revert-at-init into a
  // clear message.
  //
  // USDOku and the wrapper are deliberately absent from this check: neither
  // holds a USDC binding. USDOku is denominated in dollars and the wrapper
  // converts OkuM <-> USDOku at `M_oku`, so USDC never enters either.
  const tokenAsset = (await okuM.asset()).toString();
  const moduleUsdc = (await subscriptionModule.usdc()).toString();
  const queueUsdc = (await redemptionQueue.usdc()).toString();
  if (
    tokenAsset.toLowerCase() !== moduleUsdc.toLowerCase() ||
    tokenAsset.toLowerCase() !== queueUsdc.toLowerCase()
  ) {
    throw new Error(
      `USDC mismatch: okuM=${tokenAsset} module=${moduleUsdc} queue=${queueUsdc}. ` +
        `Aborting before role grants.`
    );
  }
  const tokenDm = (await okuM.usdcDecimalMultiplier()).toString();
  const moduleDm = (await subscriptionModule.usdcDecimalMultiplier()).toString();
  const queueDm = (await redemptionQueue.usdcDecimalMultiplier()).toString();
  if (tokenDm !== moduleDm || tokenDm !== queueDm) {
    throw new Error(
      `Decimal multiplier mismatch: okuM=${tokenDm} module=${moduleDm} queue=${queueDm}.`
    );
  }
  logger.info(`  USDC binding verified: ${tokenAsset} (decimalMultiplier ${tokenDm})`);

  // Fail-fast: the wrapper must be bound to the two tokens we just deployed.
  // A wrapper pointing at a stale OkuM would price conversions off the wrong
  // multiplier — and because the queue/module keys are name-stable across the
  // v0.3 -> v0.4 rename, a stale address-book entry is a realistic way to get
  // there.
  const wrapperOkuM = (await usdOkuWrapper.okuM()).toString();
  const wrapperUsdOku = (await usdOkuWrapper.usdOku()).toString();
  if (
    wrapperOkuM.toLowerCase() !== okuMAddress.toLowerCase() ||
    wrapperUsdOku.toLowerCase() !== usdOkuAddress.toLowerCase()
  ) {
    throw new Error(
      `Wrapper binding mismatch: wrapper.okuM()=${wrapperOkuM} (expected ${okuMAddress}), ` +
        `wrapper.usdOku()=${wrapperUsdOku} (expected ${usdOkuAddress}).`
    );
  }
  logger.info(`  Wrapper binding verified: okuM=${wrapperOkuM} usdOku=${wrapperUsdOku}`);

  // ---- Contract grants. These must NEVER go to a key. ----
  // The module mints on `mint` and burns on the instant-redeem path.
  await sendAndWait("Grant OkuM.OKU_MINTER to SubscriptionModule", () =>
    okuM.grantRole(ROLES.OKU_MINTER, moduleAddress));
  await sendAndWait("Grant OkuM.OKU_BURNER to SubscriptionModule", () =>
    okuM.grantRole(ROLES.OKU_BURNER, moduleAddress));
  // RedemptionQueue burns per entry in `processQueue`. It never mints.
  await sendAndWait("Grant OkuM.OKU_BURNER to RedemptionQueue", () =>
    okuM.grantRole(ROLES.OKU_BURNER, queueAddress));

  await sendAndWait("Set SubscriptionModule minter allowance", () =>
    okuM.configureMinterAllowance(moduleAddress, config.minterAllowance));

  // The wrapper is the ONLY minter and burner of USDOku. Same role constants as
  // OkuM's, but AccessControl mappings are per contract, so these are entirely
  // separate grants — holding OKU_MINTER on OkuM confers nothing here.
  await sendAndWait("Grant USDOku.OKU_MINTER to USDOkuWrapper", () =>
    usdOku.grantRole(ROLES.OKU_MINTER, wrapperAddress));
  await sendAndWait("Grant USDOku.OKU_BURNER to USDOkuWrapper", () =>
    usdOku.grantRole(ROLES.OKU_BURNER, wrapperAddress));

  // Deliberately post-init: avoids a circular dependency and keeps the deploy
  // admin from calling enqueue/processQueue directly.
  await sendAndWait("Grant Queue.QUEUE_PSM to SubscriptionModule", () =>
    redemptionQueue.grantRole(ROLES.QUEUE_PSM, moduleAddress));

  // ---- Operational roles. Testnet: all to the deployer. ----
  // Production: run grantRolesMainnet.ts to split across cold/warm/orchestrator.
  //
  // OkuM's initializer already granted the deployer the full set, so most of
  // these are idempotent no-ops on a fresh deploy. They are re-issued anyway so
  // the script is also a repair tool for a deployment whose roles were
  // partially rotated — a grant that is already held costs one `hasRole`-shaped
  // no-op tx and removes an entire class of "which roles did we actually move?"
  // question from the runbook.
  for (const role of [
    "OKU_RATE_SETTER",
    "OKU_GUARDIAN",
    "OKU_ALLOWANCE_MANAGER",
    "OKU_PAUSER",
    "OKU_UNPAUSER",
    "OKU_BLACKLISTER",
    "OKU_UNBLACKLISTER",
    "OKU_CAP_MANAGER",
  ] as const) {
    await sendAndWait(`Grant OkuM.${role} to Admin`, () =>
      okuM.grantRole(ROLES[role], deployerAddress));
  }

  // USDOku carries the same OKU_* surface minus OKU_ALLOWANCE_MANAGER (it has
  // no minter-allowance system — the wrapper is the only minter, and gating it
  // twice would add a way to brick wrapping with no corresponding safety gain).
  for (const role of [
    "OKU_RATE_SETTER",
    "OKU_GUARDIAN",
    "OKU_PAUSER",
    "OKU_UNPAUSER",
    "OKU_BLACKLISTER",
    "OKU_UNBLACKLISTER",
    "OKU_CAP_MANAGER",
  ] as const) {
    await sendAndWait(`Grant USDOku.${role} to Admin`, () =>
      usdOku.grantRole(ROLES[role], deployerAddress));
  }

  for (const role of [
    "PSM_PAUSER",
    "PSM_UNPAUSER",
    "PSM_BUFFER_DEPOSITOR",
    "PSM_BUFFER_WITHDRAWER",
    "PSM_QUEUE_PROCESSOR",
    "PSM_FEE_MANAGER",
  ] as const) {
    await sendAndWait(`Grant SubscriptionModule.${role} to Admin`, () =>
      subscriptionModule.grantRole(ROLES[role], deployerAddress));
  }

  // WRAPPER_ADMIN is the USDOku sunset lever (`setWrapEnabled`). There is no
  // corresponding lever for `unwrap`, by design. WRAPPER_RESERVE_MANAGER is
  // the mirror-image recovery path (`withdrawSurplus`) once realized marks
  // overtake declared liability.
  for (const role of [
    "WRAPPER_PAUSER",
    "WRAPPER_UNPAUSER",
    "WRAPPER_ADMIN",
    "WRAPPER_RESERVE_MANAGER",
  ] as const) {
    await sendAndWait(`Grant USDOkuWrapper.${role} to Admin`, () =>
      usdOkuWrapper.grantRole(ROLES[role], deployerAddress));
  }

  await sendAndWait("Grant Queue.QUEUE_RESCUER to Admin", () =>
    redemptionQueue.grantRole(ROLES.QUEUE_RESCUER, deployerAddress));
}

/**
 * The writes that turn a set of deployed proxies into a working system.
 *
 * Both remaining ones are FAIL-CLOSED in the contracts, which means a
 * deployment that skips this step does not misbehave — it simply refuses to
 * mark a rate, or refuses the USDC<->USDOku convenience path. That is the
 * correct default, and it is also why this step has to be explicit and loudly
 * logged: the failure mode is "nothing happens when the orchestrator ticks",
 * which is easy to misdiagnose as an orchestrator bug.
 *
 * WAS THREE WRITES, NOW TWO. `okuM.setStepFeeSource(module)` is gone: the token
 * no longer reads the module's fee schedule, because step coverage became a
 * static relationship between constants. That removed both the write and the
 * token -> module dependency it created.
 */
async function wireFailClosedDependencies(
  usdOku: Contract,
  subscriptionModule: Contract,
  usdOkuWrapper: Contract,
  config: DeploymentConfig,
  stepNo: number
): Promise<void> {
  logger.step(stepNo, "Post-deploy wiring (REQUIRED — both fail closed)");

  const wrapperAddress = await usdOkuWrapper.getAddress();

  // 1. Solvency source. `USDOku.setUsdOkuRate` projects the liability to
  //    `rateEnd` and compares it against `wrapper.realizedBacking()`. An
  //    unwired source reads backing as zero, so once ANY USDOku exists the
  //    rate write reverts `SolvencyGapExceeded` with an infinite gap. It
  //    happens to succeed while `totalShares == 0` (no liability to outrun),
  //    which is exactly the sort of "worked on the empty deployment, broke on
  //    the first user" trap worth wiring before anyone wraps.
  const currentSolvencySource = (await usdOku.solvencySource()).toString();
  if (currentSolvencySource.toLowerCase() === wrapperAddress.toLowerCase()) {
    logger.info(`  usdOku.solvencySource already ${wrapperAddress} — skipping`);
  } else {
    await sendAndWait(`Set usdOku.solvencySource = USDOkuWrapper`, () =>
      usdOku.setSolvencySource(wrapperAddress));
  }

  // 2. Fee schedule — an OPTIONAL RAISE, no longer a required enable.
  //
  //    `SubscriptionModule.initialize` seeds both legs at `MAX_STEP_BPS`, the
  //    per-leg step-coverage floor, so the deployment can mark yield
  //    immediately and there is no ordering for an operator to get wrong. This
  //    replaces a required `setFees` call that the old dynamic-coverage design
  //    needed before any step was possible.
  //
  //    Values BELOW the floor are rejected on-chain (`FeeBelowStepFloor`), so
  //    the previous "refuse tin=0 tout=0" guard here is now redundant with the
  //    contract. Kept as a pre-flight check anyway, to fail with an
  //    explanation rather than a bare custom error.
  const currentTin: bigint = await subscriptionModule.tin();
  const currentTout: bigint = await subscriptionModule.tout();

  if (config.tin < MAX_STEP_BPS || config.tout < MAX_STEP_BPS) {
    throw new Error(
      `Refusing to set tin=${config.tin} tout=${config.tout}: each leg must be ` +
        `at least MAX_STEP_BPS (${MAX_STEP_BPS}bps), the per-leg step-coverage ` +
        `floor. The contract rejects this with FeeBelowStepFloor. Per-leg rather ` +
        `than combined because a cross-chain round trip pays tin on the chain it ` +
        `mints on and tout on the chain it redeems on.`
    );
  }

  if (currentTin === config.tin && currentTout === config.tout) {
    logger.info(`  Fees already tin=${currentTin} tout=${currentTout} — skipping`);
  } else {
    await sendAndWait(`Set fees tin=${config.tin}bps tout=${config.tout}bps`, () =>
      subscriptionModule.setFees(config.tin, config.tout));
  }

  logger.warning(
    `  STEP COVERAGE is static: MAX_STEP_BPS (${MAX_STEP_BPS}bps) is BOTH the ` +
      `hard ceiling on any single M_oku step (StepAboveMaximum) AND the floor ` +
      `under each fee leg (FeeBelowStepFloor). Composed, every admissible step ` +
      `is covered on each leg independently, permanently, with no state.`
  );
  logger.warning(
    `  MAX_STEP_BPS therefore sets the MINIMUM mark cadence. At a 5% annual ` +
      `mark a step is ~1.4bps daily, ~9.6bps weekly, ~40.7bps monthly, so ` +
      `${MAX_STEP_BPS}bps supports up to roughly ` +
      `${MAX_STEP_BPS >= 41n ? "monthly" : MAX_STEP_BPS >= 10n ? "weekly" : "daily"}. ` +
      `A longer outage must be walked over several marks — this is the ` +
      `operator-absence protection working as designed, not a limitation.`
  );
  logger.warning(
    `  There is NO high-water ratchet and NO reset escape hatch any more. Fees ` +
      `can be raised freely and lowered only to the floor, which by ` +
      `construction still covers every step the protocol can take.`
  );

  // 4. USDOku wrapper wiring. `mintUsdOku` / `redeemUsdOku` on the module
  //    revert `UsdOkuWrapperNotSet` until this is set — the one-transaction
  //    USDC <-> USDOku convenience path is otherwise unreachable. Wired last
  //    because the module initializes before the wrapper even exists (deploy
  //    order is OkuM, queue, module, USDOku, wrapper).
  const currentWrapper = (await subscriptionModule.usdOkuWrapper()).toString();
  if (currentWrapper.toLowerCase() === wrapperAddress.toLowerCase()) {
    logger.info(`  module.usdOkuWrapper already ${wrapperAddress} — skipping`);
  } else {
    await sendAndWait(`Set module.usdOkuWrapper = USDOkuWrapper`, () =>
      subscriptionModule.setUsdOkuWrapper(wrapperAddress));
  }
}

async function verifyDeployment(
  bookKey: string,
  okuM: Contract,
  subscriptionModule: Contract,
  redemptionQueue: Contract,
  usdOku: Contract,
  usdOkuWrapper: Contract,
  stepNo: number
): Promise<void> {
  logger.step(stepNo, "Verifying Deployment");

  const moduleAddress = await subscriptionModule.getAddress();
  const queueAddress = await redemptionQueue.getAddress();
  const wrapperAddress = await usdOkuWrapper.getAddress();

  const checks: Array<[string, boolean]> = [
    // --- Contract role grants. Without these, mint/redeem/wrap/unwrap revert. ---
    ["Module has OkuM.OKU_MINTER", await okuM.hasRole(ROLES.OKU_MINTER, moduleAddress)],
    ["Module has OkuM.OKU_BURNER", await okuM.hasRole(ROLES.OKU_BURNER, moduleAddress)],
    ["Queue has OkuM.OKU_BURNER", await okuM.hasRole(ROLES.OKU_BURNER, queueAddress)],
    ["Module has Queue.QUEUE_PSM", await redemptionQueue.hasRole(ROLES.QUEUE_PSM, moduleAddress)],
    ["Wrapper has USDOku.OKU_MINTER", await usdOku.hasRole(ROLES.OKU_MINTER, wrapperAddress)],
    ["Wrapper has USDOku.OKU_BURNER", await usdOku.hasRole(ROLES.OKU_BURNER, wrapperAddress)],
  ];
  let failed = false;
  for (const [label, ok] of checks) {
    logger.info(`  ${label}: ${ok}`);
    if (!ok) failed = true;
  }
  if (failed) {
    throw new Error(
      "Required contract role grants are missing — mint/redeem/wrap/unwrap would revert."
    );
  }

  // ERC-165. The two tokens must answer the ERC-8056 probe DIFFERENTLY, and
  // asserting both directions is the point:
  //
  //   OkuM   TRUE  — fixed raw balances scaled by `uiMultiplier()` for display.
  //                  A false here means every wallet doing capability detection
  //                  silently falls back to raw balances with no indication why.
  //   USDOku FALSE — `balanceOf` already returns dollars. A true here would make
  //                  an 8056-aware wallet apply a scaling factor to an
  //                  already-scaled balance, i.e. display the value squared.
  //                  That is a worse failure than no support at all, which is
  //                  why this is a hard abort rather than a warning.
  const okuMSupports = await okuM.supportsInterface(IID_SCALED_UI_CORE);
  const usdOkuSupports = await usdOku.supportsInterface(IID_SCALED_UI_CORE);
  logger.info(`  OkuM   supportsInterface(${IID_SCALED_UI_CORE}): ${okuMSupports} (want true)`);
  logger.info(`  USDOku supportsInterface(${IID_SCALED_UI_CORE}): ${usdOkuSupports} (want false)`);
  if (!okuMSupports) {
    throw new Error("OkuM does not advertise ERC-8056 — refusing to record the deploy.");
  }
  if (usdOkuSupports) {
    throw new Error(
      "USDOku advertises ERC-8056. Its balanceOf is already dollar-denominated, so an " +
        "8056-aware wallet would double-scale it. Refusing to record the deploy."
    );
  }

  // Multiplier self-consistency. Steps are immediate, so ERC-8056's pending
  // extension is implemented degenerately and `uiMultiplier() == newUIMultiplier()`
  // is an ALWAYS-TRUE invariant of this token, not a genesis-only coincidence.
  // A mismatch means the pending-multiplier semantics have drifted back toward
  // future-dated steps, which the sync window cannot fence.
  const m: bigint = await okuM.uiMultiplier();
  const newM: bigint = await okuM.newUIMultiplier();
  const effectiveAt: bigint = await okuM.effectiveAt();
  const lastStepped: bigint = await okuM.lastSteppedAt();
  logger.info(
    `  OkuM uiMultiplier=${m} newUIMultiplier=${newM} ` +
      `effectiveAt=${effectiveAt} lastSteppedAt=${lastStepped}`
  );
  if (m !== newM) {
    throw new Error(
      `uiMultiplier (${m}) != newUIMultiplier (${newM}). Steps are immediate, so ` +
        `these must be equal at all times.`
    );
  }
  if (effectiveAt !== lastStepped) {
    throw new Error(
      `effectiveAt (${effectiveAt}) != lastSteppedAt (${lastStepped}); ERC-8056's ` +
        `effectiveAt is defined as the timestamp of the last step.`
    );
  }

  // The fail-closed wiring. Each of these reverts the corresponding authority
  // write if unset, so a deployment that lands here misconfigured is silently
  // inert rather than loudly broken.
  const solvencySource = (await usdOku.solvencySource()).toString();
  logger.info(`  usdOku.solvencySource:   ${solvencySource}`);
  if (solvencySource.toLowerCase() !== wrapperAddress.toLowerCase()) {
    throw new Error(
      `usdOku.solvencySource is ${solvencySource}, expected the wrapper at ` +
        `${wrapperAddress}. setUsdOkuRate would revert SolvencyGapExceeded once ` +
        `any USDOku liability exists.`
    );
  }

  // STEP COVERAGE, verified as the per-leg invariant it now is. Each leg must
  // independently cover the largest admissible step, so this is two checks
  // rather than one on the sum: `(0, 2N)` would pass a combined check while
  // leaving the mint leg free for a cross-chain pairing.
  const tin: bigint = await subscriptionModule.tin();
  const tout: bigint = await subscriptionModule.tout();
  logger.info(
    `  Fee schedule: tin=${tin}bps tout=${tout}bps ` +
      `(floor ${MAX_STEP_BPS}bps per leg, round trip ${tin + tout}bps)`
  );
  if (tin < MAX_STEP_BPS || tout < MAX_STEP_BPS) {
    throw new Error(
      `Fee below the per-leg step-coverage floor: tin=${tin} tout=${tout}, floor ` +
        `${MAX_STEP_BPS}bps. This should be unreachable — initialize seeds the ` +
        `floor and setFees rejects anything below it — so reaching here means ` +
        `MAX_STEP_BPS in this script has drifted from Constants.sol, or the ` +
        `deployed bytecode is not the reviewed source.`
    );
  }

  // Wrapper genesis state. Zero liability against zero backing is defined as a
  // zero gap (not the `int256.max` sentinel), so a fresh deployment reads clean.
  const wrapEnabled: boolean = await usdOkuWrapper.wrapEnabled();
  const liability: bigint = await usdOkuWrapper.declaredLiability();
  const backing: bigint = await usdOkuWrapper.realizedBacking();
  const gapBps: bigint = await usdOkuWrapper.solvencyGapBps();
  logger.info(
    `  Wrapper: wrapEnabled=${wrapEnabled} declaredLiability=${liability} ` +
      `realizedBacking=${backing} solvencyGapBps=${gapBps}`
  );
  if (!wrapEnabled) {
    logger.warning("  wrap is DISABLED on a fresh deployment — the sunset lever is already pulled?");
  }

  const book = loadAddressBook();
  const contracts = book[bookKey] || {};
  const missing = EXPECTED_CONTRACTS.filter(c => !contracts[c]);
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

  logger.header(`OkuMoney (OkuM + USDOku) Deployment to ${chainConfig.name}${isFork ? " (LOCAL FORK)" : ""}`);
  logger.info(`Network: ${networkName} (chainId: ${chainConfig.chainId})`);
  logger.info(`Address book key: ${bookKey}`);

  // Get deployer - use impersonation for localhost (fork), real signer for live networks.
  let deployer: Signer;

  if (isFork) {
    // Impersonate dev wallet for local fork testing. The forked account's real
    // on-chain balance is inherited, but a fresh local node (or a dev wallet
    // that has never been funded on the forked chain) can leave it at zero —
    // top up from a mnemonic account so a rehearsal is not gated on testnet
    // faucet state.
    logger.info(`Impersonating dev wallet: ${DEV_WALLET}`);
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [DEV_WALLET],
    });
    const devBalance = await ethers.provider.getBalance(DEV_WALLET);
    if (devBalance < ethers.parseEther("1")) {
      const [funder] = await ethers.getSigners();
      logger.info(
        `  Dev wallet holds ${ethers.formatEther(devBalance)} ETH on this fork; ` +
          `topping up from ${await funder.getAddress()}`
      );
      const fundTx = await funder.sendTransaction({
        to: DEV_WALLET,
        value: ethers.parseEther("100"),
      });
      await fundTx.wait();
    }
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

  // Step 2: OkuM FIRST. The module and queue initializers both read
  // `okuM.asset()` / `okuM.usdcDecimalMultiplier()` and revert on mismatch, so
  // the token is the single source of truth for the USDC binding.
  const okuM = await deployOkuM(deployer, deployerAddress, bookKey, usdcAddress, config);
  const okuMAddress = await okuM.getAddress();

  const redemptionQueue = await deployRedemptionQueue(
    deployer,
    deployerAddress,
    bookKey,
    okuMAddress,
    usdcAddress
  );

  // Step 3: the subscription/redemption surface.
  const subscriptionModule = await deploySubscriptionModule(
    deployer,
    deployerAddress,
    bookKey,
    okuMAddress,
    await redemptionQueue.getAddress(),
    usdcAddress
  );

  // Step 4: the transitional dollar leg. USDOku exists to cover the gap while
  // ERC-8056 wallet support lands and is expected to be sunset; the wrapper is
  // where OkuM <-> USDOku is priced, always at `M_oku`, never at `M_usd`.
  const usdOku = await deployUsdOku(deployer, deployerAddress, bookKey);
  const usdOkuWrapper = await deployUsdOkuWrapper(
    deployer,
    deployerAddress,
    bookKey,
    okuMAddress,
    await usdOku.getAddress()
  );

  // Step 5: role wiring.
  await configureRoles(
    deployerAddress,
    okuM,
    redemptionQueue,
    subscriptionModule,
    usdOku,
    usdOkuWrapper,
    config,
    5
  );

  // Step 6: the wiring without which nothing works.
  await wireFailClosedDependencies(usdOku, subscriptionModule, usdOkuWrapper, config, 6);

  // Step 7: Oracle adapter. Ships WITH the contracts, not after: lending markets
  // will price off the multiplier regardless, and a hand-rolled integration has
  // no bounds and no staleness signal.
  await deployOracleAdapter(deployer, bookKey, okuMAddress, 7);

  // Step 8: Verify deployment state
  await verifyDeployment(
    bookKey,
    okuM,
    subscriptionModule,
    redemptionQueue,
    usdOku,
    usdOkuWrapper,
    8
  );

  // Step 9: Etherscan verification (live networks only — never on a fork)
  if (!isFork) {
    await verifyAllContracts(networkName, 9);
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

  // Mirror into the repo-root addresses.json registry (live networks only)
  if (!isFork) {
    try {
      const metadata = getChainMetadata(networkName);
      syncEvmRegistry(networkName, {
        chainId: metadata.chainId,
        rpcUrl: metadata.rpcUrl,
        explorer: metadata.explorer,
        contracts: {
          okuM: addresses.OkuM,
          usdOku: addresses.USDOku,
          usdOkuWrapper: addresses.USDOkuWrapper,
          subscriptionModule: addresses.SubscriptionModule,
          redemptionQueue: addresses.RedemptionQueue,
          okuMultiplierAdapter: addresses.OkuMultiplierAdapter,
          mockUsdc: addresses.MockUSDC,
        },
        // Capability flags PER TOKEN so the SDK and orchestrator can gate on
        // features without an on-chain probe. Per-token rather than
        // per-deployment because the two legs differ on exactly the flag that
        // matters most: OkuM is ERC-8056 and USDOku deliberately is not.
        // See EVM/README.md § Address book.
        standards: {
          okuM: ["ERC-20", "ERC-2612", "ERC-8056", "ERC-4626-conversion-subset"],
          usdOku: ["ERC-20", "ERC-2612", "rebasing"],
        },
        deployer: deployerAddress,
      });
    } catch (err: any) {
      logger.warning(`Registry sync failed (non-fatal): ${err.message}`);
    }
  }

  logger.info("Next steps:");
  logger.info("1. Check the updated addresses.json at the repo root");
  logger.info(
    `2. Size the fee schedule for real: tin+tout is currently ` +
      `${config.tin + config.tout}bps and caps every M_oku step ` +
      `(scripts/operator/setFees.ts)`
  );
  logger.info("3. Deploy SVM: cd ../SVM/oku-programs && NETWORK=devnet npm run deploy:programs && npm run deploy:init");
  logger.info("4. Smoke-test the full flow: npx hardhat run scripts/test/smoke.ts --network " + networkName + " --write");
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
