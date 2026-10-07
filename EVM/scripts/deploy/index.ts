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
import { saveAddress, loadAddressBook, saveAddressBook, hasAddress, loadAddress, isForkKey } from "../utils/addressBook";
import { syncEvmRegistry } from "../utils/testnetRegistry";
import {
  getChainMetadata,
  DEV_WALLET_ADDRESS,
} from "../config/chains";
import { resolveNetworkContext, NetworkContext } from "../utils/networkContext";
import { ROLES, getRoleName } from "../config/roles";
import { mainnetGuard } from "../utils/mainnetGuard";
import { isYesMainnet } from "../utils/cli";
import { recordRoleGrant } from "../utils/roleRegistry";
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
// Transient-error Retry Helpers
// ============================================================================
//
// Stale nonces, "replacement transaction underpriced", "already known" and
// timeouts are RPC races, not real failures; retrying re-fetches the nonce and
// re-broadcasts.

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
  // BSC pending-tx quirk (`to: ""`); rpcCompat normally normalises it, and
  // retrying after the tx mines resolves any path that slips through.
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
 * bytecode at that address; otherwise return null so the caller deploys fresh.
 * This makes a partially-failed live deploy resumable.
 *
 * `FRESH_DEPLOY=true` skips the check and always redeploys, orphaning (not
 * touching) the prior contracts.
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

  // CREATE2 path: with the Arachnid factory present, impl and ERC1967 proxy are
  // deployed through it so addresses match across chains (differing init args,
  // e.g. the USDC address, still change the proxy address).
  // Salt scheme: scripts/config/deploymentVersion.ts.
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

      // Already at the predicted address (prior partial run): skip, or the
      // factory would revert.
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
        // Load-balanced RPCs can return stale `getCode` for seconds after the
        // tx mines, so poll rather than trust a single read.
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

      // 3. Register with the OZ manifest (off-chain, idempotent) so the upgrade
      //    script's storage-layout validation works.
      try {
        await upgrades.forceImport(proxyAddress, Factory, { kind: "uups" });
      } catch (e: any) {
        // Non-fatal: the upgrade script can re-import on demand.
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

  logger.step(6, "Verifying Contracts on Etherscan");
  logger.info("  Waiting 30s for Etherscan to index contracts...");
  await new Promise(resolve => setTimeout(resolve, 30000));

  const addresses = loadAddressBook()[networkName] || {};

  // Proxies need implementation + proxy verification; MockUSDC is a plain contract.
  const proxyContracts = ["OkuMoney", "OkuDollar", "LitePSM"];
  
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

  // CREATE2 path: MockUSDC's address feeds the PSM init args, so it must be
  // deterministic for the PSM proxy address to match across chains.
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
  const okuDollar = await deployUUPSProxy(
    "OkuDollar",
    [await okuMoney.getAddress(), "Oku Dollar", "usdOku", deployerAddress],
    bookKey,
    deployer
  );
  logger.success(`  OkuDollar: ${await okuDollar.getAddress()}`);

  return { okuMoney, okuDollar };
}

async function deployPSM(
  deployer: Signer,
  deployerAddress: string,
  bookKey: string,
  okuMoneyAddress: string,
  okuDollarAddress: string,
  usdcAddress: string,
  _config: DeploymentConfig
): Promise<Contract> {
  logger.step(3, "Deploying LitePSM");

  // LitePSM.initialize(okuMoney, okuDollar, usdc, admin).
  // On-chain wiring check: initialize() reverts AssetMismatch if okuDollar.asset()
  // != okuMoney, so a swapped/mismatched address pair fails loudly here rather than
  // silently mispricing every PSM/vault operation downstream.
  const litePSM = await deployUUPSProxy(
    "LitePSM",
    [
      okuMoneyAddress,                  // _okuMoney
      okuDollarAddress,                 // _okuDollar
      usdcAddress,                      // _usdc
      deployerAddress,                  // admin
    ],
    bookKey,
    deployer
  );
  logger.success(`  LitePSM: ${await litePSM.getAddress()}`);

  return litePSM;
}

