#!/usr/bin/env tsx
/**
 * Upgrade the lite_psm program (BPFLoaderUpgradeable) to the local build.
 *
 * MODES (env MODE, default "direct")
 *   direct   The wallet (WALLET_PATH) is the program's upgrade authority
 *            (devnet). Uploads a buffer, verifies it, extends ProgramData if
 *            needed, upgrades, then verifies.
 *   propose  The upgrade authority is a Squads vault (mainnet):
 *            SQUADS_VAULT=<vault>. Uploads and verifies the buffer, hands the
 *            buffer's authority to the vault, and writes
 *            `deployments/proposals/<network>-<stamp>.json` with everything the
 *            signers need (buffer, ELF hash, spill address, extension needed).
 *            Nothing changes on the program until the vault executes it.
 *   verify   After the vault executed: PROPOSAL=<file>. Checks the on-chain ELF,
 *            liveness, and state, then records the upgrade.
 *   --dry-run / DRY_RUN=true: every check, nothing sent (no buffer either).
 *
 * CHECKS BEFORE ANYTHING IS UPLOADED (fail closed)
 *   1. Identity (lib/identity.ts): deployments/<net>.json, declare_id!, the
 *      ELF's embedded id, the IDL address, Anchor.toml and the local program
 *      keypair all name the same program. The CLI is then given that id in
 *      base58 — never a keypair file — plus explicit --keypair/--upgrade-authority.
 *   2. Cluster: genesis hash (devnet / mainnet-beta).
 *   3. Upgrade authority: the wallet (direct) or SQUADS_VAULT (propose).
 *   4. Baseline: the IDL recorded for the DEPLOYED ELF (deploy baseline or last
 *      upgrade record, bound by ELF hash; or IDL_BASELINE=<file>). The diff
 *      (lib/idlDiff.ts) refuses account-layout breaks and requires
 *      ACCEPT_IDL_CHANGES=1 (or an interactive "yes") for client-visible changes.
 *   5. The live PsmConfig: owner, 754 bytes, discriminator, and identical
 *      decoding under the deployed and new IDLs (preState.ts).
 * AFTER: on-chain ELF == local, a simulated instruction executes
 * (lib/liveness.ts), state diff (invariant fields must not move), invariants.
 * The record (deployments/<net>.json -> upgrades[]) and the IDL snapshot are
 * written before any post-check failure is raised.
 *
 * FORKS (devnet-fork / mainnet-fork): rehearse the PARENT network's program
 * (its deployments file and IDs); nothing is recorded. Direct mode needs the
 * wallet to be the upgrade authority on the fork.
 *
 * ENV: TARGETS=LitePsm, MODE, SQUADS_VAULT, PROPOSAL, SO_PATH (e.g. a
 * verifiable build), IDL_PATH, IDL_BASELINE, ACCEPT_IDL_CHANGES,
 * SKIP_IDL_CHECK (layout breaks become warnings — never on mainnet),
 * SKIP_BYTECODE_CHECK, WALLET_PATH, NETWORK, SOLANA_RPC_URL / HELIUS_RPC,
 * PRIORITY_FEE, MAX_RETRIES, RETRY_DELAY_MS, DEPLOY_TIMEOUT_MS.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { PublicKey } from '@solana/web3.js';
import { AnchorProvider } from '@anchor-lang/core';

import {
  detectNetwork,
  createProviderWithClusterCheck,
  isForkNetwork,
  getParentNetwork,
  walletPath,
} from '../utils/network';
import { NetworkName, DEPLOYMENT_CONFIG } from '../config/networks';
import { logger } from '../utils/logger';
import {
  loadDeploymentStrict,
  appendUpgradeRecord,
  getLastRecordWithIdl,
  saveIdlSnapshot,
  loadIdlSnapshot,
  UpgradeRecord,
} from '../utils/addressBook';
import { isDryRun, confirmIfMainnet, summaryBlock } from '../admin/_lib/confirm';
import { readOnChainElf, getUpgradeAuthority } from './lib/elfCompare';
import {
  CliContext,
  bufferKeypairPath,
  writeBuffer,
  verifyBuffer,
  extensionNeeded,
  extendProgram,
  upgradeFromBuffer,
  setBufferAuthority,
  programDataInfo,
  findUpgradeSignature,
  recoveryHint,
  formatSol,
  BUFFER_HEADER_SIZE,
} from './lib/deployUpgrade';
import { gatherIdentity, checkProgramIdentity } from './lib/identity';
import { diffIdl } from './lib/idlDiff';
import { assertProgramLive } from './lib/liveness';
import {
  readLitePsmState,
  assertConfigCompatible,
  diffSnapshots,
  checkInvariants,
  printStateTable,
  flatten,
  unflatten,
  StateSnapshot,
} from './preState';

const ROOT = process.cwd();

interface Target {
  programKey: string; // target/deploy/<programKey>.so
  bookKey: 'litePsm'; // deployments/<net>.json programs.<bookKey>
  crateDir: string; // programs/<crateDir>/src/lib.rs
}
const UPGRADE_TARGETS: Record<string, Target> = {
  LitePsm: { programKey: 'lite_psm', bookKey: 'litePsm', crateDir: 'lite-psm' },
};

type Mode = 'direct' | 'propose' | 'verify';

interface Proposal {
  kind: 'okumoney-svm-upgrade-proposal';
  network: NetworkName;
  genesisHash: string;
  program: string;
  programId: string;
  buffer: string;
  vault: string;
  spill: string;
  elfSha256: string;
  elfSize: number;
  oldElfSha256: string;
  oldElfSize: number;
  extendBytes: number;
  preSlot: number;
  preState: Record<string, string>;
  idlSnapshotFile: string;
  idlSha256: string;
  gitCommit?: string;
  createdAt: string;
  createdBy: string;
}

// ---------------------------------------------------------------------------

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function gitCommit(): string | undefined {
  try {
    return execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

function solanaCliVersion(): string | undefined {
  try {
    return execSync('solana --version', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

const truthy = (v?: string) => v === '1' || v === 'true';

async function ask(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a: string = await new Promise((r) => rl.question(`${question}\nType "yes" to proceed: `, (x) => { rl.close(); r(x); }));
  return a.trim().toLowerCase() === 'yes';
}

/** `--url` for the CLI: the provider's endpoint (custom RPCs honoured). */
const cliUrl = (network: NetworkName, endpoint: string) => (network === 'localnet' ? 'localhost' : endpoint);

