/**
 * Upgrade OkuMoney EVM UUPS proxies to the freshly compiled source in ./src.
 *
 * MODES (env MODE, default "direct")
 *
 *   direct   The signer holds each target's upgrader role (testnets, where the
 *            deployer keeps the roles). Deploys the new implementation and calls
 *            `upgradeToAndCall` itself.
 *
 *   propose  The upgrader role sits with a multisig (mainnet: the Cold Safe,
 *            UPGRADE_SAFE=0x...). Deploys the new implementations from any
 *            funded signer (deploying needs no role), runs every check, and
 *            writes a proposal under `upgrade-proposals/<bookKey>/`:
 *              <stamp>.json       — what to verify afterwards (pre-state, impls)
 *              <stamp>.safe.json  — Safe Transaction Builder batch to import
 *            Nothing is upgraded until the Safe executes the batch.
 *
 *   verify   After the Safe executed: PROPOSAL=<path to <stamp>.json>. Confirms
 *            each proxy points at the proposed implementation, diffs state
 *            across the upgrade block, checks invariants, then writes the
 *            audit record and the new layout baseline.
 *
 *   DRY_RUN=1 (any mode but verify): every check, no transaction. Does NOT
 *   deploy implementations, so it is safe on mainnet without YES_MAINNET.
 *
 * CHECKS, all before any upgrade transaction (fail closed):
 *   1. Local runtime code == current implementation  ->  nothing to do (no record).
 *   2. Storage layout vs the recorded BASELINE of the deployed implementation
 *      (scripts/utils/upgradeBaseline.ts), bound to its runtime code hash.
 *   3. Storage layout + unsafe patterns vs the OpenZeppelin manifest
 *      (`.openzeppelin/<chain>.json`). A proxy missing from the manifest is an
 *      ERROR: the script never `forceImport`s, because importing current source
 *      as the deployed layout makes check 3 compare the new layout with itself.
 *   4. The new implementation is initializer-locked and `proxiableUUID()` is
 *      the ERC-1967 slot; and it is NOT the current implementation (the plugin
 *      resolving to the old address while the bytecode differs means the
 *      manifest records the wrong layout).
 * After the upgrade: Upgraded event, slot read, block-pinned state diff with
 * event-explained changes only (preState.ts), and cross-contract invariants.
 *
 * ENV
 *   TARGETS=LitePSM,OkuDollar  (required; OkuMoney, OkuDollar, LitePSM)
 *   MODE=direct|propose|verify, UPGRADE_SAFE=0x..., PROPOSAL=path
 *   DRY_RUN=1, YES_MAINNET=1 (required to broadcast on mainnet networks)
 *   PROXY_<Name>=0x...   override the address-book proxy (debugging)
 *   SKIP_VERIFY=1        skip explorer verification of the new implementation
 *   SKIP_BYTECODE_CHECK=1  upgrade even if the runtime code is unchanged
 *   LOG_CHUNK=2000       eth_getLogs block-range chunk for event scans
 *   PRIVATE_KEY, ETHERSCAN_API_KEY (Etherscan V2: one key for every chain)
 *
 * FORK REHEARSAL (`--network localhost` against `FORK_NETWORK=<chain> npm run node`)
 *   Uses the LIVE book key and the real proxies mirrored into the fork. If the
 *   default signer lacks the upgrader role, the script impersonates an address
 *   that holds it: UPGRADE_SAFE, then holders from the role ledger
 *   (roleGrants.json), then falls back to auto-granting from DEV_WALLET if it is
 *   still admin. Nothing is recorded for a fork run against a live key.
 *
 * Usage:
 *   TARGETS=LitePSM npx hardhat run scripts/upgrade/index.ts --network sepolia
 *   MODE=propose UPGRADE_SAFE=0x... TARGETS=OkuMoney YES_MAINNET=1 \
 *     npx hardhat run scripts/upgrade/index.ts --network base
 *   MODE=verify PROPOSAL=upgrade-proposals/base/20261008T120000Z.json \
 *     npx hardhat run scripts/upgrade/index.ts --network base
 */

