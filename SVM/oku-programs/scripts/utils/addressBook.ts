/**
 * Deployment address book: `deployments/<network>.json` (per-target-network),
 * written by `scripts/deploy/deploy-init.ts`.
 *
 * `loadDeployment` cross-checks the on-disk program IDs against
 * `Anchor.toml [programs.<network>]` and warns on mismatch (stale file from a
 * previous deploy); `loadDeploymentStrict` throws instead. Every script that
 * SENDS transactions uses the strict loader (audit O-01); the warn-only one is
 * for read-only tools and `close-programs.ts`, whose job is stale deployments.
 * Rent recovery for stale deployments: see README § Deployment.
 */

import * as fs from 'fs';
import { createHash } from 'crypto';
import * as path from 'path';
import { PublicKey } from '@solana/web3.js';
import { NetworkName } from '../config/networks';

/**
 * Per-upgrade audit record appended to `deployments/<network>.json::upgrades`
 * (mirrors the EVM `UpgradeRecord`). `idlSnapshotFile` lets the next upgrade diff
 * account layouts to detect storage-layout breaks.
 */
export interface UpgradeRecord {
  /** Human-readable program name, e.g. "LitePsm". */
  program: string;
  /** On-chain program ID (base58). */
  programId: string;
  /** ELF size of the old on-chain program, in bytes. */
  oldElfSize: number;
  /** ELF size of the newly deployed program, in bytes. */
  newElfSize: number;
  /** SHA-256 hex digest of the old on-chain ELF. */
  oldElfSha256: string;
  /** SHA-256 hex digest of the new local ELF (= on-chain after successful upgrade). */
  newElfSha256: string;
  /**
   * Upgrade transaction signature (base58), or one of these sentinels:
   *   "<bytecode-unchanged>"  — local ELF matched on-chain; no broadcast
   *   "<unknown-signature>"   — deploy succeeded but sig retrieval failed
   */
  txSignature: string;
  timestamp: string;
  /** Wallet that sent the upgrade (direct), or the multisig vault (multisig). */
  deployer: string;
  /**
   * "deploy" = baseline written by deploy-programs.ts (no upgrade happened);
   * "direct" = this script's wallet upgraded; "multisig" = proposed buffer,
   * executed by the vault, closed with MODE=verify.
   */
  mode?: 'deploy' | 'direct' | 'multisig';
  /** Cluster genesis hash, so a record cannot be confused across clusters. */
  genesisHash?: string;
  slot?: number;
  buffer?: string;
  programDataCapacityBefore?: number;
  programDataCapacityAfter?: number;
  extendLamports?: number;
  gitCommit?: string;
  solanaCli?: string;
  /**
   * Full IDL of the program as deployed by this record, stored next to the
   * deployment file (`deployments/idl/<file>`), and its sha256. The next
   * upgrade diffs against it — it is the record of the DEPLOYED layout.
   */
  idlSnapshotFile?: string;
  idlSha256?: string;
  preState?: Record<string, string>;
  postState?: Record<string, string>;
}

export interface DeploymentAddresses {
  network: NetworkName;
  timestamp: string;
  tokens: {
    usdc?: string;
    okuM?: string;
  };
  programs: {
    litePsm?: string;
  };
  pdas: {
    psmConfig?: string;
    psmVaultUsdc?: string;
  };
  authorities?: {
    coldMultisig?: string;
    warmMultisig?: string;
    orchestrator?: string;
  };
  /** Deploy baseline + upgrade audit trail (`scripts/upgrade/index.ts`). */
  upgrades?: UpgradeRecord[];
}

const DEPLOYMENTS_DIR = path.join(process.cwd(), 'deployments');

/**
 * Ensure deployments directory exists
 */
function ensureDeploymentsDir() {
  if (!fs.existsSync(DEPLOYMENTS_DIR)) {
    fs.mkdirSync(DEPLOYMENTS_DIR, { recursive: true });
  }
}

/**
 * Get deployment file path for network
 */
function getDeploymentPath(network: NetworkName): string {
  return path.join(DEPLOYMENTS_DIR, `${network}.json`);
}