function cliContext(network: NetworkName, provider: AnchorProvider): CliContext {
  return {
    walletPath: walletPath(),
    rpcUrl: cliUrl(network, provider.connection.rpcEndpoint),
    priorityFee: DEPLOYMENT_CONFIG.priorityFee,
    maxRetries: DEPLOYMENT_CONFIG.maxRetries,
    retryDelayMs: DEPLOYMENT_CONFIG.retryDelayMs,
    timeoutMs: DEPLOYMENT_CONFIG.deployTimeoutMs,
    log: logger,
  };
}

/** The IDL recorded for the ELF currently deployed (fail closed). */
async function deployedIdl(
  provider: AnchorProvider,
  bookNetwork: NetworkName,
  name: string,
  programId: PublicKey
): Promise<any> {
  if (process.env.IDL_BASELINE) {
    logger.warning(`  Baseline IDL from IDL_BASELINE=${process.env.IDL_BASELINE} (operator-supplied)`);
    return JSON.parse(fs.readFileSync(process.env.IDL_BASELINE, 'utf-8'));
  }
  const rec = getLastRecordWithIdl(bookNetwork, name);
  if (!rec?.idlSnapshotFile) {
    throw new Error(
      `No IDL baseline for ${name} in deployments/${bookNetwork}.json (deploy-programs.ts writes ` +
        `one; so does every upgrade). Supply the deployed program's IDL with IDL_BASELINE=<file> ` +
        `(e.g. artifacts/svm/lite_psm.json from the commit that was deployed).`
    );
  }
  const onChain = await readOnChainElf(provider.connection, programId, rec.newElfSize);
  if (onChain.sha256 !== rec.newElfSha256) {
    throw new Error(
      `The deployed ELF (${onChain.sha256.slice(0, 16)}…) is not the one the last record ` +
        `describes (${rec.newElfSha256.slice(0, 16)}…): the program was changed outside this ` +
        `script, or a multisig upgrade was never closed with MODE=verify. Supply IDL_BASELINE.`
    );
  }
  logger.info(`  Baseline IDL: deployments/idl/${rec.idlSnapshotFile} (${rec.mode ?? 'upgrade'} record ${rec.timestamp})`);
  return loadIdlSnapshot(rec.idlSnapshotFile);
}