import fs from "fs";
import path from "path";
import hre, { ethers, network, upgrades, run } from "hardhat";
import { Contract, ContractFactory, Signer } from "ethers";
import {
  loadAddress,
  hasAddress,
  appendUpgradeRecord,
  isForkKey,
  UpgradeRecord,
} from "../utils/addressBook";
import { DEV_WALLET_ADDRESS } from "../config/chains";
import { resolveNetworkContext } from "../utils/networkContext";
import { ROLES, getRoleName } from "../config/roles";
import { logger } from "../utils/logger";
import { isMainnetNetwork } from "../utils/mainnetGuard";
import { isDryRun, isYesMainnet } from "../utils/cli";
import { loadRoleGrants, deriveLedgerHolders } from "../utils/roleRegistry";
import {
  assertCompatibleWithBaseline,
  recordBaseline,
  runtimeCodeHash,
  gitCommit,
} from "../utils/upgradeBaseline";
import {
  STATE_READERS,
  StateSnapshot,
  SnapshotContext,
  diffSnapshots,
  flatten,
  unflatten,
  checkInvariants,
  FieldDiff,
} from "./preState";
import { runtimeMatches, assertImplementationSafe } from "./lib/bytecode";
import { buildSafeBatch, SafeTx } from "./lib/safe";

// ============================================================================
// Targets
// ============================================================================

interface UpgradeTarget {
  /** Hardhat contract name compiled from ./src. */
  factory: string;
  /** Role gating `_authorizeUpgrade`. */
  upgraderRole: string;
}

export const UPGRADE_TARGETS: Record<string, UpgradeTarget> = {
  OkuMoney: { factory: "OkuMoney", upgraderRole: ROLES.OKUM_UPGRADER },
  OkuDollar: { factory: "OkuDollar", upgraderRole: ROLES.VAULT_UPGRADER },
  LitePSM: { factory: "LitePSM", upgraderRole: ROLES.PSM_UPGRADER },
};

/** Upgrade order: OkuDollar and LitePSM call into OkuMoney, so it goes first. */
const ORDER = ["OkuMoney", "OkuDollar", "LitePSM"];

export type UpgradeMode = "direct" | "propose" | "verify";

export interface TargetSpec {
  name: string;
  /** Factory override (tests only — e.g. a V2 mock). Defaults to the table's. */
  factory?: string;
}

export interface RunUpgradeOptions {
  targets?: TargetSpec[];
  mode?: UpgradeMode;
  dryRun?: boolean;
  /** Address-book key. Defaults to the live chain key (also on a fork). */
  bookKey?: string;
  /** Signer for deploys and (direct mode) upgrades. */
  signer?: Signer;
  /** Multisig holding the upgrader roles (propose mode; fork impersonation). */
  safe?: string;
  /** Proposal file to verify (verify mode). */
  proposalPath?: string;
  /** Directory proposals are written to. Defaults to EVM/upgrade-proposals. */
  proposalDir?: string;
}

export interface UpgradeOutcome {
  name: string;
  proxy: string;
  oldImpl: string;
  newImpl: string;
  /** Tx hash, or a sentinel: <bytecode-unchanged>, <dry-run>, <proposed>. */
  txHash: string;
}

export interface UpgradeResult {
  outcomes: UpgradeOutcome[];
  proposalPath?: string;
  safeBatchPath?: string;
}

interface ProposalTarget {
  name: string;
  factory: string;
  proxy: string;
  oldImpl: string;
  newImpl: string;
  newImplCodeHash: string;
  preBlock: number;
  preState: Record<string, string>;
}

interface ProposalFile {
  kind: "okumoney-evm-upgrade-proposal";
  chainId: string;
  network: string;
  bookKey: string;
  safe: string;
  createdAt: string;
  gitCommit?: string;
  targets: ProposalTarget[];
  safeBatch: string;
}

const UPGRADED_TOPIC = ethers.id("Upgraded(address)");
const DEFAULT_PROPOSAL_DIR = path.join(__dirname, "../../upgrade-proposals");

// ============================================================================
// Small helpers
// ============================================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

const TRANSIENT = [
  /nonce too (low|high)/i, /replacement transaction underpriced/i, /already known/i,
  /transaction underpriced/i, /could not coalesce error/i, /timeout/i, /ETIMEDOUT/i,
  /ECONNRESET/i, /ENOTFOUND/i, /Unable to complete request/i, /service unavailable/i,
  /\b50[234]\b/, /rate limit/i, /too many requests/i,
];

async function withRetry<T>(what: string, fn: () => Promise<T>, retries = 5): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      if (attempt >= retries || !TRANSIENT.some((re) => re.test(msg))) throw err;
      const delay = 2000 * 2 ** attempt;
      logger.warning(`  ${what}: transient "${msg.slice(0, 100)}" — retry in ${delay}ms`);
      await sleep(delay);
    }
  }
}

function isNotRegistered(err: any): boolean {
  return /is not registered/i.test(String(err?.message ?? err));
}

function manifestMissingError(name: string, proxy: string, err: any): Error {
  return new Error(
    `${name}: proxy ${proxy} (or its current implementation) is not in the OpenZeppelin ` +
      `manifest (.openzeppelin/<chain>.json). Restore the manifest from git or from the ` +
      `machine that deployed it. This script will NOT forceImport: importing the current ` +
      `source would record the NEW layout as the deployed one and disable the storage ` +
      `check. (${String(err?.message ?? err).split("\n")[0]})`
  );
}

