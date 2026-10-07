/**
 * Generic Upgrade Script for OkuMoney EVM Contracts
 *
 * Upgrades the implementation behind one or more existing UUPS proxies to the
 * freshly-compiled source in `./src`. Works against:
 *   - A local Hardhat fork (rehearsal): impersonates the dev wallet, optionally
 *     auto-grants any missing upgrader role from the impersonated DEFAULT_ADMIN.
 *   - A live network: uses the signer derived from PRIVATE_KEY. Aborts if the
 *     signer doesn't already hold the contract-specific upgrader role.
 *
 * Supported targets are the keys of the UPGRADE_TARGETS table below. New ones
 * need a table entry plus a matching state reader in ./preState.ts.
 *
 * Usage:
 *
 *   # Fork rehearsal (terminal 1: `FORK_NETWORK=sepolia npm run node`)
 *   TARGETS=LitePSM,OkuDollar npx hardhat run scripts/upgrade/index.ts --network localhost
 *
 *   # Live network
 *   TARGETS=LitePSM,OkuDollar npx hardhat run scripts/upgrade/index.ts --network sepolia
 *
 *   # Single target
 *   TARGETS=LitePSM npx hardhat run scripts/upgrade/index.ts --network base
 *
 *   # Override proxy address (debugging; defaults to scripts/config/addresses.json)
 *   TARGETS=LitePSM PROXY_LitePSM=0x... npx hardhat run scripts/upgrade/index.ts --network sepolia
 *
 *   # Skip Etherscan verification of the new impl
 *   TARGETS=LitePSM SKIP_VERIFY=true npx hardhat run scripts/upgrade/index.ts --network base
 *
 * Storage-layout safety:
 *   The OpenZeppelin upgrades plugin (`upgrades.upgradeProxy`) validates the new
 *   implementation against the on-chain layout recorded in `.openzeppelin/<chain>.json`
 *   and refuses to broadcast on any layout-incompatible change. No `unsafeAllow`
 *   flags are passed.
 *
 * Audit trail:
 *   Each successful upgrade appends a record to `addresses.json -> upgrades -> <bookKey>`
 *   with old/new impl, tx hash, signer, and timestamp.
 */

import { ethers, network, upgrades, run, artifacts } from "hardhat";
import { Contract, Signer } from "ethers";
import {
  loadAddress,
  hasAddress,
  appendUpgradeRecord,
  UpgradeRecord,
} from "../utils/addressBook";
import { DEV_WALLET_ADDRESS } from "../config/chains";
import { resolveNetworkContext } from "../utils/networkContext";
import { ROLES, getRoleName } from "../config/roles";
import { logger } from "../utils/logger";
import { STATE_READERS, StateSnapshot, diffSnapshots } from "./preState";
import { isMainnetNetwork } from "../utils/mainnetGuard";

// ============================================================================
// Upgrade target registry
// ============================================================================
//
// Add a row here plus a state reader in preState.ts; the main loop is
// target-agnostic.
//   - factory:      hardhat contract name.
//   - upgraderRole: role gating `_authorizeUpgrade` (for Transparent proxies the
//                   ProxyAdmin owner gates the upgrade; the role is pre-flight only).
//   - proxyKind:    "uups" (default) or "transparent"; must match the
//                   `.openzeppelin/<chain>.json` manifest.
//   - stateKey:     key into STATE_READERS (defaults to `factory`).

type ProxyKind = "uups" | "transparent";

interface UpgradeTarget {
  factory: string;
  upgraderRole: string;
  proxyKind?: ProxyKind;
  stateKey?: string;
}

const UPGRADE_TARGETS: Record<string, UpgradeTarget> = {
  // UUPS proxies — upgrade gated by the contract's own _authorizeUpgrade role.
  OkuMoney:        { factory: "OkuMoney",        upgraderRole: ROLES.OKUM_UPGRADER },
  OkuDollar:       { factory: "OkuDollar",       upgraderRole: ROLES.VAULT_UPGRADER },
  LitePSM:         { factory: "LitePSM",         upgraderRole: ROLES.PSM_UPGRADER },
};

// Etherscan-family networks; mirrors deploy/index.ts.
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

// ============================================================================
// Transient-error Retry Helpers
// ============================================================================
//
// Same RPC-race handling as deploy/index.ts (kept local: that file's helpers
// are not exported).

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
  // Upstream node overloaded / rate-limiting.
  /Unable to complete request at this time/i,
  /service unavailable/i,
  /503/i,
  /502/i,
  /504/i,
  // Public-RPC throttling; `withRetry`'s exponential backoff handles it.
  /rate limit/i,
  /too many requests/i,
];