async function postChecks(args: {
  provider: AnchorProvider;
  idl: any;
  programId: PublicKey;
  elf: Buffer;
  pre: StateSnapshot;
}): Promise<{ post: StateSnapshot; failures: string[] }> {
  const failures: string[] = [];
  const conn = args.provider.connection;
  const onChain = await readOnChainElf(conn, args.programId, args.elf.length);
  if (onChain.sha256 !== sha256(args.elf)) {
    failures.push(`on-chain ELF ${onChain.sha256} != local ${sha256(args.elf)}`);
  } else {
    logger.success(`  On-chain ELF matches the local build`);
  }
  try {
    const okuMMint = new PublicKey(args.pre['okuMMint'].value);
    logger.success(`  ${await assertProgramLive(args.provider, args.idl, args.programId, okuMMint)}`);
  } catch (e: any) {
    failures.push(e.message);
  }
  const post = await readLitePsmState(conn, args.idl, args.programId);
  printStateTable(args.pre, post);
  for (const d of diffSnapshots(args.pre, post)) {
    if (d.kind === 'invariant') failures.push(`${d.field}: ${d.before} -> ${d.after}`);
    else logger.warning(`  ${d.field} changed (${d.kind}; an admin tx landed meanwhile): ${d.before} -> ${d.after}`);
  }
  const now = BigInt((await conn.getBlockTime(await conn.getSlot('confirmed'))) ?? Math.floor(Date.now() / 1000));
  failures.push(...checkInvariants(post, now));
  return { post, failures };
}

// ---------------------------------------------------------------------------