function resolveProxy(name: string, bookKey: string): string {
  const override = process.env[`PROXY_${name}`];
  if (override) return override;
  if (!hasAddress(bookKey, name)) {
    throw new Error(`No ${name} under book key "${bookKey}" (set PROXY_${name}=0x... to override)`);
  }
  return loadAddress(bookKey, name);
}

/** Event names a contract emitted in (fromBlock, toBlock]. */
async function emittedEvents(
  address: string,
  iface: ContractFactory["interface"],
  fromBlockExclusive: number,
  toBlock: number
): Promise<Set<string>> {
  const names = new Set<string>();
  const chunk = Number(process.env.LOG_CHUNK ?? 2000);
  for (let from = fromBlockExclusive + 1; from <= toBlock; from += chunk) {
    const to = Math.min(from + chunk - 1, toBlock);
    const logs = await withRetry("getLogs", () =>
      ethers.provider.getLogs({ address, fromBlock: from, toBlock: to })
    );
    for (const l of logs) {
      try {
        const parsed = iface.parseLog({ topics: [...l.topics], data: l.data });
        if (parsed) names.add(parsed.name);
      } catch {
        names.add(`<unparsed:${l.topics[0]}>`);
      }
    }
  }
  return names;
}

/** Addresses whose role holdings are pinned across the upgrade. */
function roleHolders(bookKey: string, extra: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of ["OkuMoney", "OkuDollar", "LitePSM"]) {
    if (hasAddress(bookKey, n)) out[n] = loadAddress(bookKey, n);
  }
  for (const [k, v] of Object.entries(extra)) if (v && ethers.isAddress(v)) out[k] = v;
  for (const env of ["MAINNET_COLD_MULTISIG", "MAINNET_WARM_MULTISIG", "MAINNET_ORCHESTRATOR"]) {
    const v = process.env[env];
    if (v && ethers.isAddress(v)) out[env] = v;
  }
  // Every address the role ledger has ever granted to on this chain.
  const ledgerChain = bookKey;
  let i = 0;
  for (const [key, holders] of deriveLedgerHolders(loadRoleGrants())) {
    if (!key.startsWith(`${ledgerChain}|`)) continue;
    for (const h of holders) {
      if (!Object.values(out).some((a) => eq(a, h))) out[`ledger${i++}`] = h;
    }
  }
  return out;
}

function liveContracts(bookKey: string, signer: Signer): InvariantContracts {
  const out: InvariantContracts = {};
  for (const n of ["OkuMoney", "OkuDollar", "LitePSM"] as const) {
    if (!hasAddress(bookKey, n) && !process.env[`PROXY_${n}`]) continue;
    out[n] = new ethers.Contract(
      resolveProxy(n, bookKey),
      hre.artifacts.readArtifactSync(n).abi,
      signer
    );
  }
  return out;
}
type InvariantContracts = { OkuMoney?: Contract; OkuDollar?: Contract; LitePSM?: Contract };

function printDiffs(name: string, diffs: FieldDiff[]): string[] {
  const failures: string[] = [];
  for (const d of diffs) {
    if (d.explainedBy) {
      logger.warning(`  ${name}.${d.field}: ${d.before} -> ${d.after} (explained by ${d.explainedBy})`);
    } else {
      logger.error(`  ${name}.${d.field}: ${d.before} -> ${d.after} (UNEXPLAINED)`);
      failures.push(`${name}.${d.field}: ${d.before} -> ${d.after}`);
    }
  }
  return failures;
}

async function verifyOnExplorer(impl: string, name: string, networkName: string, isFork: boolean) {
  if (isFork || ["hardhat", "localhost"].includes(networkName)) return;
  if (process.env.SKIP_VERIFY === "1" || process.env.SKIP_VERIFY === "true") {
    logger.info(`  Explorer verification skipped (SKIP_VERIFY)`);
    return;
  }
  // hardhat-verify reads the top-level `etherscan.apiKey` (Etherscan V2: one
  // key covers every supported chain).
  if (!process.env.ETHERSCAN_API_KEY) {
    logger.warning(`  Explorer verification skipped (ETHERSCAN_API_KEY not set)`);
    return;
  }
  logger.info(`  Waiting 30s for the explorer to index ${impl}...`);
  await sleep(30_000);
  try {
    await run("verify:verify", { address: impl, constructorArguments: [] });
    logger.success(`  ${name} implementation verified`);
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (/already verified/i.test(msg)) logger.info(`  ${name} implementation already verified`);
    else logger.warning(`  Explorer verification failed (non-fatal; re-run verify.ts): ${msg}`);
  }
}