function isTransientError(err: any): boolean {
  const msg = (err?.message || String(err)).toString();
  return TRANSIENT_PATTERNS.some((re) => re.test(msg));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

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
      const delay = baseDelayMs * Math.pow(2, attempt);
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

// ============================================================================
// Bytecode-equality short-circuit
// ============================================================================
//
// Skip the impl deploy + upgrade tx when the local runtime bytecode equals the
// current implementation's. Two normalizations make the comparison fair:
//   1. Strip the CBOR metadata footer (source/compiler hash; changes on comment edits).
//   2. Zero immutable ranges (UUPSUpgradeable inlines the impl's own address).
// On any doubt we fall through to OZ's `prepareUpgrade`, which dedups itself.
// Do not set `metadata.bytecodeHash = "none"` to simplify this: every contract
// would then differ from its on-chain bytecode on the next run.

const METADATA_FOOTER_RE = /a264[0-9a-f]{2,500}0033$/i;

function stripMetadata(hexCode: string): string {
  // Normalize to a leading-0x lowercased hex string before stripping.
  const lc = hexCode.startsWith("0x") ? hexCode.slice(2).toLowerCase() : hexCode.toLowerCase();
  return lc.replace(METADATA_FOOTER_RE, "");
}

/** A byte range in `deployedBytecode`, expressed in BYTE offsets. */
interface ByteRange {
  start: number;
  length: number;
}

/**
 * Read all immutable byte ranges for `contractName` from the build-info
 * (hardhat artifacts don't surface these directly). Returns an empty array if
 * there are no immutables, or if the lookup fails for any reason.
 */
async function readImmutableRanges(contractName: string): Promise<ByteRange[]> {
  try {
    const fqNames = await artifacts.getAllFullyQualifiedNames();
    const fqName = fqNames.find((n) => n.endsWith(`:${contractName}`));
    if (!fqName) return [];
    const buildInfo = await artifacts.getBuildInfo(fqName);
    if (!buildInfo) return [];
    // fqName is "src/path/File.sol:ContractName".
    const [sourcePath, plainName] = fqName.split(":");
    const contractOut = buildInfo.output?.contracts?.[sourcePath]?.[plainName] as any;
    const immRefs = contractOut?.evm?.deployedBytecode?.immutableReferences as
      | Record<string, ByteRange[]>
      | undefined;
    if (!immRefs) return [];
    return Object.values(immRefs).flat();
  } catch {
    return [];
  }
}

/**
 * Zero out the given byte ranges in a hex string (no 0x prefix, lowercased).
 * Returns the modified hex string.
 *
 * Each `ByteRange.start` and `length` are in BYTES; we multiply by 2 for hex.
 */
function zeroRanges(hex: string, ranges: ByteRange[]): string {
  if (ranges.length === 0) return hex;
  const chars = hex.split("");
  for (const r of ranges) {
    const startHex = r.start * 2;
    const endHex = startHex + r.length * 2;
    for (let i = startHex; i < endHex && i < chars.length; i++) {
      chars[i] = "0";
    }
  }
  return chars.join("");
}

/**
 * Compare the locally-compiled runtime bytecode for `contractName` against the
 * runtime code currently at `oldImpl` on-chain. Returns true if (after
 * metadata stripping AND zeroing of immutable byte ranges) they are
 * byte-identical, meaning a re-deploy + upgrade would be a no-op.
 *
 * Returns false on any read error so we fall through to the normal upgrade
 * path rather than skipping silently.
 */
async function isImplementationBytecodeUnchanged(
  contractName: string,
  oldImpl: string
): Promise<boolean> {
  try {
    const artifact = await artifacts.readArtifact(contractName);
    const immRanges = await readImmutableRanges(contractName);

    const localRuntimeStripped = stripMetadata(artifact.deployedBytecode);
    const onChainRuntimeStripped = stripMetadata(await ethers.provider.getCode(oldImpl));
    if (!localRuntimeStripped || !onChainRuntimeStripped) return false;

    // Zero immutable byte ranges on BOTH sides: the on-chain side has real
    // values to ignore, and the local artifact is normalized too in case a
    // future Solidity rev changes the placeholder bytes.
    const localNormalized = zeroRanges(localRuntimeStripped, immRanges);
    const onChainNormalized = zeroRanges(onChainRuntimeStripped, immRanges);

    return localNormalized === onChainNormalized;
  } catch (err: any) {
    logger.warning(
      `  Bytecode equality check failed (${err.message?.slice(0, 80) ?? err}); ` +
        `falling through to full upgrade flow.`
    );
    return false;
  }
}

// ============================================================================
// Transparent-upgrade receipt recovery
// ============================================================================
//
// `upgrades.upgradeProxy(..., { kind: "transparent" })` often returns a handle
// whose `deploymentTransaction()` is null even though the upgrade landed. This
// scans the proxy's logs from `fromBlock` (captured BEFORE the call) for the
// latest `Upgraded(address)` event and rebuilds a receipt-shaped object. On a
// miss it returns the "<no-upgrade-event-found>" sentinel; step 7 catches a
// contradiction if the slot did move.

const UPGRADED_TOPIC_HEX =
  "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";

interface RecoveredReceipt {
  hash: string;
  blockNumber: number;
  logs: Array<{ address: string; topics: string[]; data: string }>;
}

async function recoverTransparentUpgradeReceipt(
  proxyAddress: string,
  fromBlock: number
): Promise<RecoveredReceipt> {
  // Start one block early to tolerate a fork-node off-by-one on the block read.
  const safeFrom = Math.max(0, fromBlock - 1);
  const latest = await ethers.provider.getBlockNumber();

  // 10-block steps: some hosted RPC tiers reject wider `eth_getLogs` ranges.
  const MAX_STEPS = 10;
  const STEP = 10;
  let logs: any[] = [];
  let scanFrom = safeFrom;
  for (let step = 0; step < MAX_STEPS; step++) {
    const scanTo = Math.min(scanFrom + STEP - 1, latest);
    try {
      logs = await ethers.provider.getLogs({
        address: proxyAddress,
        topics: [UPGRADED_TOPIC_HEX],
        fromBlock: scanFrom,
        toBlock: scanTo,
      });
    } catch (err: any) {
      throw new Error(
        `Transparent recovery getLogs failed on blocks ${scanFrom}..${scanTo}: ` +
          `${err?.message ?? err}. Cannot recover upgrade tx hash.`
      );
    }
    if (logs.length > 0) break;
    if (scanTo >= latest) break;
    scanFrom = scanTo + 1;
  }

  if (logs.length === 0) {
    logger.warning(
      `  upgradeProxy returned a handle with no deploymentTransaction AND ` +
        `no Upgraded(address) event found between blocks ${safeFrom}..${Math.min(safeFrom + MAX_STEPS * STEP, latest)} — ` +
        `treating as no-op (slot may not have moved).`
    );
    return {
      hash: "<no-upgrade-event-found>",
      blockNumber: 0,
      logs: [],
    };
  }

  // Logs are chronological: the last one is ours; several mean a concurrent upgrade.
  if (logs.length > 1) {
    logger.warning(
      `  ${logs.length} Upgraded(address) events found in window ` +
        `${safeFrom}..${latest}; using the most recent. Manual check of ` +
        `${proxyAddress} recommended.`
    );
  }

  const upgradedLog = logs[logs.length - 1];
  const txHash = upgradedLog.transactionHash;
  const blockNumber = upgradedLog.blockNumber;

  // Full receipt so step 7's `Upgraded` check sees every log of the tx.
  const txReceipt = await ethers.provider.getTransactionReceipt(txHash);
  if (!txReceipt) {
    // Mined, but this RPC node has not indexed the receipt yet.
    logger.warning(
      `  Recovered Upgraded event for tx ${txHash} but no receipt yet; ` +
        `using log-only data.`
    );
    return {
      hash: txHash,
      blockNumber,
      logs: [
        {
          address: upgradedLog.address,
          topics: [...upgradedLog.topics],
          data: upgradedLog.data,
        },
      ],
    };
  }

  logger.success(
    `  Recovered Transparent upgrade tx ${txHash} from log scan ` +
      `(block ${blockNumber}; ProxyAdmin.upgrade not surfaced by upgrades.upgradeProxy)`
  );

  return {
    hash: txHash,
    blockNumber,
    logs: txReceipt.logs.map((l) => ({
      address: l.address,
      topics: [...l.topics],
      data: l.data,
    })),
  };
}

// ============================================================================
// Etherscan verification (new implementation only)
// ============================================================================

async function verifyImplementation(
  proxyAddress: string,
  contractName: string,
  networkName: string
): Promise<void> {
  if (process.env.SKIP_VERIFY === "true") {
    logger.info(`  Skipping Etherscan verification (SKIP_VERIFY=true)`);
    return;
  }
  if (!VERIFIABLE_NETWORKS.includes(networkName)) {
    logger.info(`  Skipping verification (${networkName} not in VERIFIABLE_NETWORKS)`);
    return;
  }
  if (!process.env.ETHERSCAN_API_KEY) {
    logger.warning(`  Skipping verification (ETHERSCAN_API_KEY not set)`);
    return;
  }

  // Etherscan can take a couple of blocks to index the new impl bytecode.
  logger.info(`  Waiting 30s for Etherscan to index new implementation...`);
  await sleep(30_000);

  try {
    const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
    logger.info(`  Verifying impl at ${implAddress}...`);
    await run("verify:verify", { address: implAddress, constructorArguments: [] });
    logger.success(`  ${contractName} implementation verified`);
  } catch (err: any) {
    const msg = err?.message || String(err);
    if (/already verified/i.test(msg)) {
      logger.info(`  ${contractName} impl already verified`);
      return;
    }
    logger.warning(`  Verification failed (non-fatal): ${msg}`);
  }
}

// ============================================================================
// Permission management
// ============================================================================

/**
 * Confirm the signer can call _authorizeUpgrade. On a fork a missing role is
 * auto-granted from DEFAULT_ADMIN; on live networks it aborts, so grants stay
 * an explicit out-of-band step.
 */
async function ensureUpgraderRole(
  contract: Contract,
  upgraderRole: string,
  signerAddress: string,
  isFork: boolean
): Promise<void> {
  const has = await contract.hasRole(upgraderRole, signerAddress);
  if (has) {
    logger.success(`  Signer holds ${getRoleName(upgraderRole)}`);
    return;
  }

  const roleName = getRoleName(upgraderRole);
  if (!isFork) {
    throw new Error(
      `Signer ${signerAddress} does not hold ${roleName} on ${await contract.getAddress()}. ` +
        `Grant the role from a current admin before re-running this script.`
    );
  }

  logger.warning(
    `  Signer lacks ${roleName} on fork — attempting auto-grant from DEFAULT_ADMIN`
  );

  const adminRole = ROLES.DEFAULT_ADMIN_ROLE;
  const signerIsAdmin = await contract.hasRole(adminRole, signerAddress);
  if (!signerIsAdmin) {
    throw new Error(
      `Signer ${signerAddress} holds neither ${roleName} nor DEFAULT_ADMIN_ROLE on ` +
        `${await contract.getAddress()}. Cannot auto-recover on fork; abort.`
    );
  }

  await withRetry(`grant ${roleName} on fork`, async () => {
    const tx = await contract.grantRole(upgraderRole, signerAddress);
    const receipt = await tx.wait();
    logger.success(`  Granted ${roleName} (block ${receipt.blockNumber})`);
  });
}

// ============================================================================
// Per-target upgrade
// ============================================================================

interface UpgradeOutcome {
  name: string;
  proxy: string;
  oldImpl: string;
  newImpl: string;
  txHash: string;
}

async function upgradeOne(
  name: string,
  signer: Signer,
  signerAddress: string,
  bookKey: string,
  isFork: boolean,
  networkName: string
): Promise<UpgradeOutcome> {
  const target = UPGRADE_TARGETS[name];
  if (!target) {
    throw new Error(
      `Unknown upgrade target "${name}". Known targets: ${Object.keys(UPGRADE_TARGETS).join(", ")}`
    );
  }

  logger.section(`Upgrading ${name}`);

  // 1. Resolve proxy address: per-target env override -> address book.
  const envOverride = process.env[`PROXY_${name}`];
  let proxyAddress: string;
  if (envOverride) {
    proxyAddress = envOverride;
    logger.info(`  Proxy address (from PROXY_${name}): ${proxyAddress}`);
  } else {
    if (!hasAddress(bookKey, name)) {
      throw new Error(
        `No address found for ${name} under book key "${bookKey}". ` +
          `Either set PROXY_${name}=0x... or run the deploy script first.`
      );
    }
    proxyAddress = loadAddress(bookKey, name);
    logger.info(`  Proxy address (from address book): ${proxyAddress}`);
  }

  // 2. Sanity-check there's a contract at that address.
  const code = await ethers.provider.getCode(proxyAddress);
  if (!code || code === "0x") {
    throw new Error(
      `No bytecode at ${proxyAddress} on ${networkName}. ` +
        `Wrong network, or proxy was self-destructed?`
    );
  }

  // 3. Attach factory and snapshot pre-upgrade state.
  const Factory = await ethers.getContractFactory(target.factory, signer);
  const contract = Factory.attach(proxyAddress).connect(signer) as Contract;

  const reader = STATE_READERS[target.stateKey ?? target.factory];
  if (!reader) {
    throw new Error(
      `No state reader registered for "${target.stateKey ?? target.factory}". ` +
        `Add one to scripts/upgrade/preState.ts.`
    );
  }

  logger.info(`  Reading pre-upgrade state...`);
  const beforeState = await reader(contract);

  // 4. Permission check (auto-grant on fork only).
  await ensureUpgraderRole(contract, target.upgraderRole, signerAddress, isFork);

  // 5. Read pre-upgrade implementation address.
  const oldImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  logger.info(`  Old implementation: ${oldImpl}`);

  // 5b. Bytecode-equality short-circuit: an unchanged impl would only cost gas
  //     and audit noise. Recorded with the `<bytecode-unchanged>` sentinel.
  //     Runs before, not instead of, OZ's prepareUpgrade, which also enforces
  //     storage-layout compatibility.
  const skipBytecodeCheck = process.env.SKIP_BYTECODE_CHECK === "true";
  if (!skipBytecodeCheck && (await isImplementationBytecodeUnchanged(target.factory, oldImpl))) {
    logger.success(
      `  ${name}: local runtime bytecode matches on-chain impl ${oldImpl} ` +
        `(metadata-stripped) — skipping upgrade.`
    );

    // Snapshot post-state so the diff printer has a comparison row.
    const afterState = await reader(contract);
    printStateTable(beforeState, afterState);

    const skipOutcome: UpgradeOutcome = {
      name,
      proxy: proxyAddress,
      oldImpl,
      newImpl: oldImpl,
      txHash: "<bytecode-unchanged>",
    };
    if (isFork) {
      logger.info(
        `  Fork rehearsal: not appending audit record to addresses.json ` +
          `(local-only run; live key "${bookKey}" left untouched).`
      );
    } else {
      const skipRecord: UpgradeRecord = {
        contract: name,
        proxy: skipOutcome.proxy,
        oldImpl: skipOutcome.oldImpl,
        newImpl: skipOutcome.newImpl,
        txHash: skipOutcome.txHash,
        timestamp: new Date().toISOString(),
        deployer: signerAddress,
      };
      appendUpgradeRecord(bookKey, skipRecord);
      logger.info(`  Recorded skip in addresses.json under upgrades.${bookKey}`);
    }
    return skipOutcome;
  }
  if (skipBytecodeCheck) {
    logger.warning(`  SKIP_BYTECODE_CHECK=true — forcing upgrade even if bytecode matches`);
  }

  // 6. Broadcast the upgrade.
  //    UUPS: `prepareUpgrade` (OZ storage-layout validation + impl deploy;
  //    idempotent, no `unsafeAllow`) then `upgradeToAndCall(newImpl, "0x")`
  //    called directly so we own the tx receipt. Empty calldata: a migration
  //    needing a reinitializer should add a `migrationCalldata` target field.
  //    Transparent: single-phase `upgrades.upgradeProxy`; the upgrade tx is
  //    `ProxyAdmin.upgrade`, and the proxy still emits `Upgraded` for step 7.
  const proxyKind: ProxyKind = target.proxyKind ?? "uups";
  let newImpl: string = "";
  let receipt: any;

  // A missing OZ manifest entry (deploy from another machine or a non-OZ tool)
  // fails the first prepareUpgrade with "is not registered"; `forceImport`
  // registers the proxy + impl locally. It sends no tx and is idempotent.
  async function forceImportIfMissing(): Promise<boolean> {
    try {
      logger.warning(
        `  ${name}: OZ manifest is missing an entry for this proxy/impl. ` +
          `Attempting forceImport to register it...`
      );
      await upgrades.forceImport(proxyAddress, Factory, { kind: proxyKind });
      logger.success(`  forceImport succeeded; manifest now contains ${proxyAddress}.`);
      return true;
    } catch (err: any) {
      logger.error(
        `  forceImport failed for ${name}: ${err.message ?? err}. ` +
          `Manual remediation: copy .openzeppelin/<chain>.json from a machine ` +
          `that has the manifest entry for ${proxyAddress}, or re-run this ` +
          `upgrade from that machine.`
      );
      return false;
    }
  }

  function isNotRegisteredError(err: any): boolean {
    const msg = (err?.message ?? String(err)).toString();
    return /is not registered/i.test(msg) && /forceImport/i.test(msg);
  }

  if (proxyKind === "uups") {
    await withRetry(`prepareUpgrade(${name})`, async () => {
      let prepared;
      try {
        prepared = await upgrades.prepareUpgrade(proxyAddress, Factory);
      } catch (err: any) {
        if (isNotRegisteredError(err) && (await forceImportIfMissing())) {
          prepared = await upgrades.prepareUpgrade(proxyAddress, Factory);
        } else {
          throw err;
        }
      }
      // prepareUpgrade returns an address or a deploy tx response; accept both.
      if (typeof prepared === "string") {
        newImpl = prepared;
      } else {
        // prepareUpgrade does not move the proxy slot; read the receipt instead.
        const txRecv = await prepared.wait();
        newImpl = txRecv?.contractAddress ?? "";
        if (!newImpl) {
          throw new Error(
            `prepareUpgrade returned a transaction but no contractAddress; ` +
              `cannot proceed with upgradeToAndCall.`
          );
        }
      }
      logger.info(`  New implementation deployed at: ${newImpl}`);
    });

    // A prior partial run may already have pointed the proxy at the new impl.
    if (oldImpl.toLowerCase() === newImpl.toLowerCase()) {
      logger.warning(
        `  Proxy already points at the new implementation ` +
          `— skipping upgradeToAndCall (resumed prior partial run, or bytecode unchanged).`
      );
      receipt = { hash: "<already-upgraded>", blockNumber: 0 };
    } else {
      await withRetry(`upgradeToAndCall(${name})`, async () => {
        // Cast: the typed factory view does not surface the UUPSUpgradeable hook.
        const tx = await (contract as any).upgradeToAndCall(newImpl, "0x");
        receipt = await tx.wait();
        logger.success(`  Upgrade tx ${tx.hash} mined in block ${receipt.blockNumber}`);
      });
    }
  } else {
    // Transparent proxy path. The new impl is read from the ERC1967 slot after
    // the call. Snapshot the height first to bound the log-scan fallback used
    // when `deploymentTransaction()` comes back null.
    const preUpgradeBlock = await ethers.provider.getBlockNumber();

    await withRetry(`upgradeProxy(${name})`, async () => {
      // `kind` must be explicit: OZ infers "uups" from an impl that inherits
      // UUPSUpgradeable, then aborts on a Transparent proxy.
      let upgraded;
      try {
        upgraded = await upgrades.upgradeProxy(proxyAddress, Factory, {
          kind: "transparent",
        });
      } catch (err: any) {
        if (isNotRegisteredError(err) && (await forceImportIfMissing())) {
          upgraded = await upgrades.upgradeProxy(proxyAddress, Factory, {
            kind: "transparent",
          });
        } else {
          throw err;
        }
      }
      const txResp = (upgraded as any).deploymentTransaction?.() ?? null;
      if (txResp) {
        receipt = await txResp.wait();
        logger.success(
          `  Upgrade tx ${txResp.hash ?? receipt?.hash} mined in block ${receipt.blockNumber}`
        );
      } else {
        // Fallback: recover the real tx hash from the Upgraded event.
        receipt = await recoverTransparentUpgradeReceipt(
          proxyAddress,
          preUpgradeBlock
        );
      }
      newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
      logger.info(`  New implementation: ${newImpl}`);
    });

    // `oldImpl === newImpl` is a legitimate no-op here (Upgraded still fires).
  }

  // 7. Confirm the implementation slot moved, tolerating RPC propagation delay:
  //    (a) authoritative: the `Upgraded(address)` event in the receipt's own logs;
  //    (b) poll `getImplementationAddress` for ~30s; if it lags after (a)
  //        passed, warn and trust the receipt.

  const expectedImplLc = newImpl.toLowerCase();
  let observedImpl = newImpl;

  // Sentinels meaning there are no receipt logs to check (`<already-upgraded>`,
  // `<no-upgrade-event-found>`); only the slot poll (b) applies.
  const noReceiptSentinel =
    receipt.hash === "<already-upgraded>" ||
    receipt.hash === "<no-upgrade-event-found>";

  if (!noReceiptSentinel) {
    // (a) Scan the receipt for the Upgraded event.
    const upgradedLog = (receipt.logs ?? []).find(
      (l: any) =>
        l.address?.toLowerCase() === proxyAddress.toLowerCase() &&
        l.topics?.[0]?.toLowerCase() === UPGRADED_TOPIC_HEX
    );
    if (!upgradedLog) {
      throw new Error(
        `Upgrade tx ${receipt.hash} did not emit Upgraded(address) from the proxy. ` +
          `The tx likely failed or was sent to the wrong address.`
      );
    }
    const loggedImpl = "0x" + upgradedLog.topics[1].slice(-40);
    if (loggedImpl.toLowerCase() !== expectedImplLc) {
      throw new Error(
        `Upgraded event reports impl ${loggedImpl} but we expected ${newImpl}. ` +
          `Something else broadcast a competing upgrade in the same block.`
      );
    }
    logger.success(`  Upgraded event confirms new impl ${loggedImpl}`);
  }

  // (b) Poll the post-upgrade slot.
  const pollMaxMs = 30_000;
  const pollIntervalMs = 2_000;
  const pollStart = Date.now();
  let slotConfirmed = false;
  while (Date.now() - pollStart < pollMaxMs) {
    try {
      observedImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
      if (observedImpl.toLowerCase() === expectedImplLc) {
        slotConfirmed = true;
        break;
      }
    } catch (err: any) {
      // Transient — keep polling within budget.
      logger.warning(`  Slot read errored (${err.message?.slice(0, 80)}); retrying...`);
    }
    await sleep(pollIntervalMs);
  }
  if (!slotConfirmed) {
    if (noReceiptSentinel) {
      // No event to corroborate the upgrade, so a slot miss is a real mismatch.
      throw new Error(
        `Proxy slot reads as ${observedImpl} but expected ${newImpl} ` +
          `(no upgrade tx broadcast or no Upgraded event recovered).`
      );
    }
    logger.warning(
      `  Slot read still shows ${observedImpl} after ${pollMaxMs / 1000}s; ` +
        `Upgraded event already confirmed the upgrade — trusting on-chain truth and proceeding.`
    );
    observedImpl = newImpl;
  }
  logger.info(`  New implementation: ${observedImpl}`);
  newImpl = observedImpl;

  // 8. Snapshot post-upgrade state and assert invariants.
  logger.info(`  Reading post-upgrade state...`);
  const afterState = await reader(contract);
  const diffs = diffSnapshots(beforeState, afterState);
  printStateTable(beforeState, afterState);
  if (diffs.length > 0) {
    logger.error(`  Storage invariants broken on ${name}:`);
    for (const d of diffs) {
      logger.error(`    ${d.field}: ${d.before} -> ${d.after}`);
    }
    throw new Error(
      `Post-upgrade state diff for ${name} is non-empty. ` +
        `OZ plugin's storage-layout check should have caught this — investigate before proceeding.`
    );
  }
  logger.success(`  All state invariants preserved`);

  // 9. Etherscan verification (live networks only — the helper short-circuits on forks).
  if (!isFork) {
    await verifyImplementation(proxyAddress, name, networkName);
  }

  const outcome: UpgradeOutcome = {
    name,
    proxy: proxyAddress,
    oldImpl,
    newImpl,
    txHash: receipt?.hash ?? "<unknown>",
  };

  // 10. Append the audit record now so a later target failure keeps it. Skipped
  //     on forks: they share the live bookKey but their hashes are throwaway.
  if (isFork) {
    logger.info(
      `  Fork rehearsal: not appending audit record to addresses.json ` +
        `(local-only run; live key "${bookKey}" left untouched).`
    );
  } else {
    const record: UpgradeRecord = {
      contract: name,
      proxy: outcome.proxy,
      oldImpl: outcome.oldImpl,
      newImpl: outcome.newImpl,
      txHash: outcome.txHash,
      timestamp: new Date().toISOString(),
      deployer: signerAddress,
    };
    appendUpgradeRecord(bookKey, record);
    logger.success(`  Recorded upgrade in addresses.json under upgrades.${bookKey}`);
  }

  return outcome;
}

// ============================================================================
// State pretty-printing
// ============================================================================

function printStateTable(before: StateSnapshot, after: StateSnapshot): void {
  const rows: Record<string, { before: string; after: string; ok: string }> = {};
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const f of fields) {
    const b = before[f] ?? "<missing>";
    const a = after[f] ?? "<missing>";
    rows[f] = { before: b, after: a, ok: b === a ? "✓" : "✗" };
  }
  console.table(rows);
}