async function upgradeTarget(
  name: string,
  t: Target,
  mode: Mode,
  network: NetworkName,
  bookNetwork: NetworkName,
  record: boolean,
  provider: AnchorProvider,
  genesisHash: string
): Promise<void> {
  logger.section(`${name} (${mode}${isDryRun() ? ', dry run' : ''})`);
  const conn = provider.connection;
  const wallet = provider.wallet.publicKey;
  const ctx = cliContext(network, provider);

  const deployment = loadDeploymentStrict(bookNetwork);
  const idStr = deployment.programs?.[t.bookKey];
  if (!idStr) throw new Error(`No programs.${t.bookKey} in deployments/${bookNetwork}.json`);
  const programId = new PublicKey(idStr);
  logger.info(`  Program: ${programId.toBase58()}`);

  const soPath = process.env.SO_PATH ?? path.join(ROOT, 'target', 'deploy', `${t.programKey}.so`);
  const idlPath = process.env.IDL_PATH ?? path.join(ROOT, 'target', 'idl', `${t.programKey}.json`);
  const elf = fs.readFileSync(soPath);
  const idlRaw = fs.readFileSync(idlPath, 'utf-8');
  const idl = JSON.parse(idlRaw);
  logger.info(`  ELF: ${soPath} (${elf.length} bytes, sha256 ${sha256(elf).slice(0, 16)}…)`);

  // 1. Identity
  const mismatches = checkProgramIdentity(
    gatherIdentity({ root: ROOT, network, programKey: t.programKey, crateDir: t.crateDir, expected: programId, idl, elf })
  );
  if (mismatches.length) {
    throw new Error(`Program identity is not consistent — refusing to upload:\n  ${mismatches.join('\n  ')}`);
  }
  logger.success(`  Identity bound: deployments, declare_id!, ELF, IDL, Anchor.toml, keypair agree`);

  // 3. Authority
  const authority = await getUpgradeAuthority(conn, programId);
  if (!authority) throw new Error(`${name} is immutable (no upgrade authority)`);
  let vault: PublicKey | undefined;
  if (mode === 'propose') {
    if (!process.env.SQUADS_VAULT) throw new Error('MODE=propose requires SQUADS_VAULT=<vault address>');
    vault = new PublicKey(process.env.SQUADS_VAULT);
    if (!authority.equals(vault)) throw new Error(`Upgrade authority is ${authority.toBase58()}, not SQUADS_VAULT ${vault.toBase58()}`);
  } else if (!authority.equals(wallet)) {
    throw new Error(
      `Upgrade authority is ${authority.toBase58()}, not the wallet ${wallet.toBase58()}. ` +
        `If it is a Squads vault use MODE=propose SQUADS_VAULT=<vault>.`
    );
  }
  logger.success(`  Upgrade authority: ${authority.toBase58()}`);

  // State before anything else touches the chain (fail if unreadable).
  const pre = await readLitePsmState(conn, idl, programId);

  // Unchanged?
  const onChain = await readOnChainElf(conn, programId, elf.length).catch(() => null);
  if (onChain?.sha256 === sha256(elf) && !truthy(process.env.SKIP_BYTECODE_CHECK)) {
    logger.success(`  On-chain ELF already equals the local build — nothing to do (not recorded)`);
    return;
  }

  // 4. IDL vs the deployed baseline
  const baseline = await deployedIdl(provider, bookNetwork, name, programId);
  const diff = diffIdl(baseline, idl);
  for (const c of diff.clientChanges) logger.warning(`  IDL: ${c}`);
  if (diff.layoutBreaks.length) {
    const msg = `Account-layout breaks vs the deployed IDL:\n  ${diff.layoutBreaks.join('\n  ')}`;
    if (truthy(process.env.SKIP_IDL_CHECK) && !network.startsWith('mainnet')) logger.error(`  ${msg}\n  (SKIP_IDL_CHECK set — continuing)`);
    else throw new Error(msg);
  }
  if (diff.clientChanges.length && !isDryRun() && !truthy(process.env.ACCEPT_IDL_CHANGES)) {
    if (!(await ask(`${diff.clientChanges.length} client-visible IDL change(s) (listed above).`))) {
      throw new Error('Client-visible IDL changes not accepted (set ACCEPT_IDL_CHANGES=1 after reviewing them)');
    }
  }

  // 5. Live account vs both IDLs
  await assertConfigCompatible(conn, programId, baseline, idl);
  logger.success(`  Live PsmConfig decodes identically under the deployed and new IDLs`);

  // Cost
  const ext = await extensionNeeded(conn, programId, elf.length);
  const bufferRent = await conn.getMinimumBalanceForRentExemption(BUFFER_HEADER_SIZE + elf.length);
  const balance = await conn.getBalance(wallet);
  logger.info(
    `  Cost: buffer rent ${formatSol(bufferRent)} (returned on upgrade)` +
      (ext.bytes ? `, ProgramData +${ext.bytes} bytes = ${formatSol(ext.lamports)} (not refundable)` : '') +
      `; wallet ${formatSol(balance)}`
  );
  if (balance < bufferRent + (mode === 'direct' ? ext.lamports : 0) + 10_000_000) {
    throw new Error('Wallet balance too low for the buffer (+ extension) and fees');
  }

  if (isDryRun()) {
    logger.success(`  DRY RUN: all checks passed; nothing uploaded`);
    return;
  }

  await confirmIfMainnet(
    network,
    summaryBlock(`${mode} upgrade of ${name} on ${network}`, {
      program: programId.toBase58(),
      'new ELF sha256': sha256(elf),
      'new ELF bytes': String(elf.length),
      'extend bytes': String(ext.bytes),
      wallet: wallet.toBase58(),
      ...(vault ? { 'squads vault': vault.toBase58() } : {}),
    }),
    conn
  );

  const preSlot = await conn.getSlot('confirmed');
  const bufferFile = bufferKeypairPath(ROOT, network, t.programKey);
  let buffer: PublicKey | undefined;
  try {
    buffer = await writeBuffer(ctx, soPath, bufferFile);
    await verifyBuffer(conn, buffer, elf);
    logger.success(`  Buffer ${buffer.toBase58()} holds exactly the local ELF`);
  } catch (e) {
    if (buffer || fs.existsSync(bufferFile)) logger.error(recoveryHint(buffer?.toBase58() ?? `<pubkey of ${bufferFile}>`, ctx));
    throw e;
  }

  const idlSnap = saveIdlSnapshot(bookNetwork, t.programKey, idlRaw);

  if (mode === 'propose') {
    await setBufferAuthority(ctx, buffer, vault!);
    const b = await verifyBuffer(conn, buffer, elf);
    if (!b.authority?.equals(vault!)) throw new Error(`buffer authority is ${b.authority?.toBase58()}, expected the vault`);
    fs.rmSync(bufferFile); // the key no longer controls the buffer
    const proposal: Proposal = {
      kind: 'okumoney-svm-upgrade-proposal',
      network,
      genesisHash,
      program: name,
      programId: programId.toBase58(),
      buffer: buffer.toBase58(),
      vault: vault!.toBase58(),
      spill: wallet.toBase58(),
      elfSha256: sha256(elf),
      elfSize: elf.length,
      oldElfSha256: onChain?.sha256 ?? '<unknown>',
      oldElfSize: onChain?.size ?? 0,
      extendBytes: ext.bytes,
      preSlot,
      preState: flatten(pre),
      idlSnapshotFile: idlSnap.file,
      idlSha256: idlSnap.sha256,
      gitCommit: gitCommit(),
      createdAt: new Date().toISOString(),
      createdBy: wallet.toBase58(),
    };
    const dir = path.join(ROOT, 'deployments', 'proposals');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${network}-${proposal.createdAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}.json`);
    fs.writeFileSync(file, JSON.stringify(proposal, null, 2) + '\n');
    logger.header('Proposal ready');
    logger.info(`  ${path.relative(ROOT, file)}`);
    logger.info(`  Squads: Developers -> Programs -> ${programId.toBase58()} -> Add upgrade:`);
    logger.info(`    buffer  ${buffer.toBase58()}`);
    logger.info(`    spill   ${wallet.toBase58()}  (receives the buffer rent)`);
    logger.info(`  Signers: the buffer must hash to ${sha256(elf)} (sha256 of the ELF bytes).`);
    if (ext.bytes) {
      logger.warning(`  ProgramData must first grow by ${ext.bytes} bytes (ExtendProgram, signed by the vault).`);
    }
    logger.info(`  Then: MODE=verify PROPOSAL=${path.relative(ROOT, file)} npm run upgrade -- --network=${network}`);
    return;
  }

  // ---- direct ----
  const capacityBefore = (await programDataInfo(conn, programId)).capacity;
  if (ext.bytes) {
    logger.info(`  Extending ProgramData by ${ext.bytes} bytes`);
    await extendProgram(ctx, programId, ext.bytes);
  }
  let signature: string;
  try {
    signature = await upgradeFromBuffer(ctx, buffer, programId);
  } catch (e) {
    logger.error(recoveryHint(buffer.toBase58(), ctx));
    throw e;
  }
  if (signature === '<unknown-signature>') {
    signature = await findUpgradeSignature(conn, (await programDataInfo(conn, programId)).address, preSlot);
  }
  fs.rmSync(bufferFile, { force: true }); // the loader closed the buffer
  logger.success(`  Upgraded: ${signature}`);

  const { post, failures } = await postChecks({ provider, idl, programId, elf, pre });
  if (record) {
    const rec: UpgradeRecord = {
      program: name,
      programId: programId.toBase58(),
      oldElfSize: onChain?.size ?? 0,
      newElfSize: elf.length,
      oldElfSha256: onChain?.sha256 ?? '<unknown>',
      newElfSha256: sha256(elf),
      txSignature: signature,
      timestamp: new Date().toISOString(),
      deployer: wallet.toBase58(),
      mode: 'direct',
      genesisHash,
      slot: await conn.getSlot('confirmed'),
      buffer: buffer.toBase58(),
      programDataCapacityBefore: capacityBefore,
      programDataCapacityAfter: (await programDataInfo(conn, programId)).capacity,
      extendLamports: ext.lamports,
      gitCommit: gitCommit(),
      solanaCli: solanaCliVersion(),
      idlSnapshotFile: idlSnap.file,
      idlSha256: idlSnap.sha256,
      preState: flatten(pre),
      postState: flatten(post),
    };
    appendUpgradeRecord(bookNetwork, rec);
    logger.success(`  Recorded in deployments/${bookNetwork}.json`);
  }
  if (failures.length) throw new Error(`Upgrade landed but post-checks failed:\n  ${failures.join('\n  ')}`);
}

async function verifyProposal(
  file: string,
  network: NetworkName,
  record: boolean,
  provider: AnchorProvider,
  genesisHash: string
): Promise<void> {
  const p: Proposal = JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (p.kind !== 'okumoney-svm-upgrade-proposal') throw new Error(`${file} is not an SVM upgrade proposal`);
  if (p.network !== network) throw new Error(`Proposal is for ${p.network}, not ${network}`);
  if (p.genesisHash !== genesisHash) throw new Error(`Proposal was made on another cluster (genesis ${p.genesisHash})`);
  const conn = provider.connection;
  const programId = new PublicKey(p.programId);
  const onChain = await readOnChainElf(conn, programId, p.elfSize);
  if (onChain.sha256 !== p.elfSha256) throw new Error(`Not executed yet: on-chain ELF is not the proposed one`);
  const idl = loadIdlSnapshot(p.idlSnapshotFile);

  const shape = await readLitePsmState(conn, idl, programId);
  const pre = unflatten(p.preState, shape);
  const failures: string[] = [];
  try {
    logger.success(`  ${await assertProgramLive(provider, idl, programId, new PublicKey(p.preState['okuMMint']))}`);
  } catch (e: any) {
    failures.push(e.message);
  }
  printStateTable(pre, shape);
  for (const d of diffSnapshots(pre, shape)) {
    if (d.kind === 'invariant') failures.push(`${d.field}: ${d.before} -> ${d.after}`);
    else logger.warning(`  ${d.field} changed (${d.kind}): ${d.before} -> ${d.after}`);
  }
  const now = BigInt((await conn.getBlockTime(await conn.getSlot('confirmed'))) ?? Math.floor(Date.now() / 1000));
  failures.push(...checkInvariants(shape, now));

  const pd = await programDataInfo(conn, programId);
  const signature = await findUpgradeSignature(conn, pd.address, p.preSlot);
  logger.success(`  Executed: ${signature}`);
  if (record) {
    appendUpgradeRecord(network, {
      program: p.program,
      programId: p.programId,
      oldElfSize: p.oldElfSize,
      newElfSize: p.elfSize,
      oldElfSha256: p.oldElfSha256,
      newElfSha256: p.elfSha256,
      txSignature: signature,
      timestamp: new Date().toISOString(),
      deployer: p.vault,
      mode: 'multisig',
      genesisHash,
      slot: await conn.getSlot('confirmed'),
      buffer: p.buffer,
      programDataCapacityAfter: pd.capacity,
      gitCommit: p.gitCommit,
      solanaCli: solanaCliVersion(),
      idlSnapshotFile: p.idlSnapshotFile,
      idlSha256: p.idlSha256,
      preState: p.preState,
      postState: flatten(shape),
    });
    logger.success(`  Recorded in deployments/${network}.json`);
  }
  if (failures.length) throw new Error(`Post-upgrade checks failed:\n  ${failures.join('\n  ')}`);
}

// ---------------------------------------------------------------------------

async function main() {
  const network = detectNetwork();
  const fork = isForkNetwork(network);
  const bookNetwork = fork ? getParentNetwork(network) : network;
  const record = !fork;
  const mode = (process.env.MODE ?? 'direct') as Mode;
  if (!['direct', 'propose', 'verify'].includes(mode)) throw new Error(`MODE must be direct, propose or verify`);

  logger.header(`OkuMoney SVM upgrade — ${network} — ${mode}`);
  if (fork) logger.warning(`Fork rehearsal of ${bookNetwork}'s program: nothing is recorded`);

  // 2. Cluster identity (genesis hash) before anything else.
  const provider = await createProviderWithClusterCheck(network);
  const genesisHash = await provider.connection.getGenesisHash();
  logger.info(`Wallet: ${provider.wallet.publicKey.toBase58()} (${walletPath()})`);
  logger.info(`Cluster genesis: ${genesisHash}`);

  if (mode === 'verify') {
    if (!process.env.PROPOSAL) throw new Error('MODE=verify requires PROPOSAL=<file>');
    if (isDryRun()) throw new Error('--dry-run does not apply to MODE=verify (it sends nothing)');
    return verifyProposal(process.env.PROPOSAL, network, record, provider, genesisHash);
  }

  const raw = (process.env.TARGETS ?? '').trim();
  if (!raw) throw new Error(`TARGETS not set. Known: ${Object.keys(UPGRADE_TARGETS).join(', ')}`);
  for (const name of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    const t = UPGRADE_TARGETS[name];
    if (!t) throw new Error(`Unknown target ${name}. Known: ${Object.keys(UPGRADE_TARGETS).join(', ')}`);
    await upgradeTarget(name, t, mode, network, bookNetwork, record, provider, genesisHash);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Upgrade failed: ${err?.message ?? err}`);
    process.exit(1);
  });