// ============================================================================
// Signer for the upgrade call
// ============================================================================

/**
 * The signer that will call `upgradeToAndCall`. Live: must already hold the
 * role. Fork: impersonate a real holder (UPGRADE_SAFE, then ledger holders),
 * else auto-grant from the default signer if it is admin.
 */
async function upgradeSigner(
  contract: Contract,
  role: string,
  base: Signer,
  isFork: boolean,
  candidates: string[]
): Promise<Signer> {
  const baseAddr = await base.getAddress();
  if (await contract.hasRole(role, baseAddr)) return base;
  const roleName = getRoleName(role);
  const target = await contract.getAddress();
  if (!isFork) {
    throw new Error(
      `Signer ${baseAddr} does not hold ${roleName} on ${target}. If a multisig holds it, ` +
        `use MODE=propose UPGRADE_SAFE=<safe>.`
    );
  }
  for (const c of candidates) {
    if (!(await contract.hasRole(role, c))) continue;
    logger.info(`  Fork: impersonating ${roleName} holder ${c}`);
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [c] });
    await network.provider.request({ method: "hardhat_setBalance", params: [c, "0x56BC75E2D63100000"] });
    return ethers.getSigner(c);
  }
  if (await contract.hasRole(ROLES.DEFAULT_ADMIN_ROLE, baseAddr)) {
    logger.warning(`  Fork: granting ${roleName} to ${baseAddr} from DEFAULT_ADMIN_ROLE`);
    await (await (contract.connect(base) as Contract).grantRole(role, baseAddr)).wait();
    return base;
  }
  throw new Error(`Fork: no candidate holds ${roleName} on ${target} and ${baseAddr} is not admin`);
}

// ============================================================================
// Pre-broadcast checks (shared by direct, propose and dry-run)
// ============================================================================

interface Prepared {
  name: string;
  factoryName: string;
  Factory: ContractFactory;
  proxy: string;
  contract: Contract;
  oldImpl: string;
  unchanged: boolean;
}

async function preflight(
  spec: TargetSpec,
  bookKey: string,
  signer: Signer
): Promise<Prepared> {
  const target = UPGRADE_TARGETS[spec.name];
  const factoryName = spec.factory ?? target.factory;
  logger.section(`${spec.name}${factoryName !== spec.name ? ` (factory ${factoryName})` : ""}`);

  const proxy = resolveProxy(spec.name, bookKey);
  const code = await ethers.provider.getCode(proxy);
  if (!code || code === "0x") throw new Error(`No code at ${spec.name} proxy ${proxy}`);
  logger.info(`  Proxy: ${proxy}`);

  const Factory = await ethers.getContractFactory(factoryName, signer);
  const contract = Factory.attach(proxy).connect(signer) as Contract;
  const oldImpl = await upgrades.erc1967.getImplementationAddress(proxy);
  logger.info(`  Current implementation: ${oldImpl}`);

  const skipCheck = ["1", "true"].includes(process.env.SKIP_BYTECODE_CHECK ?? "");
  if (!skipCheck && (await runtimeMatches(factoryName, oldImpl))) {
    logger.success(`  Runtime code unchanged — nothing to upgrade`);
    return { name: spec.name, factoryName, Factory, proxy, contract, oldImpl, unchanged: true };
  }

  // Check 2: baseline (independent of the manifest).
  await assertCompatibleWithBaseline({
    bookKey,
    contract: spec.name,
    proxy,
    oldImpl,
    newFactory: Factory,
  });
  logger.success(`  Layout compatible with the recorded baseline`);

  // Check 3: the OZ manifest + unsafe-pattern validation. Never forceImport.
  try {
    await upgrades.validateUpgrade(proxy, Factory, { kind: "uups" });
  } catch (err: any) {
    if (isNotRegistered(err)) throw manifestMissingError(spec.name, proxy, err);
    throw err;
  }
  logger.success(`  OpenZeppelin manifest validation passed`);

  return { name: spec.name, factoryName, Factory, proxy, contract, oldImpl, unchanged: false };
}