/**
 * Read `Anchor.toml`'s `[programs.<section>]` program IDs; `{}` if the section
 * or file is absent.
 */
function readAnchorTomlPrograms(
  section: 'devnet' | 'localnet' | 'mainnet'
): Record<string, string> {
  const tomlPath = path.join(process.cwd(), 'Anchor.toml');
  if (!fs.existsSync(tomlPath)) return {};
  let content: string;
  try {
    content = fs.readFileSync(tomlPath, 'utf-8');
  } catch {
    return {};
  }
  // Match the `[programs.<section>]` block up to the next `[` header or EOF.
  const re = new RegExp(
    `\\[programs\\.${section}\\][^\\[]*`,
    'm'
  );
  const block = content.match(re);
  if (!block) return {};
  const out: Record<string, string> = {};
  // Each row is `key = "Pubkey"`.
  const rowRe = /^\s*([a-z_][a-z0-9_]*)\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/gim;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(block[0])) !== null) {
    out[m[1]] = m[2];
  }
  return out;
}

function anchorSectionFor(network: NetworkName): 'devnet' | 'localnet' | 'mainnet' {
  if (network === 'devnet' || network === 'devnet-fork') return 'devnet';
  if (network === 'mainnet-beta' || network === 'mainnet-fork') return 'mainnet';
  return 'localnet';
}

/**
 * Compare the on-disk deployment's program IDs against
 * `Anchor.toml [programs.<network>]`; returns mismatches (empty = all match).
 */
export function diffDeploymentProgramIds(
  network: NetworkName,
  deployment: DeploymentAddresses
): { key: string; fromFile: string; fromAnchorToml: string }[] {
  // Fork deployments use target/deploy-fork keypairs, whose ids are
  // deliberately NOT in Anchor.toml (the fork build syncs them in only for the
  // duration of the build). Nothing to compare against.
  if (network === 'devnet-fork' || network === 'mainnet-fork') return [];
  const anchorPrograms = readAnchorTomlPrograms(anchorSectionFor(network));
  if (Object.keys(anchorPrograms).length === 0) return [];
  const map: Array<[string, keyof DeploymentAddresses['programs']]> = [
    ['lite_psm', 'litePsm'],
  ];
  const diffs: { key: string; fromFile: string; fromAnchorToml: string }[] = [];
  for (const [tomlKey, fileKey] of map) {
    const fromAnchorToml = anchorPrograms[tomlKey];
    const fromFile = deployment.programs?.[fileKey];
    if (fromAnchorToml && fromFile && fromAnchorToml !== fromFile) {
      diffs.push({ key: tomlKey, fromFile, fromAnchorToml });
    }
  }
  return diffs;
}

/**
 * Load deployment addresses for network; warns if the on-disk program IDs
 * don't match `Anchor.toml` (stale file). Use `loadDeploymentStrict()` to
 * refuse on mismatch.
 */
export function loadDeployment(network: NetworkName): DeploymentAddresses | null {
  const filepath = getDeploymentPath(network);

  if (!fs.existsSync(filepath)) {
    return null;
  }

  let data: DeploymentAddresses;
  try {
    data = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  } catch (error) {
    console.error(`Failed to parse ${filepath}:`, error);
    return null;
  }

  const diffs = diffDeploymentProgramIds(network, data);
  if (diffs.length > 0) {
    const lines = diffs.map(
      (d) =>
        `  ${d.key}: deployments/${network}.json=${d.fromFile} ` +
        `but Anchor.toml=${d.fromAnchorToml}`
    );
    // eslint-disable-next-line no-console
    console.warn(
      [
        '',
        `[addressBook] WARNING: deployments/${network}.json program IDs do `,
        `[addressBook] NOT match Anchor.toml [programs.${anchorSectionFor(network)}]:`,
        ...lines,
        `[addressBook] This usually means deployments/${network}.json is `,
        `[addressBook] stale from a previous deploy run. Either:`,
        `[addressBook]   1. Run \`npm run deploy:init\` to overwrite with current IDs, or`,
        `[addressBook]   2. \`solana program close <OLD_ID> --recipient <YOU> --url ${network}\``,
        `[addressBook]      to recover rent from the old program(s), then delete the file.`,
        `[addressBook] Continuing with file contents — admin txs will hit `,
        `[addressBook] the FILE-level program IDs, NOT the Anchor.toml IDs.`,
        '',
      ].join('\n')
    );
  }

  return data;
}

