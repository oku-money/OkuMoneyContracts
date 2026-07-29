#!/usr/bin/env tsx
/**
 * SVM Program Upgrade Script for OkuMoney
 *
 * Upgrades one or more BPFLoaderUpgradeable programs to the freshly-compiled
 * .so artifacts in `target/deploy/`. Mirrors the EVM upgrade script in
 * EVM/scripts/upgrade/index.ts — same conceptual steps, adapted for Solana:
 *
 *   1. Resolve program IDs from `deployments/<network>.json`.
 *   2. Verify the deployer wallet is the upgrade authority for each target.
 *   3. Snapshot pre-upgrade on-chain config PDA state.
 *   4. ELF-equality short-circuit: compare SHA-256 of local .so vs on-chain
 *      ProgramData ELF. If identical → record <bytecode-unchanged>, skip.
 *   5. IDL diff guard: compare account-struct fields against the most recent
 *      upgrade record. Any diff → warn and require confirmation (or auto-proceed
 *      when stdin is not a TTY, e.g. CI).
 *   6. SOL balance check: warn if the wallet may run out of funds mid-upload.
 *   7. Deploy (skipped when `--dry-run` is set).
 *   8. Post-upgrade ELF verification: re-read ProgramData and assert SHA-256.
 *   9. Post-upgrade state snapshot + invariant diff.
 *  10. Append UpgradeRecord to `deployments/<network>.json::upgrades`.
 *
 * Buffer-keypair persistence (auto-resume):
 *   A per-program keypair at `target/upgrade-buffers/<prog>-buffer-keypair.json`
 *   is passed as `--buffer <keypair>` to `solana program deploy`. If the process
 *   dies mid-upload the CLI will resume from the partial buffer on the next run,
 *   saving the full upload cost (~5 SOL for an 800 KB program).
 *
 * Usage:
 *
 *   # Upgrade LitePsm on devnet
 *   TARGETS=LitePsm npm run upgrade:devnet
 *
 *   # Dry run — shows plan + IDL diff without broadcasting
 *   TARGETS=LitePsm npm run upgrade:devnet -- --dry-run
 *
 *   # Force deploy even if ELF hasn't changed (useful for CI smoke-test)
 *   TARGETS=LitePsm SKIP_BYTECODE_CHECK=true npm run upgrade:devnet
 *
 * Audit trail:
 *   Each run appends an UpgradeRecord to `deployments/<network>.json::upgrades`
 *   with old/new ELF size + SHA-256, tx signature, deployer, timestamp, and a
 *   compact snapshot of account-struct fields for future IDL diff comparisons.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { createHash } from 'crypto';
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { Program, AnchorProvider } from '@anchor-lang/core';

import { detectNetwork, createProvider, isForkNetwork } from '../utils/network';
import { NetworkName, NETWORK_CONFIGS, DEPLOYMENT_CONFIG } from '../config/networks';
import { logger } from '../utils/logger';
import {
  loadDeployment,
  appendUpgradeRecord,
  getLastUpgradeRecord,
  UpgradeRecord,
} from '../utils/addressBook';
import { isDryRun, confirmIfMainnet, summaryBlock } from '../admin/_lib/confirm';
import {
  compareElf,
  readLocalElf,
  readOnChainElf,
  getUpgradeAuthority,
} from './lib/elfCompare';
import {
  deployUpgrade,
} from './lib/deployUpgrade';
import {
  STATE_READERS,
  ProgramSet,
  StateSnapshot,
  diffSnapshots,
  printStateTable,
} from './preState';

// ============================================================================
// Upgrade target registry
// ============================================================================

interface UpgradeTarget {
  /** Filesystem key (matches target/deploy/<programKey>.so and *-keypair.json). */
  programKey: string;
  /** Key in deployments/<network>.json::programs. */
  bookKey: 'litePsm';
  /** Key in STATE_READERS. */
  stateKey: string;
  /** Human-readable display name. */
  idlFile: string;
}

const UPGRADE_TARGETS: Record<string, UpgradeTarget> = {
  LitePsm: {
    programKey: 'lite_psm',
    bookKey:    'litePsm',
    stateKey:   'LitePsm',
    idlFile:    'lite_psm.json',
  },
};

// ============================================================================
// Helpers
// ============================================================================

function formatSol(lamports: number | bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(6);
}