/** Deploy (or reuse) the implementation and run check 4. */
async function deployImplementation(p: Prepared): Promise<string> {
  let newImpl = "";
  await withRetry(`prepareUpgrade(${p.name})`, async () => {
    let prepared: any;
    try {
      prepared = await upgrades.prepareUpgrade(p.proxy, p.Factory, { kind: "uups" });
    } catch (err: any) {
      if (isNotRegistered(err)) throw manifestMissingError(p.name, p.proxy, err);
      throw err;
    }
    if (typeof prepared === "string") newImpl = prepared;
    else newImpl = (await prepared.wait())?.contractAddress ?? "";
    if (!newImpl) throw new Error(`prepareUpgrade(${p.name}) returned no implementation address`);
  });
  if (eq(newImpl, p.oldImpl)) {
    throw new Error(
      `${p.name}: the plugin resolved the new implementation to the CURRENT one (${newImpl}) ` +
        `although the runtime code differs. The manifest attributes this source's layout to ` +
        `the deployed implementation — it is wrong. Restore .openzeppelin/<chain>.json from git.`
    );
  }
  await assertImplementationSafe(newImpl);
  if (!(await runtimeMatches(p.factoryName, newImpl))) {
    throw new Error(`${p.name}: code at ${newImpl} is not the locally compiled ${p.factoryName}`);
  }
  logger.success(`  New implementation ${newImpl} (initializer-locked, UUPS)`);
  return newImpl;
}

// ============================================================================
// Post-upgrade verification (shared by direct and verify)
// ============================================================================

async function verifyUpgraded(args: {
  name: string;
  Factory: ContractFactory;
  contract: Contract;
  proxy: string;
  newImpl: string;
  preBlock: number;
  pre: StateSnapshot;
  upgradeBlock: number;
  bookKey: string;
  signer: Signer;
  ctxBase: Omit<SnapshotContext, "blockTag">;
}): Promise<{ post: StateSnapshot; anomalies: string[] }> {
  const slot = await upgrades.erc1967.getImplementationAddress(args.proxy);
  if (!eq(slot, args.newImpl)) {
    throw new Error(`${args.name}: proxy points at ${slot}, expected ${args.newImpl}`);
  }
  const post = await STATE_READERS[args.name](args.contract, {
    ...args.ctxBase,
    blockTag: args.upgradeBlock,
  });
  const emitted = await emittedEvents(args.proxy, args.Factory.interface, args.preBlock, args.upgradeBlock);
  const anomalies = printDiffs(args.name, diffSnapshots(args.pre, post, emitted));

  const block = await ethers.provider.getBlock(args.upgradeBlock);
  const broken = await checkInvariants({
    blockTag: args.upgradeBlock,
    timestamp: BigInt(block!.timestamp),
    contracts: liveContracts(args.bookKey, args.signer),
  });
  for (const b of broken) logger.error(`  INVARIANT: ${b}`);
  anomalies.push(...broken);
  if (anomalies.length === 0) logger.success(`  State preserved; invariants hold`);
  return { post, anomalies };
}

/** Find the Upgraded(newImpl) log on `proxy` at or after `fromBlock`. */
async function findUpgradeTx(proxy: string, newImpl: string, fromBlock: number) {
  const latest = await ethers.provider.getBlockNumber();
  const chunk = Number(process.env.LOG_CHUNK ?? 2000);
  const implTopic = ethers.zeroPadValue(newImpl, 32);
  for (let from = fromBlock; from <= latest; from += chunk) {
    const to = Math.min(from + chunk - 1, latest);
    const logs = await withRetry("getLogs", () =>
      ethers.provider.getLogs({ address: proxy, topics: [UPGRADED_TOPIC, implTopic], fromBlock: from, toBlock: to })
    );
    if (logs.length > 0) return logs[logs.length - 1];
  }
  return null;
}

// ============================================================================
// Main
// ============================================================================

function parseTargets(): TargetSpec[] {
  const raw = (process.env.TARGETS ?? "").trim();
  if (!raw) {
    throw new Error(`TARGETS not set (e.g. TARGETS=LitePSM,OkuDollar). Known: ${ORDER.join(", ")}`);
  }
  const names = Array.from(new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)));
  const unknown = names.filter((n) => !UPGRADE_TARGETS[n]);
  if (unknown.length) throw new Error(`Unknown TARGETS: ${unknown.join(", ")}. Known: ${ORDER.join(", ")}`);
  return names.map((name) => ({ name }));
}

function parseMode(): UpgradeMode {
  const m = (process.env.MODE ?? "direct").trim();
  if (m !== "direct" && m !== "propose" && m !== "verify") {
    throw new Error(`MODE must be direct, propose or verify (got "${m}")`);
  }
  return m;
}