// ============================================================================
// Targets parsing
// ============================================================================

function parseTargets(): string[] {
  const raw = (process.env.TARGETS || "").trim();
  if (!raw) {
    throw new Error(
      `TARGETS env var not set. Specify one or more contracts to upgrade, e.g. ` +
        `TARGETS=LitePSM,OkuDollar. Known targets: ${Object.keys(UPGRADE_TARGETS).join(", ")}.`
    );
  }
  const list = Array.from(
    new Set(
      raw
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    )
  );
  const unknown = list.filter((n) => !UPGRADE_TARGETS[n]);
  if (unknown.length > 0) {
    throw new Error(
      `Unknown TARGETS entries: ${unknown.join(", ")}. ` +
        `Known: ${Object.keys(UPGRADE_TARGETS).join(", ")}.`
    );
  }
  return list;
}

// ============================================================================
// Main
// ============================================================================

// ---- Mainnet safety gate ----
const UPGRADE_DRY_RUN = process.env.DRY_RUN === "true" || process.env.DRY_RUN === "1";
const UPGRADE_YES_MAINNET =
  process.argv.includes("--yes-mainnet") ||
  process.env.YES_MAINNET === "1" ||
  process.env.YES_MAINNET === "true";
function assertNotMainnetUpgrade(networkName: string) {
  if (!isMainnetNetwork(networkName)) return;
  if (UPGRADE_YES_MAINNET) {
    logger.warning(`YES_MAINNET set; proceeding with upgrade on ${networkName}`);
    return;
  }
  if (UPGRADE_DRY_RUN) return;
  // Env form only: `hardhat run` rejects unknown CLI flags (HH305).
  throw new Error(
    `Refusing to broadcast upgrade on ${networkName} without YES_MAINNET.\n` +
    `Re-run with: YES_MAINNET=true TARGETS=... npx hardhat run scripts/upgrade/index.ts --network ${networkName}`
  );
}
// ---- end mainnet safety gate ----