/**
 * Map a NetworkName to the --url argument that `solana program deploy` accepts.
 * We prefer the full RPC URL (from the provider connection) over the short
 * monikers so that Helius / custom endpoints are used for the CLI too.
 * The caller always passes `provider.connection.rpcEndpoint`.
 */
function solanaUrlFor(network: NetworkName, rpcEndpoint: string): string {
  // For localnet the CLI accepts 'localhost' as a moniker; use it so the URL
  // looks clean in logs. For everything else use the actual endpoint.
  if (network === 'localnet') return 'localhost';
  return rpcEndpoint;
}

// ============================================================================
// IDL snapshot utilities
// ============================================================================

interface IdlSnapshot {
  sha256: string;
  accountTypes: Record<string, Array<{ name: string; type: unknown }>>;
}

/**
 * Build an IdlSnapshot from the IDL file at `target/idl/<idlFile>`.
 * Extracts account-struct field definitions (the storage-critical types).
 */
function buildIdlSnapshot(idlPath: string): IdlSnapshot | null {
  try {
    const raw = fs.readFileSync(idlPath, 'utf-8');
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const idl = JSON.parse(raw);

    // Account names from the `accounts` section (Anchor 1.0: just name+discriminator).
    const accountNames = new Set<string>(
      (idl.accounts ?? []).map((a: any) => a.name as string)
    );

    // Anchor 1.0 stores struct definitions in `types`. Extract the ones that
    // correspond to account structs (i.e. same name as an entry in `accounts`).
    const accountTypes: Record<string, Array<{ name: string; type: unknown }>> = {};
    for (const t of idl.types ?? []) {
      if (accountNames.has(t.name) && t.type?.kind === 'struct') {
        accountTypes[t.name] = (t.type.fields ?? []).map((f: any) => ({
          name: f.name,
          type: f.type,
        }));
      }
    }

    return { sha256, accountTypes };
  } catch {
    return null;
  }
}

/**
 * Compare current IDL snapshot against a prior record's snapshot.
 * Returns a human-readable description of what changed, or null if nothing did.
 */
function describeIdlDiff(
  prior: IdlSnapshot,
  current: IdlSnapshot
): string | null {
  if (prior.sha256 === current.sha256) return null;

  const lines: string[] = ['IDL changed since last upgrade:'];

  const allTypeNames = new Set([
    ...Object.keys(prior.accountTypes),
    ...Object.keys(current.accountTypes),
  ]);

  for (const typeName of [...allTypeNames].sort()) {
    const priorFields = prior.accountTypes[typeName];
    const curFields   = current.accountTypes[typeName];

    if (!priorFields && curFields) {
      lines.push(`  [+] new account type: ${typeName}`);
      continue;
    }
    if (priorFields && !curFields) {
      lines.push(`  [-] removed account type: ${typeName}`);
      continue;
    }
    if (!priorFields || !curFields) continue;

    // Compare field by field.
    const priorByName = new Map(priorFields.map((f) => [f.name, f.type]));
    const curByName   = new Map(curFields.map((f) => [f.name, f.type]));
    const allFieldNames = new Set([...priorByName.keys(), ...curByName.keys()]);

    const fieldLines: string[] = [];
    for (const fn of allFieldNames) {
      const pType = priorByName.get(fn);
      const cType = curByName.get(fn);
      if (pType === undefined) {
        fieldLines.push(`      [+] ${fn}: ${JSON.stringify(cType)}`);
      } else if (cType === undefined) {
        fieldLines.push(`      [-] ${fn}: ${JSON.stringify(pType)}`);
      } else if (JSON.stringify(pType) !== JSON.stringify(cType)) {
        fieldLines.push(
          `      [~] ${fn}: ${JSON.stringify(pType)} → ${JSON.stringify(cType)}`
        );
      }
    }

    if (fieldLines.length > 0) {
      lines.push(`  ${typeName}:`);
      lines.push(...fieldLines);
    }
  }

  return lines.length > 1 ? lines.join('\n') : null;
}

// ============================================================================
// Interactive confirmation (IDL diff)
// ============================================================================

