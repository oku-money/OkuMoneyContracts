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
// Each entry pins four things:
//   - factory:       hardhat contract name (matches src/*.sol and getContractFactory()).
//   - upgraderRole:  bytes32 role hash gating _authorizeUpgrade on that
//                    contract. For Transparent proxies the upgrade is actually
//                    gated by the ProxyAdmin owner; the contract-level role is
//                    still recorded so the pre-flight check can warn on it.
//   - proxyKind:     "uups" (default) or "transparent". Drives which OZ helper
//                    broadcasts the upgrade. Must match the
//                    `.openzeppelin/<chain>.json` manifest; a mismatch aborts
//                    during prepareUpgrade/upgradeProxy.
//   - stateKey:      key into STATE_READERS for pre/post snapshot. Falls back to
//                    `factory` when omitted.
//
// Extending: add a row here and a reader in preState.ts. The main loop is
// target-agnostic.

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
  RedemptionQueue: { factory: "RedemptionQueue", upgraderRole: ROLES.QUEUE_UPGRADER },
  LitePSM:         { factory: "LitePSM",         upgraderRole: ROLES.PSM_UPGRADER },
};

// Networks where Etherscan-family verification is supported.
// Mirrors deploy/index.ts so the post-upgrade verify call respects the same
// allowlist.
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
// Live broadcasts hit the same RPC quirks the deploy script handles: stale
// nonces, "already known", BSC pending-tx response shape, transient timeouts.
// Duplicated from deploy/index.ts rather than imported because that file's
// helpers are scoped to `main()`.

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
// Avoid paying for a fresh implementation deploy + upgrade tx when the local
// source compiles to the same runtime bytecode that's already at the proxy's
// current implementation slot — the common case when re-running after a
// config-only or comment-only change.
//
// Two normalizations have to happen for a fair comparison:
//
//   1. Metadata stripping. Solidity appends a CBOR-encoded metadata footer to
//      runtime bytecode containing an IPFS hash of the source + compiler
//      version, so comments, file paths, or a solc patch bump change the hash
//      even with identical compiled output. Footer format:
//      `a2 64 69 70 66 73 ...` (CBOR map of 2 entries: "ipfs" -> 0x12 0x20
//      0x<32-byte hash>, "solc" -> 3 bytes version) plus a 2-byte length
//      suffix `0033` (~51 bytes typical). Regex anchored on $ so the strip is
//      unambiguous.
//
//   2. Immutables zeroing. OZ's UUPSUpgradeable stores `address(this)` of the
//      impl as an `immutable`, so each deployed impl has its OWN address
//      inlined at the same offset while the local artifact's
//      `deployedBytecode` has zeros there — raw equality always fails for
//      UUPS impls. Solidity emits the exact byte ranges of all immutables in
//      the build-info's `immutableReferences` map (per-contract,
//      per-immutable-id, list of `{start, length}`); we zero those ranges on
//      the on-chain side too before comparing.
//
// If neither normalization says "definitely unchanged" we fall through to OZ's
// `prepareUpgrade`, which has its own manifest-backed duplicate detection, so
// the worst case is one extra round-trip rather than a real redeploy.
//
// Do NOT "simplify" this by setting `solc.metadata.bytecodeHash = "none"` in
// hardhat.config.ts: that is a one-way door — every contract would diff against
// its current on-chain bytecode on the first run after the flip.

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
// `upgrades.upgradeProxy(proxy, Factory, { kind: "transparent" })` in
// hardhat-upgrades + ethers v6 returns a Contract handle whose
// `deploymentTransaction()` is OFTEN null for Transparent proxies — it
// re-attaches to the proxy address rather than wrapping the
// ProxyAdmin.upgrade() tx. The upgrade tx DID land on chain; it just isn't
// reachable through the returned handle.
//
// This helper scans the proxy's logs since `fromBlock` for the most recent
// `Upgraded(address)` event and reconstructs a receipt-shape object:
//   - .hash: real tx hash from chain
//   - .blockNumber: block the upgrade tx was mined in
//   - .logs: the proxy's log array for that tx (includes the Upgraded log,
//            which the step-7 event check then validates)
//
// `fromBlock` must be the height captured BEFORE calling `upgradeProxy`, so a
// prior upgrade in the same run is never picked up. On miss, returns a
// synthetic "<no-upgrade-event-found>" hash, which callers treat as a no-op
// (slot didn't move); step 7 catches the contradiction if the slot DID move.

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
  // Look from one block before the snapshot to be safe against fork-node
  // off-by-one in the block-number read; the upgrade tx cannot be older
  // than fromBlock by construction (we read it right before the call).
  const safeFrom = Math.max(0, fromBlock - 1);
  const latest = await ethers.provider.getBlockNumber();

  // Scan in 10-block steps because some hosted-RPC tiers reject `eth_getLogs`
  // with ranges wider than 10 blocks. Worst case 100 blocks (~5 min on most
  // chains) before giving up.
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
      // If the RPC rejects even a 10-block window something is off (network
      // down, wrong endpoint) — propagate with a clear message.
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

  // ethers returns logs in chronological order, so the last entry in the
  // window is the one we just caused. Multiple hits mean a concurrent admin
  // upgrade; trust the last one and warn.
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

  // Fetch the full tx receipt so step-7's `Upgraded` event check sees all logs
  // from the tx, matching what UUPS receipts surface.
  const txReceipt = await ethers.provider.getTransactionReceipt(txHash);
  if (!txReceipt) {
    // Race: tx hash exists in logs (mined) but the receipt is not yet indexed
    // by this RPC node. Surface clearly rather than crash.
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
 * Confirm the signer can call _authorizeUpgrade. On a fork, missing roles are
 * auto-granted from the impersonated DEFAULT_ADMIN — convenient for rehearsals
 * after a chain redeploy where the local fork's role state may differ. On live
 * networks, missing roles abort the script: the operator must coordinate the
 * grant out-of-band rather than have the script do it implicitly.
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

  // On a freshly-restarted fork, DEFAULT_ADMIN_ROLE is held by whoever called
  // `initialize` — for OkuMoney's policy that is also the dev wallet, so the
  // impersonated signer can self-grant. Still routed through grantRole to stay
  // generic if the admin diverges from the signer.
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

  // 5b. Bytecode-equality short-circuit.
  //
  //     If the locally-compiled runtime bytecode (sans Solidity metadata
  //     footer) matches what's already at `oldImpl`, the upgrade is a no-op
  //     that still costs gas and adds noise to the audit trail. We record an
  //     audit entry with the `<bytecode-unchanged>` sentinel and skip the rest
  //     of the per-target flow.
  //
  //     Layered on TOP of the OZ plugin's prepareUpgrade idempotency, not a
  //     replacement: prepareUpgrade also blocks layout-incompatible changes,
  //     which a bytecode-equality skip would not catch. This check just runs
  //     first, sparing the network round-trips when there is nothing to do.
  const skipBytecodeCheck = process.env.SKIP_BYTECODE_CHECK === "true";
  if (!skipBytecodeCheck && (await isImplementationBytecodeUnchanged(target.factory, oldImpl))) {
    logger.success(
      `  ${name}: local runtime bytecode matches on-chain impl ${oldImpl} ` +
        `(metadata-stripped) — skipping upgrade.`
    );

    // Still snapshot post-state so the diff printer has a comparison row.
    // For a true no-op upgrade, before == after by construction.
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

  // 6. Broadcast the upgrade. The flow differs by proxy kind:
  //
  //    UUPS (default):
  //      Two-phase so we can capture a real tx hash for the audit trail.
  //
  //      Phase A (`prepareUpgrade`): OZ plugin validates the new implementation
  //      against the storage layout recorded in `.openzeppelin/<chain>.json` and
  //      deploys it. Bails out before broadcasting the actual upgrade tx on any
  //      layout-incompatible change. No `unsafeAllow` flags are passed.
  //      Idempotent: if a matching impl was deployed in a prior (partial) run,
  //      OZ returns the same address — no double-deploy.
  //
  //      Phase B (`upgradeToAndCall`): we call the UUPS hook directly so we own
  //      the resulting tx receipt (the plugin's upgradeProxy wraps these into one
  //      call that surfaces only the impl-deploy tx, which isn't useful here).
  //      Empty calldata: no re-initialization is needed for a state-preserving
  //      patch. A migration that must call a reinitializer should extend the
  //      dispatch table with a `migrationCalldata` field rather than
  //      hard-coding it here.
  //
  //    Transparent:
  //      Single-phase via `upgrades.upgradeProxy`. The plugin still does the
  //      storage-layout validation + impl deploy, then calls
  //      `ProxyAdmin.upgrade(proxy, newImpl)` on our behalf. The proxy's
  //      ERC1967 Upgraded event fires from the proxy address (same topic), so
  //      the downstream event check in step 7 works identically.
  //
  //      The UUPS two-phase pattern is unusable here: a Transparent proxy
  //      exposes no `upgradeToAndCall` selector to the signer. So the audit
  //      record's "upgrade tx hash" is the ProxyAdmin.upgrade tx.
  const proxyKind: ProxyKind = target.proxyKind ?? "uups";
  let newImpl: string = "";
  let receipt: any;

  // If OZ's manifest is missing an entry for this proxy or its current impl
  // (a previous deploy on a different machine, or via a non-OZ tool), the
  // first `prepareUpgrade` / `upgradeProxy` call fails with "Deployment at
  // address ... is not registered". Recover by registering the existing
  // proxy + impl into the local manifest via `upgrades.forceImport`.
  //
  // Safety: forceImport only writes `.openzeppelin/<chain>.json` — it
  // broadcasts no tx and modifies no on-chain state, and repeated calls are
  // no-ops, so it is safe to invoke speculatively in a recovery path.
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
      // prepareUpgrade returns either an address string (new impl deployed) or a
      // ContractTransactionResponse (deploying). We tolerate both shapes — the
      // address is what we want for upgradeToAndCall regardless.
      if (typeof prepared === "string") {
        newImpl = prepared;
      } else {
        // ContractTransactionResponse path: wait for deploy and read the address
        // from the resulting receipt.
        const txRecv = await prepared.wait();
        // Best-effort: re-read the ERC-1967 slot. prepareUpgrade only deploys an
        // implementation — it does NOT change the proxy's slot — so we look at
        // the contractAddress of the receipt instead.
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

    // Resumability: if a prior partial run already pointed the proxy at the new
    // impl (e.g. tx mined but a post-check failed), don't re-broadcast.
    if (oldImpl.toLowerCase() === newImpl.toLowerCase()) {
      logger.warning(
        `  Proxy already points at the new implementation ` +
          `— skipping upgradeToAndCall (resumed prior partial run, or bytecode unchanged).`
      );
      receipt = { hash: "<already-upgraded>", blockNumber: 0 };
    } else {
      await withRetry(`upgradeToAndCall(${name})`, async () => {
        // Cast: hardhat factory's typed view doesn't surface the UUPSUpgradeable
        // hook because the proxy at this address is the UUPS proxy bytecode, not
        // the implementation. The ABI we attached above (target.factory) does
        // include upgradeToAndCall via the OZ UUPSUpgradeable parent, so the call
        // resolves correctly at runtime.
        const tx = await (contract as any).upgradeToAndCall(newImpl, "0x");
        receipt = await tx.wait();
        logger.success(`  Upgrade tx ${tx.hash} mined in block ${receipt.blockNumber}`);
      });
    }
  } else {
    // Transparent proxy path.
    //
    // `upgrades.upgradeProxy` returns the upgraded contract instance, whose
    // `deploymentTransaction()` (ethers v6) on the *returned proxy* refers
    // to the ProxyAdmin.upgrade() tx (NOT the impl deploy). We rely on that
    // for the audit-record tx hash. The new impl address is read from the
    // ERC1967 slot after the call returns — the plugin guarantees the slot
    // is updated before the call resolves.
    // Snapshot the block height BEFORE the upgrade call so the post-call log
    // scan has a tight lower bound, for when `deploymentTransaction()` comes
    // back null (an ethers-v6 + hardhat-upgrades quirk for Transparent
    // proxies).
    const preUpgradeBlock = await ethers.provider.getBlockNumber();

    await withRetry(`upgradeProxy(${name})`, async () => {
      // Pass `kind: "transparent"` explicitly. Without it OZ infers the kind
      // from the implementation's source, and any impl inheriting
      // UUPSUpgradeable carries an _authorizeUpgrade hook even when the
      // deployed proxy is Transparent — OZ then aborts with "Requested an
      // upgrade of kind uups but proxy is transparent". The impl's
      // _authorizeUpgrade is dead code for Transparent proxies and harmless.
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
      // ethers v6: deploymentTransaction() is OFTEN null for Transparent
      // proxies even when the ProxyAdmin tx really was broadcast, because the
      // helper returns a re-attached Contract handle rather than a
      // fresh-deployed one. Hence the chain-state fallback below.
      const txResp = (upgraded as any).deploymentTransaction?.() ?? null;
      if (txResp) {
        receipt = await txResp.wait();
        logger.success(
          `  Upgrade tx ${txResp.hash ?? receipt?.hash} mined in block ${receipt.blockNumber}`
        );
      } else {
        // Fallback: recover the upgrade tx hash by scanning for the proxy's
        // most recent Upgraded(address) event since `preUpgradeBlock`, so the
        // audit record carries the real on-chain hash rather than a sentinel.
        receipt = await recoverTransparentUpgradeReceipt(
          proxyAddress,
          preUpgradeBlock
        );
      }
      // Re-read the ERC1967 slot regardless of whether a tx was broadcast —
      // either way the slot value is what gets recorded.
      newImpl = await upgrades.erc1967.getImplementationAddress(proxyAddress);
      logger.info(`  New implementation: ${newImpl}`);
    });

    // A Transparent upgrade where `oldImpl === newImpl` is a legitimate
    // no-op: OZ's manifest deduplicator returns the same impl when the
    // bytecode is unchanged, ProxyAdmin.upgrade() still fires
    // Upgraded(sameImpl), and step 7's checks both pass. No guard needed.
  }

  // 7. Confirm the implementation slot moved.
  //
  //    Two-pronged check that tolerates RPC propagation delay: the upgrade tx
  //    mines, but a follow-up read on a different load-balanced node can
  //    momentarily return the *pre-upgrade* slot value. The order is:
  //
  //      a) Authoritative: parse the ERC-1967 `Upgraded(address)` event from
  //         the receipt's own logs. If the event reports the expected impl,
  //         the upgrade succeeded — the receipt and the logs are guaranteed to
  //         agree on the same block, regardless of which RPC node served them.
  //
  //      b) Sanity: poll `getImplementationAddress` for up to ~30s. Most RPCs
  //         catch up well within that window; we just want to surface the new
  //         impl to the rest of the script (and to the audit-trail record).
  //         If polling fails after the budget, we trust (a) and emit a warning
  //         rather than abort — the on-chain truth is already in the receipt.

  const expectedImplLc = newImpl.toLowerCase();
  let observedImpl = newImpl;

  // Sentinels that mean "no receipt logs to scan": either the script
  // detected an in-place no-op (`<already-upgraded>`) or the Transparent
  // recovery helper found no Upgraded event in its window
  // (`<no-upgrade-event-found>`). Either way step (a) below has nothing
  // to assert; step (b)'s slot poll still runs as the safety net.
  const noReceiptSentinel =
    receipt.hash === "<already-upgraded>" ||
    receipt.hash === "<no-upgrade-event-found>";

  if (!noReceiptSentinel) {
    // (a) Authoritative: scan the receipt for the Upgraded event.
    //     Topic0 = keccak256("Upgraded(address)"), shared with the
    //     Transparent-recovery helper above.
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

  // (b) Sanity poll: try a few times to read the post-upgrade slot.
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
      // No Upgraded event was scanned (in-place no-op or recovery miss).
      // A slot-poll miss in this branch is a real mismatch with no event to
      // corroborate the upgrade.
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

  // 10. Append audit-trail record (before returning so a later target failure
  //     doesn't lose this one's history). Suppressed on local forks: fork
  //     rehearsals share the live network's bookKey (see main()) but their
  //     impl/tx hashes are throwaway local-node values — writing them into
  //     addresses.json would pollute the live audit trail.
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
  // Use console.table for a compact view; downstream CI logs render it cleanly.
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

// ---- Mainnet safety gate (WS5.3) ----
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
  // Must be the ENV form: `hardhat run` rejects unknown CLI flags (HH305)
  // before this script ever executes, so `--yes-mainnet` can never arrive.
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

  // Upgrade scripts always target the LIVE address-book key, even on a fork: a
  // fork rehearsal upgrades the *real* deployed proxies, mirrored into the fork
  // from live state. The deploy script's `fork:<chain>` namespace is
  // deliberately ignored here — there are no fork-only proxies to upgrade.
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
    // Top up the impersonated account if low on ETH. 1 ETH covers several
    // upgrades' worth of gas.
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

  // Execute upgrades sequentially. Fail-fast: a failure on target N halts the
  // run, but every target that succeeded before it has already written its
  // audit record, so partial progress is recoverable.
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