async function configureRoles(
  okuMoney: Contract,
  litePSM: Contract,
  config: DeploymentConfig
): Promise<void> {
  logger.step(4, "Configuring Roles");

  const litePSMAddress = await litePSM.getAddress();

  // `initialize` already grants the deployer (admin) the full role set on all
  // three contracts, so only grants to OTHER holders are sent here. Production
  // role distribution is operator/grantRolesMainnet.ts.

  // LitePSM is the only OKUM_MINTER; every PSM mint/redeem (including
  // cross-chain flows, which route through it) goes through it.
  await sendAndWait("Grant OKUM_MINTER to LitePSM", () => okuMoney.grantRole(ROLES.OKUM_MINTER, litePSMAddress));

  // Redeems burn OkuM; without OKUM_BURNER they revert with AccessControlUnauthorizedAccount.
  await sendAndWait("Grant OKUM_BURNER to LitePSM", () => okuMoney.grantRole(ROLES.OKUM_BURNER, litePSMAddress));

  await sendAndWait("Set LitePSM minter allowance", () => okuMoney.configureMinterAllowance(litePSMAddress, config.minterAllowance));
}

export type RoleHolderKind = "litePSM" | "deployer";

export interface ExpectedRoleGrant {
  label: string;
  contract: "okuMoney" | "okuDollar" | "litePSM";
  role: string;
  holder: RoleHolderKind;
  /**
   * How the holder gets the role: sent by {@link configureRoles} ("script"),
   * or granted to the admin inside `initialize` ("initialize"). Only "script"
   * grants are written to the role ledger.
   */
  via: "script" | "initialize";
}

/**
 * The role matrix a fresh deploy must leave on-chain. `verifyDeployment` asserts
 * every entry with `hasRole`, and the deploy drill asserts against the same list,
 * so there is no hand-copied matrix to drift.
 */
export function expectedRoleGrants(): ExpectedRoleGrant[] {
  const init = (
    contract: ExpectedRoleGrant["contract"],
    prefix: string,
    roleName: keyof typeof ROLES
  ): ExpectedRoleGrant => ({
    label: `${prefix}.${roleName} -> Admin`,
    contract,
    role: ROLES[roleName],
    holder: "deployer",
    via: "initialize",
  });

  return [
    // Sent by configureRoles. Without these, mint/redeem revert.
    { label: "OkuMoney.OKUM_MINTER -> LitePSM", contract: "okuMoney", role: ROLES.OKUM_MINTER, holder: "litePSM", via: "script" },
    { label: "OkuMoney.OKUM_BURNER -> LitePSM", contract: "okuMoney", role: ROLES.OKUM_BURNER, holder: "litePSM", via: "script" },

    // Granted to the admin by each contract's `initialize`.
    init("okuMoney", "OkuMoney", "OKUM_REBASER"),
    init("okuMoney", "OkuMoney", "OKUM_ALLOWANCE_MANAGER"),
    init("okuMoney", "OkuMoney", "OKUM_PAUSER"),
    init("okuMoney", "OkuMoney", "OKUM_UNPAUSER"),
    init("okuMoney", "OkuMoney", "OKUM_BLACKLISTER"),
    init("okuMoney", "OkuMoney", "OKUM_UNBLACKLISTER"),
    init("okuMoney", "OkuMoney", "OKUM_CAP_MANAGER"),

    init("litePSM", "LitePSM", "PSM_BUFFER_DEPOSITOR"),
    init("litePSM", "LitePSM", "PSM_BUFFER_WITHDRAWER"),

    init("okuDollar", "OkuDollar", "VAULT_PAUSER"),
    init("okuDollar", "OkuDollar", "VAULT_UNPAUSER"),
    init("okuDollar", "OkuDollar", "VAULT_RESCUER"),
    // Roles are per-contract: OkuDollar has its own OKUM_(UN)BLACKLISTER holders.
    init("okuDollar", "OkuDollar", "OKUM_BLACKLISTER"),
    init("okuDollar", "OkuDollar", "OKUM_UNBLACKLISTER"),
  ];
}