/** Entry point for all three modes; see the module header. */
export async function runUpgrade(opts: RunUpgradeOptions = {}): Promise<UpgradeResult> {
  const ctx = await resolveNetworkContext();
  const { networkName, isFork, chainConfig } = ctx;
  const mode = opts.mode ?? parseMode();
  const dryRun = opts.dryRun ?? isDryRun();
  const bookKey = opts.bookKey ?? networkName;
  // A fork rehearsal against a live key must not touch tracked records.
  const record = !isFork || isForkKey(bookKey);
  const chainId = (await ethers.provider.getNetwork()).chainId;

  if (mode === "verify" && dryRun) throw new Error("DRY_RUN does not apply to MODE=verify (it sends nothing)");
  // DRY_RUN sends nothing, so it needs no mainnet opt-in. Everything else does.
  if (!isFork && !dryRun && mode !== "verify" && isMainnetNetwork(networkName) && !isYesMainnet()) {
    throw new Error(
      `Refusing to deploy/upgrade on ${networkName} without YES_MAINNET=1 ` +
        `(DRY_RUN=1 runs every check without sending anything).`
    );
  }

  logger.header(`OkuMoney upgrade — ${chainConfig.name}${isFork ? " (FORK)" : ""} — ${mode}${dryRun ? " (DRY RUN)" : ""}`);
  logger.info(`Book key: ${bookKey}${record ? "" : " (fork rehearsal: nothing recorded)"}`);

  let signer: Signer;
  if (opts.signer) signer = opts.signer;
  else if (isFork) {
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [DEV_WALLET_ADDRESS] });
    await network.provider.request({ method: "hardhat_setBalance", params: [DEV_WALLET_ADDRESS, "0x56BC75E2D63100000"] });
    signer = await ethers.getSigner(DEV_WALLET_ADDRESS);
  } else {
    const signers = await ethers.getSigners();
    if (!signers.length) throw new Error(`No signer for ${networkName}: set PRIVATE_KEY`);
    signer = signers[0];
  }
  const signerAddress = await signer.getAddress();
  logger.info(`Signer: ${signerAddress}`);

  const safe = opts.safe ?? process.env.UPGRADE_SAFE;
  if (safe && !ethers.isAddress(safe)) throw new Error(`UPGRADE_SAFE is not an address: ${safe}`);

  if (mode === "verify") {
    return verifyProposal(opts.proposalPath ?? process.env.PROPOSAL, bookKey, record, chainId, signer);
  }

  const specs = (opts.targets ?? parseTargets()).sort(
    (a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name)
  );
  if (mode === "propose" && !safe) throw new Error("MODE=propose requires UPGRADE_SAFE=<multisig address>");

  const ctxBase = { roleHolders: roleHolders(bookKey, { signer: signerAddress, safe }) };
  const outcomes: UpgradeOutcome[] = [];
  const proposalTargets: ProposalTarget[] = [];
  const safeTxs: SafeTx[] = [];

  for (const spec of specs) {
    const p = await preflight(spec, bookKey, signer);
    const base = { name: p.name, proxy: p.proxy, oldImpl: p.oldImpl, newImpl: p.oldImpl };
    if (p.unchanged) {
      outcomes.push({ ...base, txHash: "<bytecode-unchanged>" });
      continue;
    }

    const role = UPGRADE_TARGETS[p.name].upgraderRole;
    if (mode === "propose" && !(await p.contract.hasRole(role, safe!))) {
      throw new Error(`UPGRADE_SAFE ${safe} does not hold ${getRoleName(role)} on ${p.name}`);
    }
    if (dryRun) {
      if (mode === "direct" && !isFork && !(await p.contract.hasRole(role, signerAddress))) {
        logger.warning(`  Signer lacks ${getRoleName(role)}: a real run would need MODE=propose`);
      }
      logger.success(`  DRY RUN: all pre-broadcast checks passed; nothing deployed or sent`);
      outcomes.push({ ...base, txHash: "<dry-run>" });
      continue;
    }

    const newImpl = await deployImplementation(p);

    if (mode === "propose") {
      const preBlock = await ethers.provider.getBlockNumber();
      const pre = await STATE_READERS[p.name](p.contract, { ...ctxBase, blockTag: preBlock });
      proposalTargets.push({
        name: p.name,
        factory: p.factoryName,
        proxy: p.proxy,
        oldImpl: p.oldImpl,
        newImpl,
        newImplCodeHash: await runtimeCodeHash(newImpl),
        preBlock,
        preState: flatten(pre),
      });
      safeTxs.push({
        to: p.proxy,
        value: "0",
        data: p.Factory.interface.encodeFunctionData("upgradeToAndCall", [newImpl, "0x"]),
      });
      await verifyOnExplorer(newImpl, p.name, networkName, isFork);
      outcomes.push({ ...base, newImpl, txHash: "<proposed>" });
      continue;
    }

    // ---- direct ----
    const upSigner = await upgradeSigner(p.contract, role, signer, isFork, [safe, ...Object.values(ctxBase.roleHolders)].filter(Boolean) as string[]);
    const preBlock = await ethers.provider.getBlockNumber();
    const pre = await STATE_READERS[p.name](p.contract, { ...ctxBase, blockTag: preBlock });
    const receipt = await withRetry(`upgradeToAndCall(${p.name})`, async () => {
      const tx = await (p.contract.connect(upSigner) as Contract).upgradeToAndCall(newImpl, "0x");
      return tx.wait();
    });
    const upgradedLog = receipt.logs.find(
      (l: any) => eq(l.address, p.proxy) && l.topics[0] === UPGRADED_TOPIC
    );
    if (!upgradedLog || !eq("0x" + upgradedLog.topics[1].slice(-40), newImpl)) {
      throw new Error(`${p.name}: upgrade tx ${receipt.hash} has no Upgraded(${newImpl}) event`);
    }
    logger.success(`  Upgraded in tx ${receipt.hash} (block ${receipt.blockNumber})`);

    const { post, anomalies } = await verifyUpgraded({
      name: p.name, Factory: p.Factory, contract: p.contract, proxy: p.proxy, newImpl,
      preBlock, pre, upgradeBlock: receipt.blockNumber, bookKey, signer, ctxBase,
    });

    if (record) {
      appendUpgradeRecord(bookKey, {
        contract: p.name, proxy: p.proxy, oldImpl: p.oldImpl, newImpl, txHash: receipt.hash,
        timestamp: new Date().toISOString(), deployer: await upSigner.getAddress(),
        chainId: Number(chainId), blockNumber: receipt.blockNumber,
        newImplCodeHash: await runtimeCodeHash(newImpl), gitCommit: gitCommit(), mode: "direct",
        preState: flatten(pre), postState: flatten(post),
      } satisfies UpgradeRecord);
      await recordBaseline({
        bookKey, contract: p.name, factoryName: p.factoryName, factory: p.Factory,
        proxy: p.proxy, impl: newImpl, recordedBy: "upgrade",
      });
      logger.success(`  Recorded upgrade + layout baseline`);
    }
    await verifyOnExplorer(newImpl, p.name, networkName, isFork);
    if (anomalies.length) {
      throw new Error(`${p.name} upgraded (recorded) but post-upgrade checks failed:\n  ${anomalies.join("\n  ")}`);
    }
    outcomes.push({ ...base, newImpl, txHash: receipt.hash });
  }

  const result: UpgradeResult = { outcomes };
  if (mode === "propose" && proposalTargets.length > 0) {
    Object.assign(result, writeProposal(opts.proposalDir ?? DEFAULT_PROPOSAL_DIR, {
      bookKey, isFork, chainId, networkName, safe: safe!, targets: proposalTargets, txs: safeTxs,
    }));
  }

  logger.header("Summary");
  for (const o of outcomes) logger.info(`  ${o.name}: ${o.oldImpl} -> ${o.newImpl} [${o.txHash}]`);
  if (result.proposalPath) {
    logger.info(`  Proposal:   ${result.proposalPath}`);
    logger.info(`  Safe batch: ${result.safeBatchPath}  (Safe UI -> Transaction Builder -> import)`);
    logger.info(`  After execution: MODE=verify PROPOSAL=${result.proposalPath} npx hardhat run scripts/upgrade/index.ts --network ${networkName}`);
  }
  return result;
}