async function promptContinue(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    // Non-interactive (CI / piped): auto-proceed with a warning.
    logger.warning(
      `${message}\n  ` +
        `stdin is not a TTY — auto-proceeding. ` +
        `Pass SKIP_IDL_CHECK=true to suppress this warning.`
    );
    return true;
  }

  console.log('');
  console.log('='.repeat(60));
  console.log(message);
  console.log('='.repeat(60));
  console.log('');
  console.log('Type "yes" to proceed with the upgrade, anything else to abort:');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer: string = await new Promise((resolve) => {
    rl.question('> ', (a) => { rl.close(); resolve(a.trim().toLowerCase()); });
  });

  if (answer !== 'yes') {
    logger.warning('Aborted by operator.');
    return false;
  }
  return true;
}

// ============================================================================
// Per-target upgrade
// ============================================================================

interface UpgradeOutcome {
  name: string;
  programId: string;
  oldElfSha256: string;
  newElfSha256: string;
  oldElfSize: number;
  newElfSize: number;
  txSignature: string;
}

async function upgradeOne(
  name: string,
  target: UpgradeTarget,
  provider: AnchorProvider,
  programs: ProgramSet,
  networkName: NetworkName,
  rpcUrl: string
): Promise<UpgradeOutcome> {
  logger.section(`Upgrading ${name}`);

  const connection = provider.connection;
  const walletPubkey = provider.wallet.publicKey;

  // ── 1. Resolve program ID from deployment ─────────────────────────────────
  const deployment = loadDeployment(networkName);
  if (!deployment?.programs?.[target.bookKey]) {
    throw new Error(
      `No program ID for "${name}" in deployments/${networkName}.json (key: programs.${target.bookKey}). ` +
        `Run \`npm run deploy:programs\` first.`
    );
  }
  const programId = new PublicKey(deployment.programs[target.bookKey]!);
  logger.info(`  Program ID: ${programId.toBase58()}`);

  // ── 2. Resolve file paths ─────────────────────────────────────────────────
  const keypairPath = path.join(process.cwd(), 'target', 'deploy', `${target.programKey}-keypair.json`);
  const soPath      = path.join(process.cwd(), 'target', 'deploy', `${target.programKey}.so`);
  const idlPath     = path.join(process.cwd(), 'target', 'idl', target.idlFile);

  for (const [label, p] of [['keypair', keypairPath], ['ELF (.so)', soPath]] as const) {
    if (!fs.existsSync(p)) {
      throw new Error(
        `${name} ${label} not found at ${p}. Run \`anchor build\` first.`
      );
    }
  }

  // ── 3. Verify upgrade authority ───────────────────────────────────────────
  logger.info(`  Checking upgrade authority...`);
  const authority = await getUpgradeAuthority(connection, programId);
  if (!authority) {
    throw new Error(
      `${name} (${programId.toBase58()}) has no upgrade authority — ` +
        `the program is immutable and cannot be upgraded.`
    );
  }
  if (!authority.equals(walletPubkey)) {
    throw new Error(
      `${name}: upgrade authority is ${authority.toBase58()} but ` +
        `our wallet is ${walletPubkey.toBase58()}. Cannot upgrade.`
    );
  }
  logger.success(`  Upgrade authority verified (${walletPubkey.toBase58().slice(0, 8)}...)`);

  // ── 4. Pre-upgrade state snapshot ─────────────────────────────────────────
  const reader = STATE_READERS[target.stateKey];
  if (!reader) {
    throw new Error(`No state reader registered for "${target.stateKey}".`);
  }
  logger.info(`  Reading pre-upgrade state...`);
  const preState = await reader(programs, programId);

  // ── 5. ELF-equality short-circuit ─────────────────────────────────────────
  logger.info(`  Comparing local .so to on-chain ELF...`);
  const localElf = readLocalElf(soPath);
  const skipBytecodeCheck = process.env.SKIP_BYTECODE_CHECK === 'true';

  if (!skipBytecodeCheck) {
    const { unchanged, onChain } = await compareElf(
      connection, programId, soPath, logger
    );
    if (unchanged && onChain) {
      logger.success(
        `  ${name}: local ELF matches on-chain (sha256: ${onChain.sha256.slice(0, 16)}…) ` +
          `— skipping upgrade.`
      );
      // Still snapshot post-state for the table (will be identical).
      const postState = await reader(programs, programId);
      printStateTable(preState, postState);

      // Only persist a skip record when running for real — dry-runs must not
      // mutate the on-disk audit log (otherwise repeated dry-runs accumulate
      // noise records that future IDL-diff comparisons would have to walk).
      if (!isDryRun()) {
        const skipRecord: UpgradeRecord = {
          program:      name,
          programId:    programId.toBase58(),
          oldElfSize:   onChain.size,
          newElfSize:   onChain.size,
          oldElfSha256: onChain.sha256,
          newElfSha256: onChain.sha256,
          txSignature:  '<bytecode-unchanged>',
          timestamp:    new Date().toISOString(),
          deployer:     walletPubkey.toBase58(),
        };
        appendUpgradeRecord(networkName, skipRecord);
        logger.info(`  Recorded skip in deployments/${networkName}.json`);
      } else {
        logger.info(`  --dry-run set — not recording skip in deployments/${networkName}.json`);
      }

      return {
        name,
        programId: programId.toBase58(),
        oldElfSha256: onChain.sha256,
        newElfSha256: onChain.sha256,
        oldElfSize:   onChain.size,
        newElfSize:   onChain.size,
        txSignature: '<bytecode-unchanged>',
      };
    }
  } else {
    logger.warning(`  SKIP_BYTECODE_CHECK=true — forcing upgrade even if ELF matches.`);
  }

  // Read on-chain ELF info now (we know it differs or check was skipped).
  let onChainElf = { size: 0, sha256: '<unknown>' };
  try {
    onChainElf = await readOnChainElf(connection, programId);
    logger.info(
      `  On-chain ELF: ${onChainElf.size} bytes (sha256: ${onChainElf.sha256.slice(0, 16)}…)`
    );
  } catch { /* non-fatal; we already checked authority */ }
  logger.info(
    `  Local ELF:    ${localElf.size} bytes (sha256: ${localElf.sha256.slice(0, 16)}…)`
  );

  // ── 6. IDL diff guard ─────────────────────────────────────────────────────
  if (process.env.SKIP_IDL_CHECK !== 'true') {
    const currentIdlSnap = buildIdlSnapshot(idlPath);
    const priorRecord    = getLastUpgradeRecord(networkName, name);

    if (currentIdlSnap && priorRecord?.idlSnapshot) {
      const diff = describeIdlDiff(priorRecord.idlSnapshot, currentIdlSnap);
      if (diff) {
        logger.warning(`  ${diff}`);
        if (!isDryRun()) {
          const proceed = await promptContinue(
            `${name}: IDL account-struct fields changed since last upgrade.\n` +
              diff +
              `\n\nThis may indicate a storage-layout change. ` +
              `Ensure existing accounts can still be deserialized before proceeding.`
          );
          if (!proceed) {
            throw new Error(`${name}: operator aborted due to IDL diff.`);
          }
        }
      } else {
        logger.success(`  IDL account types unchanged since last upgrade.`);
      }
    } else if (!priorRecord) {
      logger.info(`  No prior upgrade record — IDL diff skipped (first upgrade).`);
    }
  }

  // ── 7. SOL balance check ──────────────────────────────────────────────────
  const balanceLamports = await connection.getBalance(walletPubkey);
  logger.info(`  Wallet balance: ${formatSol(balanceLamports)} SOL`);
  // Rough cost estimate: buffer rent (~5–8 SOL for 800 KB) + tx fees.
  const estimatedCostSol = Math.ceil(localElf.size / 1_048_576) * 7 + 0.1;
  if (balanceLamports / LAMPORTS_PER_SOL < estimatedCostSol) {
    logger.warning(
      `  Wallet balance (${formatSol(balanceLamports)} SOL) may be ` +
        `insufficient for this upgrade (~${estimatedCostSol.toFixed(1)} SOL estimated). ` +
        `Top up before proceeding to avoid partial uploads.`
    );
  }

  // ── 8. Dry-run exit ───────────────────────────────────────────────────────
  if (isDryRun()) {
    logger.info(
      `  --dry-run set — would deploy ${localElf.size} bytes (sha256: ${localElf.sha256.slice(0, 16)}…)`
    );
    return {
      name,
      programId: programId.toBase58(),
      oldElfSha256: onChainElf.sha256,
      newElfSha256: localElf.sha256,
      oldElfSize:   onChainElf.size,
      newElfSize:   localElf.size,
      txSignature: '<dry-run>',
    };
  }

  // ── 9. Mainnet confirmation ───────────────────────────────────────────────
  await confirmIfMainnet(
    networkName,
    summaryBlock(`upgrade ${name} on ${networkName}`, {
      'programId':        programId.toBase58(),
      'old ELF (bytes)':  String(onChainElf.size),
      'new ELF (bytes)':  String(localElf.size),
      'old sha256':       onChainElf.sha256.slice(0, 32) + '…',
      'new sha256':       localElf.sha256.slice(0, 32) + '…',
      'deployer':         walletPubkey.toBase58(),
    })
  );

  // ── 10. Deploy ────────────────────────────────────────────────────────────
  const { txSignature } = await deployUpgrade({
    programName:      name,
    programKey:       target.programKey,
    programId,
    keypairPath,
    soPath,
    walletPubkey,
    localElfSha256:   localElf.sha256,
    connection,
    rpcUrl,
    priorityFee:      DEPLOYMENT_CONFIG.priorityFee,
    maxRetries:       DEPLOYMENT_CONFIG.maxRetries,
    retryDelayMs:     DEPLOYMENT_CONFIG.retryDelayMs,
    deployTimeoutMs:  DEPLOYMENT_CONFIG.deployTimeoutMs,
    logger,
  });

  // ── 11. Post-upgrade ELF verification ────────────────────────────────────
  //
  // Pass `expectedSize = localElf.size` so the on-chain hash is computed
  // over exactly the prefix the new ELF occupies. BPFLoaderUpgradeable does
  // NOT shrink the ProgramData account when a smaller ELF replaces a larger
  // one — without the truncation the trailing (zeroed) bytes of the old
  // ELF would contaminate the hash and produce a false-positive mismatch.
  logger.info(`  Verifying on-chain ELF after upgrade...`);
  let verifiedSha256 = localElf.sha256;
  try {
    const postElf = await readOnChainElf(connection, programId, localElf.size);
    if (postElf.sha256 !== localElf.sha256) {
      throw new Error(
        `Post-upgrade ELF mismatch: on-chain sha256 ${postElf.sha256} ` +
          `differs from local ${localElf.sha256}. Upgrade may not have landed correctly.`
      );
    }
    logger.success(
      `  On-chain ELF verified (sha256: ${postElf.sha256.slice(0, 16)}… — matches local)`
    );
    verifiedSha256 = postElf.sha256;
  } catch (err: any) {
    if (err.message?.includes('Post-upgrade ELF mismatch')) throw err;
    // ELF read error is non-fatal if we have a confirmed signature.
    logger.warning(
      `  ELF re-read failed (non-fatal if signature confirmed): ` +
        `${err.message?.slice(0, 80) ?? err}`
    );
  }

  // ── 12. Post-upgrade state snapshot + invariant diff ─────────────────────
  logger.info(`  Reading post-upgrade state...`);
  const postState = await reader(programs, programId);
  const diffs = diffSnapshots(preState, postState);
  printStateTable(preState, postState);

  if (diffs.length > 0) {
    logger.error(`  Storage invariants changed during upgrade on ${name}:`);
    for (const d of diffs) {
      logger.error(`    ${d.field}: "${d.before}" → "${d.after}"`);
    }
    throw new Error(
      `Post-upgrade state diff for ${name} is non-empty. ` +
        `This should not happen for a pure code upgrade (no reinitializer called). ` +
        `Investigate before proceeding.`
    );
  }
  logger.success(`  All state invariants preserved.`);

  // ── 13. Append audit record ───────────────────────────────────────────────
  const idlSnap = buildIdlSnapshot(idlPath) ?? undefined;
  const record: UpgradeRecord = {
    program:      name,
    programId:    programId.toBase58(),
    oldElfSize:   onChainElf.size,
    newElfSize:   localElf.size,
    oldElfSha256: onChainElf.sha256,
    newElfSha256: verifiedSha256,
    txSignature,
    timestamp:    new Date().toISOString(),
    deployer:     walletPubkey.toBase58(),
    idlSnapshot:  idlSnap ?? undefined,
  };
  appendUpgradeRecord(networkName, record);
  logger.success(`  Recorded upgrade in deployments/${networkName}.json`);

  return {
    name,
    programId:    programId.toBase58(),
    oldElfSha256: onChainElf.sha256,
    newElfSha256: verifiedSha256,
    oldElfSize:   onChainElf.size,
    newElfSize:   localElf.size,
    txSignature,
  };
}