/** Like `loadDeployment` but throws if the file is missing or stale. */
export function loadDeploymentStrict(
  network: NetworkName
): DeploymentAddresses {
  const data = loadDeployment(network);
  if (!data) {
    throw new Error(
      `No deployments/${network}.json found. Run \`npm run deploy:init\` first.`
    );
  }
  // Admin scripts build transactions with `anchor.workspace.LitePsm`, whose
  // program id is target/idl's `address`, but derive PDAs from this file. The
  // two must be one program or a script would sign for the wrong one.
  if (network !== 'devnet-fork' && network !== 'mainnet-fork') {
    const idlPath = path.join(process.cwd(), 'target', 'idl', 'lite_psm.json');
    const idlAddress = fs.existsSync(idlPath) ? JSON.parse(fs.readFileSync(idlPath, 'utf-8')).address : undefined;
    if (idlAddress && data.programs?.litePsm && idlAddress !== data.programs.litePsm) {
      throw new Error(
        `target/idl/lite_psm.json address ${idlAddress} != deployments/${network}.json ` +
          `programs.litePsm ${data.programs.litePsm}. Rebuild (anchor build) for this cluster's program.`
      );
    }
  }
  const diffs = diffDeploymentProgramIds(network, data);
  if (diffs.length > 0) {
    const lines = diffs.map(
      (d) =>
        `  ${d.key}: deployments/${network}.json=${d.fromFile} ` +
        `but Anchor.toml=${d.fromAnchorToml}`
    );
    throw new Error(
      [
        `deployments/${network}.json is stale relative to Anchor.toml ` +
          `[programs.${anchorSectionFor(network)}]:`,
        ...lines,
        `Refusing to run — see README § Deployment for rent-recovery steps.`,
      ].join('\n')
    );
  }
  return data;
}

/**
 * Save deployment addresses for network
 */
export function saveDeployment(
  network: NetworkName,
  addresses: Partial<DeploymentAddresses>
) {
  ensureDeploymentsDir();

  const filepath = getDeploymentPath(network);
  const existing = loadDeployment(network) || {
    network,
    timestamp: new Date().toISOString(),
    tokens: {},
    programs: {},
    pdas: {},
    authorities: {},
  };

  // Merge with existing
  const updated: DeploymentAddresses = {
    ...existing,
    ...addresses,
    network,
    timestamp: new Date().toISOString(),
    tokens: { ...existing.tokens, ...addresses.tokens },
    programs: { ...existing.programs, ...addresses.programs },
    pdas: { ...existing.pdas, ...addresses.pdas },
    authorities: { ...existing.authorities, ...addresses.authorities },
  };

  writeAtomic(filepath, JSON.stringify(updated, null, 2));
}

/**
 * Update a specific section of the deployment
 */
export function updateDeployment(
  network: NetworkName,
  section: keyof Omit<DeploymentAddresses, 'network' | 'timestamp'>,
  data: Record<string, string>
) {
  const existing = loadDeployment(network) || {
    network,
    timestamp: new Date().toISOString(),
    tokens: {},
    programs: {},
    pdas: {},
    authorities: {},
  };

  const existingSection = existing[section] || {};
  saveDeployment(network, {
    ...existing,
    [section]: { ...existingSection, ...data },
  });
}

/**
 * Get a specific address from deployment
 */
export function getAddress(
  network: NetworkName,
  section: keyof Omit<DeploymentAddresses, 'network' | 'timestamp'>,
  key: string
): PublicKey | null {
  const deployment = loadDeployment(network);
  if (!deployment) return null;

  const sectionData = deployment[section] as any;
  if (!sectionData || !sectionData[key]) return null;

  try {
    return new PublicKey(sectionData[key]);
  } catch {
    return null;
  }
}