function writeProposal(
  dir: string,
  a: {
    bookKey: string; isFork: boolean; chainId: bigint; networkName: string; safe: string;
    targets: ProposalTarget[]; txs: SafeTx[];
  }
): { proposalPath: string; safeBatchPath: string } {
  // Fork runs never land in the tracked per-chain directories.
  const sub = a.isFork && !isForkKey(a.bookKey) ? `fork-${a.bookKey}` : a.bookKey.replace(":", "-");
  const outDir = path.join(dir, sub);
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const proposalPath = path.join(outDir, `${stamp}.json`);
  const safeBatchPath = path.join(outDir, `${stamp}.safe.json`);
  const batch = buildSafeBatch({
    chainId: a.chainId,
    safe: a.safe,
    name: `OkuMoney upgrade ${a.targets.map((t) => t.name).join(", ")}`,
    description: a.targets.map((t) => `${t.name} ${t.proxy}: ${t.oldImpl} -> ${t.newImpl}`).join("; "),
    txs: a.txs,
  });
  const proposal: ProposalFile = {
    kind: "okumoney-evm-upgrade-proposal",
    chainId: a.chainId.toString(),
    network: a.networkName,
    bookKey: a.bookKey,
    safe: a.safe,
    createdAt: new Date().toISOString(),
    gitCommit: gitCommit(),
    targets: a.targets,
    safeBatch: path.basename(safeBatchPath),
  };
  fs.writeFileSync(safeBatchPath, JSON.stringify(batch, null, 2) + "\n");
  fs.writeFileSync(proposalPath, JSON.stringify(proposal, null, 2) + "\n");
  return { proposalPath, safeBatchPath };
}