// ============================================================================
// Target parsing
// ============================================================================

function parseTargets(): string[] {
  const raw = (process.env.TARGETS ?? '').trim();
  if (!raw) {
    throw new Error(
      `TARGETS env var is not set. Specify one or more programs to upgrade, e.g.\n` +
        `  TARGETS=LitePsm npm run upgrade -- --network=devnet\n` +
        `Known targets: ${Object.keys(UPGRADE_TARGETS).join(', ')}.`
    );
  }
  const list = Array.from(
    new Set(
      raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
    )
  );
  const unknown = list.filter((n) => !UPGRADE_TARGETS[n]);
  if (unknown.length > 0) {
    throw new Error(
      `Unknown TARGETS entries: ${unknown.join(', ')}.\n` +
        `Known targets: ${Object.keys(UPGRADE_TARGETS).join(', ')}.`
    );
  }
  return list;
}

// ============================================================================
// Load Anchor programs
// ============================================================================

function loadPrograms(
  provider: AnchorProvider,
  deployment: ReturnType<typeof loadDeployment>
): ProgramSet {
  if (!deployment) throw new Error('Deployment not found — cannot load Anchor programs.');

  function loadProgram(idlFile: string, programIdStr: string | undefined): Program {
    if (!programIdStr) {
      throw new Error(
        `Program ID for ${idlFile} not found in deployment. ` +
          `Run \`npm run deploy:programs\` first.`
      );
    }
    const idlPath = path.join(process.cwd(), 'target', 'idl', idlFile);
    if (!fs.existsSync(idlPath)) {
      throw new Error(`IDL not found at ${idlPath}. Run \`anchor build\` first.`);
    }
    const idl = JSON.parse(fs.readFileSync(idlPath, 'utf-8'));
    idl.address = programIdStr;
    return new Program(idl, provider);
  }

  return {
    psm:    loadProgram('lite_psm.json',   deployment.programs.litePsm),
  };
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const network = detectNetwork();
  const networkConfig = NETWORK_CONFIGS[network];

  logger.header(`OkuMoney SVM Upgrade — ${network}`);
  logger.info(`Network: ${network} (${networkConfig.cluster})`);

  if (isForkNetwork(network)) {
    logger.warning(
      `Running against a fork (${network}). ` +
        `Upgrades will NOT persist past the fork session. ` +
        `This is useful for smoke-testing upgrade paths before live execution.`
    );
  }

  const targets = parseTargets();
  logger.info(`Targets: ${targets.join(', ')}`);
  if (isDryRun()) logger.warning(`--dry-run set — no transactions will be broadcast.`);

  // Resolve provider + signer.
  const provider = createProvider(network);
  const walletPubkey = provider.wallet.publicKey;
  const connection   = provider.connection;
  const rpcUrl       = solanaUrlFor(network, connection.rpcEndpoint);

  const balanceLamports = await connection.getBalance(walletPubkey);
  logger.info(`Deployer: ${walletPubkey.toBase58()}`);
  logger.info(`Balance:  ${formatSol(balanceLamports)} SOL`);
  logger.log('');

  // Load deployment and Anchor programs once for all targets.
  const deployment = loadDeployment(network);
  if (!deployment) {
    throw new Error(
      `No deployments/${network}.json found. Run \`npm run deploy:programs\` first.`
    );
  }
  const programs = loadPrograms(provider, deployment);

  // Execute upgrades sequentially (fail-fast: a failure on target N halts the
  // run, but every target that succeeded before N has its audit record saved).
  const outcomes: UpgradeOutcome[] = [];
  for (const name of targets) {
    const target = UPGRADE_TARGETS[name];
    const outcome = await upgradeOne(
      name, target, provider, programs, network, rpcUrl
    );
    outcomes.push(outcome);
    logger.log('');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  logger.header('Upgrade Complete');
  console.log(`Upgraded programs (network: ${network}):`);
  for (const o of outcomes) {
    const changed = o.txSignature !== '<bytecode-unchanged>' && o.txSignature !== '<dry-run>';
    console.log(`  ${o.name}`);
    console.log(`    programId:   ${o.programId}`);
    console.log(`    oldElfSha256: ${o.oldElfSha256.slice(0, 16)}…`);
    console.log(`    newElfSha256: ${o.newElfSha256.slice(0, 16)}…`);
    if (changed) {
      console.log(`    sizeDelta:   ${o.newElfSize - o.oldElfSize > 0 ? '+' : ''}${o.newElfSize - o.oldElfSize} bytes`);
    }
    console.log(`    txSignature: ${o.txSignature}`);
  }
  console.log('');
  logger.info(`Audit trail: deployments/${network}.json → upgrades[]`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Upgrade failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
