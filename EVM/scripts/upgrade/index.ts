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
 * v1 supports `LitePSM` and `OkuDollar`. Future targets are added by extending
 * the UPGRADE_TARGETS table and adding a matching state reader in ./preState.ts.
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

import { ethers, network, upgrades, run } from "hardhat";
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

// ============================================================================
// Upgrade target registry
// ============================================================================
//
// Each entry pins three things:
//   - factory:       hardhat contract name (matches src/*.sol and getContractFactory()).
//   - upgraderRole:  bytes32 role hash that gates _authorizeUpgrade on that contract.
//   - stateKey:      key into STATE_READERS for pre/post snapshot. Falls back to
//                    `factory` when omitted.
//
// Extending: add a row here and a reader in preState.ts. The main loop is
// target-agnostic, so no other code needs to change.

interface UpgradeTarget {
  factory: string;
  upgraderRole: string;
  stateKey?: string;
}

const UPGRADE_TARGETS: Record<string, UpgradeTarget> = {
  LitePSM:   { factory: "LitePSM",   upgraderRole: ROLES.PSM_UPGRADER },
  OkuDollar: { factory: "OkuDollar", upgraderRole: ROLES.VAULT_UPGRADER },
};

// Networks where Etherscan-family verification is supported.
// Mirrors deploy/index.ts so the post-upgrade verify call respects the same
// allowlist.
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

// ============================================================================
// Transient-error Retry Helpers (cloned from deploy/index.ts)
// ============================================================================
//
// Live broadcasts hit the same RPC quirks the deploy script handles: stale
// nonces, "already known", BSC pending-tx response shape, transient timeouts.
// We share the patterns rather than importing because deploy/index.ts isn't a
// module — its helpers are scoped to `main()`. Lifting them into a shared util
// is a separate cleanup; for now we copy the small subset we need.

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

  // On a freshly-restarted fork, ROLES.DEFAULT_ADMIN_ROLE is held by whoever
  // originally called `initialize`. For OkuMoney's role-grant policy that is
  // also the dev wallet, so the same impersonated signer should be able to
  // self-grant. We still go through grantRole to keep this path generic in
  // case the admin diverges from the signer.
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

  // 6. Two-phase upgrade so we can capture a real tx hash for the audit trail.
  //
  //    Phase A (`prepareUpgrade`): OZ plugin validates the new implementation
  //    against the storage layout recorded in `.openzeppelin/<chain>.json` and
  //    deploys it. Bails out before broadcasting the actual upgrade tx on any
  //    layout-incompatible change. No `unsafeAllow` flags are passed.
  //    Idempotent: if a matching impl was deployed in a prior (partial) run,
  //    OZ returns the same address — no double-deploy.
  //
  //    Phase B (`upgradeToAndCall`): we call the UUPS hook directly so we own
  //    the resulting tx receipt (the plugin's upgradeProxy wraps these into one
  //    call that surfaces only the impl-deploy tx, which isn't useful here).
  //    Empty calldata: no re-initialization needed for the mintUsdOku fix or
  //    any state-preserving patch. Future migrations that need to call a
  //    reinitializer should extend the dispatch table with a `migrationCalldata`
  //    field rather than hard-coding it here.
  let newImpl: string = "";
  let receipt: any;
  await withRetry(`prepareUpgrade(${name})`, async () => {
    const prepared = await upgrades.prepareUpgrade(proxyAddress, Factory);
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

  // 7. Confirm the implementation slot moved.
  //
  //    Two-pronged check that tolerates RPC propagation delay (which has bitten
  //    us on public Base RPCs: the upgrade tx mines, but a follow-up read on a
  //    different load-balanced node returns the *pre-upgrade* slot value
  //    momentarily). The order is:
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

  if (receipt.hash !== "<already-upgraded>") {
    // (a) Authoritative: scan the receipt for the Upgraded event.
    //     Topic0 = keccak256("Upgraded(address)").
    const UPGRADED_TOPIC =
      "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";
    const upgradedLog = (receipt.logs ?? []).find(
      (l: any) =>
        l.address?.toLowerCase() === proxyAddress.toLowerCase() &&
        l.topics?.[0]?.toLowerCase() === UPGRADED_TOPIC
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
    if (receipt.hash === "<already-upgraded>") {
      // No event to fall back on — this is a real mismatch.
      throw new Error(
        `Proxy slot reads as ${observedImpl} but expected ${newImpl} (no upgrade tx broadcast).`
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
  //     doesn't lose this one's history).
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

async function main() {
  const ctx = await resolveNetworkContext();
  const { networkName, isFork, chainConfig } = ctx;

  // Upgrade scripts always target the LIVE address-book key, even on a fork.
  // Rationale: a fork rehearsal upgrades the *real* deployed proxies (whose
  // bytecode is mirrored into the fork from live state). The deploy script's
  // `fork:<chain>` namespace exists to keep throwaway fork deployments from
  // overwriting live entries — but there are no fork-only proxies to upgrade,
  // so we deliberately ignore that namespace here.
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
    // Fund the impersonated account if it's low on ETH (real on-chain balance
    // is mirrored from the fork, but a fresh node may need a top-up). 1 ETH
    // is plenty for several upgrades worth of gas.
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