async function verifyDeployment(
  bookKey: string,
  deployerAddress: string,
  okuMoney: Contract,
  okuDollar: Contract,
  litePSM: Contract
): Promise<void> {
  logger.step(5, "Verifying Deployment");

  const litePSMAddress = await litePSM.getAddress();

  const contracts: Record<string, Contract> = {
    okuMoney,
    okuDollar,
    litePSM,
  };
  const holders: Record<RoleHolderKind, string> = {
    litePSM: litePSMAddress,
    deployer: deployerAddress,
  };

  // Assert the FULL role matrix, not a spot check, and FAIL rather than warn.
  // Role misconfiguration is the failure mode most likely to brick a fresh
  // deploy (or silently leave a privilege hole), so it must surface here while
  // the operator is still watching, not later as a revert.
  const grants = expectedRoleGrants();
  const missingRoles: string[] = [];

  /** addresses.json contract key -> the name used in the grant ledger. */
  const LEDGER_CONTRACT_NAME: Record<string, string> = {
    okuMoney: "OkuMoney",
    okuDollar: "OkuDollar",
    litePSM: "LitePSM",
  };
  const HOLDER_LABEL: Record<RoleHolderKind, string> = {
    litePSM: "LitePSM (contract)",
    deployer: "DEV_WALLET / deployer-admin",
  };

  for (const g of grants) {
    const held = await contracts[g.contract].hasRole(g.role, holders[g.holder]);
    if (held) {
      logger.info(`  OK  ${g.label}`);
      // Ledger only the grants this script sends (`via: "script"`), and only once
      // confirmed on-chain, so a re-run over an existing deployment still
      // populates it. Roles `initialize` gives the admin are not script grants.
      // Forks excluded: their state is discarded. See utils/roleRegistry.ts.
      if (g.via === "script" && !isForkKey(bookKey)) {
        const rec = recordRoleGrant({
          at: new Date().toISOString(),
          chain: bookKey,
          contract: LEDGER_CONTRACT_NAME[g.contract] ?? g.contract,
          contractAddress: await contracts[g.contract].getAddress(),
          role: getRoleName(g.role),
          roleHash: g.role,
          grantee: holders[g.holder],
          granteeLabel: HOLDER_LABEL[g.holder],
          action: "grant",
          granter: deployerAddress,
          script: "deploy/index.ts",
        });
        if (!rec.ok) logger.warning(`  ledger write failed for ${g.label}: ${rec.error}`);
      }
    } else {
      logger.error(`  MISSING  ${g.label}`);
      missingRoles.push(g.label);
    }
  }

  // Minter allowances are separate from the role itself: `OkuMoney.mint`
  // checks BOTH `onlyRole(OKUM_MINTER)` and `minterAllowance[msg.sender]`, so
  // a role grant without an allowance still reverts with ExceedsAllowance.
  const psmAllowance = await okuMoney.minterAllowance(litePSMAddress);
  if (psmAllowance === 0n) missingRoles.push("LitePSM minter allowance is zero");
  logger.info(`  LitePSM minter allowance: ${psmAllowance}`);

  // Verify all addresses saved
  const book = loadAddressBook();
  const bookContracts = book[bookKey] || {};
  const expectedContracts = ["MockUSDC", "OkuMoney", "OkuDollar", "LitePSM"];
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
  litePSM: any;
  usdcAddress: string;
}

export interface RunDeployOptions {
  /**
   * Override the deployer signer. Defaults to the CLI behaviour: impersonate
   * `DEV_WALLET` on a fork, or use `getSigners()[0]` on a live network.
   *
   * In-process callers (the deploy/operator drills) pass an explicit signer so
   * the role matrix is anchored to a signer the test also holds; otherwise a
   * fork deploy grants every role to `DEV_WALLET`.
   */
  deployer?: Signer;
}

/**
 * Full deployment, callable in-process.
 *
 * Tests exercise the REAL deploy path through this — proxies, address-book
 * writes, and the complete role matrix — rather than a parallel fixture that
 * can drift. The CLI entry point at the bottom of this file is a thin wrapper.
 */
export async function runDeploy(
  opts: RunDeployOptions = {}
): Promise<DeployResult> {
  // Single source of truth for "what chain are we on / where do we read+write addresses".
  // Returns: { networkName, bookKey, isFork, chainConfig }.
  const ctx = await resolveNetworkContext();
  const { networkName, bookKey, isFork, chainConfig } = ctx;
  const config = getDeploymentConfig();

  // Deploying a fresh proxy set to a production chain is at least as
  // consequential as any single operator transaction, all of which are gated.
  // Forks are exempt: they are throwaway chains that reuse the mainnet name.
  if (!isFork) {
    mainnetGuard(networkName, { yesMainnet: isYesMainnet(), dryRun: false });
  }

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

  // Fork runs ("fork:<chain>") start from a cleared entry; the live "<chain>"
  // key is never touched. Live runs are not cleared: tryAttach() reuses
  // whatever is still on-chain.
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

  // Step 2: Deploy core contracts
  const { okuMoney, okuDollar } = await deployCoreContracts(deployer, deployerAddress, bookKey, config);

  // Step 3: Deploy PSM
  const litePSM = await deployPSM(
    deployer,
    deployerAddress,
    bookKey,
    await okuMoney.getAddress(),
    await okuDollar.getAddress(),
    usdcAddress,
    config
  );

  // Step 4: Configure roles
  await configureRoles(okuMoney, litePSM, config);

  // Step 5: Verify deployment state
  await verifyDeployment(
    bookKey,
    deployerAddress,
    okuMoney,
    okuDollar,
    litePSM
  );

  // Step 6: Etherscan verification (live networks only — never on a fork)
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