async function verifyProposal(
  proposalPath: string | undefined,
  bookKey: string,
  record: boolean,
  chainId: bigint,
  signer: Signer
): Promise<UpgradeResult> {
  if (!proposalPath) throw new Error("MODE=verify requires PROPOSAL=<path to proposal .json>");
  const proposal: ProposalFile = JSON.parse(fs.readFileSync(proposalPath, "utf8"));
  if (proposal.kind !== "okumoney-evm-upgrade-proposal") throw new Error(`${proposalPath} is not an upgrade proposal`);
  if (proposal.chainId !== chainId.toString()) {
    throw new Error(`Proposal is for chainId ${proposal.chainId}, connected to ${chainId}`);
  }
  if (proposal.bookKey !== bookKey) throw new Error(`Proposal is for book key ${proposal.bookKey}, not ${bookKey}`);

  const ctxBase = { roleHolders: roleHolders(bookKey, { signer: await signer.getAddress(), safe: proposal.safe }) };
  const outcomes: UpgradeOutcome[] = [];
  const failures: string[] = [];
  for (const t of proposal.targets) {
    logger.section(`Verify ${t.name}`);
    const Factory = await ethers.getContractFactory(t.factory, signer);
    const contract = Factory.attach(t.proxy).connect(signer) as Contract;
    const slot = await upgrades.erc1967.getImplementationAddress(t.proxy);
    if (eq(slot, t.oldImpl)) throw new Error(`${t.name}: not executed yet (proxy still at ${t.oldImpl})`);
    if ((await runtimeCodeHash(t.newImpl)) !== t.newImplCodeHash) {
      throw new Error(`${t.name}: code at ${t.newImpl} changed since the proposal`);
    }
    const log = await findUpgradeTx(t.proxy, t.newImpl, t.preBlock);
    if (!log) throw new Error(`${t.name}: no Upgraded(${t.newImpl}) event on ${t.proxy} since block ${t.preBlock}`);
    const tx = await ethers.provider.getTransaction(log.transactionHash);
    logger.success(`  Executed in tx ${log.transactionHash} (block ${log.blockNumber})`);

    // Re-read the shape so the stored flat pre-state regains field kinds.
    const shape = await STATE_READERS[t.name](contract, { ...ctxBase, blockTag: log.blockNumber });
    const pre = unflatten(t.preState, shape);
    const { post, anomalies } = await verifyUpgraded({
      name: t.name, Factory, contract, proxy: t.proxy, newImpl: t.newImpl, preBlock: t.preBlock,
      pre, upgradeBlock: log.blockNumber, bookKey, signer, ctxBase,
    });
    failures.push(...anomalies);

    if (record) {
      // The baseline layout comes from local source, so the tree must be the one
      // the proposal was built from. Checked before anything is written.
      if (!(await runtimeMatches(t.factory, t.newImpl))) {
        throw new Error(
          `${t.name}: local ${t.factory} does not compile to ${t.newImpl}. Check out ` +
            `${proposal.gitCommit ?? "the proposal's commit"} and re-run MODE=verify.`
        );
      }
      appendUpgradeRecord(bookKey, {
        contract: t.name, proxy: t.proxy, oldImpl: t.oldImpl, newImpl: t.newImpl,
        txHash: log.transactionHash, timestamp: new Date().toISOString(),
        deployer: proposal.safe, chainId: Number(chainId), blockNumber: log.blockNumber,
        newImplCodeHash: t.newImplCodeHash, gitCommit: proposal.gitCommit, mode: "multisig",
        preState: t.preState, postState: flatten(post),
      });
      await recordBaseline({
        bookKey, contract: t.name, factoryName: t.factory, factory: Factory,
        proxy: t.proxy, impl: t.newImpl, recordedBy: "upgrade",
      });
      logger.success(`  Recorded upgrade (executor ${tx?.from ?? "?"}) + layout baseline`);
    }
    outcomes.push({ name: t.name, proxy: t.proxy, oldImpl: t.oldImpl, newImpl: t.newImpl, txHash: log.transactionHash });
  }
  if (failures.length) throw new Error(`Post-upgrade checks failed:\n  ${failures.join("\n  ")}`);
  return { outcomes };
}

if (require.main === module) {
  runUpgrade().then(
    () => process.exit(0),
    (err) => {
      logger.error(`Upgrade failed: ${err?.message ?? err}`);
      console.error(err);
      process.exit(1);
    }
  );
}