async function main() {
  const ctx = await resolveNetworkContext();
  const { networkName, isFork, chainConfig } = ctx;
  if (!isFork) assertNotMainnetUpgrade(networkName);

  // Always the LIVE key, even on a fork: rehearsals upgrade the real proxies
  // mirrored into the fork, not the `fork:<chain>` deploy namespace.
  const bookKey = networkName;

  const targets = parseTargets();

  logger.header(
    `OkuMoney Upgrade on ${chainConfig.name}${isFork ? " (LOCAL FORK)" : ""}`
  );
  logger.info(`Network: ${networkName} (chainId: ${chainConfig.chainId})`);
  logger.info(`Address book key: ${bookKey}${isFork ? " (live key reused on fork)" : ""}`);
  logger.info(`Targets: ${targets.join(", ")}`);

  // Resolve signer the same way the deploy script does.
  let signer: Signer;
  if (isFork) {
    logger.info(`Impersonating dev wallet: ${DEV_WALLET_ADDRESS}`);
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [DEV_WALLET_ADDRESS],
    });
    const bal = await ethers.provider.getBalance(DEV_WALLET_ADDRESS);
    if (bal < ethers.parseEther("0.1")) {
      logger.info(`  Dev wallet balance low (${ethers.formatEther(bal)} ETH); topping up`);
      const [funder] = await ethers.getSigners();
      const fundTx = await funder.sendTransaction({
        to: DEV_WALLET_ADDRESS,
        value: ethers.parseEther("1"),
      });
      await fundTx.wait();
    }
    signer = await ethers.getSigner(DEV_WALLET_ADDRESS);
  } else {
    const signers = await ethers.getSigners();
    if (signers.length === 0) {
      throw new Error(
        `No signers configured for network ${networkName}. ` +
          `Set PRIVATE_KEY in .env (must hold the upgrader roles on the live deployment).`
      );
    }
    signer = signers[0];
  }
  const signerAddress = await signer.getAddress();
  logger.info(`Signer: ${signerAddress}`);
  logger.info(
    `Balance: ${ethers.formatEther(await ethers.provider.getBalance(signerAddress))} ETH`
  );

  if (!isFork && signerAddress.toLowerCase() !== DEV_WALLET_ADDRESS.toLowerCase()) {
    logger.warning(
      `Live signer ${signerAddress} differs from the recorded dev wallet ` +
        `${DEV_WALLET_ADDRESS}. Make sure the signer holds the required upgrader roles.`
    );
  }

  // Sequential, fail-fast; earlier targets have already written their audit records.
  const outcomes: UpgradeOutcome[] = [];
  for (const name of targets) {
    const outcome = await upgradeOne(
      name,
      signer,
      signerAddress,
      bookKey,
      isFork,
      networkName
    );
    outcomes.push(outcome);
  }

  // Summary
  logger.header("Upgrade Complete");
  console.log();
  console.log(`Upgraded contracts (book key: ${bookKey}):`);
  for (const o of outcomes) {
    console.log(`  ${o.name}`);
    console.log(`    proxy:   ${o.proxy}`);
    console.log(`    oldImpl: ${o.oldImpl}`);
    console.log(`    newImpl: ${o.newImpl}`);
    console.log(`    txHash:  ${o.txHash}`);
  }
  console.log();
  logger.info(`Audit trail: scripts/config/addresses.json -> upgrades.${bookKey}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Upgrade failed: ${err.message || err}`);
    console.error(err);
    process.exit(1);
  });