/**
 * Check if a deployment exists for the network
 */
export function hasDeployment(network: NetworkName): boolean {
  return fs.existsSync(getDeploymentPath(network));
}

/**
 * Clear deployment for network (for testing)
 */
export function clearDeployment(network: NetworkName) {
  const filepath = getDeploymentPath(network);
  if (fs.existsSync(filepath)) {
    fs.unlinkSync(filepath);
  }
}

/** Fork networks load from their parent network (programs/tokens are forked from it). */
export function loadDeploymentForFork(network: NetworkName): DeploymentAddresses | null {
  if (network === 'devnet-fork') {
    return loadDeployment('devnet');
  }
  if (network === 'mainnet-fork') {
    return loadDeployment('mainnet-beta');
  }
  return loadDeployment(network);
}

// ============================================================================
// Upgrade audit trail helpers
// ============================================================================

/** Append an upgrade record, writing immediately so later failures don't lose it. */
export function appendUpgradeRecord(
  network: NetworkName,
  record: UpgradeRecord
): void {
  ensureDeploymentsDir();
  const filepath = getDeploymentPath(network);

  // Raw read: skip the Anchor.toml mismatch warning during upgrade runs.
  let existing: DeploymentAddresses;
  if (fs.existsSync(filepath)) {
    try {
      existing = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    } catch {
      existing = { network, timestamp: new Date().toISOString(), tokens: {}, programs: {}, pdas: {} };
    }
  } else {
    existing = { network, timestamp: new Date().toISOString(), tokens: {}, programs: {}, pdas: {} };
  }

  const upgrades = existing.upgrades ?? [];
  upgrades.push(record);

  const updated: DeploymentAddresses = { ...existing, upgrades };
  writeAtomic(filepath, JSON.stringify(updated, null, 2));
}

/** Write-then-rename: a crash mid-write cannot truncate the deployment file. */
function writeAtomic(filepath: string, content: string): void {
  const tmp = `${filepath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filepath);
}

const IDL_SNAPSHOT_DIR = path.join(DEPLOYMENTS_DIR, 'idl');

/**
 * Store `idlJson` (raw file text) as the IDL of a deployed ELF; returns the
 * file name relative to `deployments/idl/`. Content-addressed, so re-recording
 * the same IDL is a no-op.
 */
export function saveIdlSnapshot(network: NetworkName, programKey: string, idlJson: string): { file: string; sha256: string } {
  const sha256 = createHash('sha256').update(idlJson).digest('hex');
  const file = `${network}-${programKey}-${sha256.slice(0, 16)}.json`;
  fs.mkdirSync(IDL_SNAPSHOT_DIR, { recursive: true });
  const p = path.join(IDL_SNAPSHOT_DIR, file);
  if (!fs.existsSync(p)) writeAtomic(p, idlJson);
  return { file, sha256 };
}

export function loadIdlSnapshot(file: string): any {
  return JSON.parse(fs.readFileSync(path.join(IDL_SNAPSHOT_DIR, file), 'utf-8'));
}

/** All upgrade records for a network (no Anchor.toml alignment check). */
export function getUpgradeRecords(network: NetworkName): UpgradeRecord[] {
  const filepath = getDeploymentPath(network);
  if (!fs.existsSync(filepath)) return [];
  try {
    const data: DeploymentAddresses = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
    return data.upgrades ?? [];
  } catch {
    return [];
  }
}

/** Most recent UpgradeRecord for the program, if any. */
export function getLastUpgradeRecord(
  network: NetworkName,
  programName: string
): UpgradeRecord | undefined {
  const all = getUpgradeRecords(network);
  // Records are appended chronologically; find last matching entry.
  return [...all].reverse().find((r) => r.program === programName);
}

/**
 * Most recent record for the program that carries an IDL snapshot — the
 * deploy baseline or the last real upgrade.
 */
export function getLastRecordWithIdl(
  network: NetworkName,
  programName: string
): UpgradeRecord | undefined {
  const all = getUpgradeRecords(network);
  return [...all].reverse().find((r) => r.program === programName && r.idlSnapshotFile);
}
