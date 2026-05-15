/**
 * Recover rent from stale BPF Loader Upgradeable program deployments.
 *
 * Wraps `solana program close` (the only Solana-CLI path for reclaiming
 * the rent SOL escrowed in a program's ProgramData account — there is no
 * direct RPC instruction for this).
 *
 * Default behavior: read the three program IDs from
 * `deployments/<network>.json::programs.{litePsm,okuDollarProgram,okuBridgeRouter}`,
 * `solana program show` each (verifying it's deployed and that the
 * deployer wallet is its upgrade authority), then close them and report
 * recovered SOL.
 *
 * Pass `--ids=<id1>,<id2>` to target a specific list instead. Programs
 * passed via `--ids` are NOT cross-checked against the deployments file.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/close-programs.ts
 *   NETWORK=devnet tsx scripts/admin/close-programs.ts --ids=ID1,ID2
 *   NETWORK=devnet tsx scripts/admin/close-programs.ts --dry-run
 *   NETWORK=mainnet-beta tsx scripts/admin/close-programs.ts \
 *       --yes-i-mean-it-on-mainnet
 *
 * Safety:
 *   - Refuses to close a program whose upgrade authority isn't the
 *     deployer wallet (the close would fail anyway; we surface the
 *     mismatch cleanly first).
 *   - Refuses to close program IDs that are *currently* declared in
 *     Anchor.toml [programs.<network>] unless `--allow-anchor-toml-ids`
 *     is passed (those IDs are about to be used by the next
 *     `deploy:programs` run; closing them would force a keypair
 *     rotation).
 *   - --dry-run prints the plan without submitting.
 *
 * Post-run: this script does NOT delete `deployments/<network>.json` —
 * the addressBook stale-warning still fires on the next script
 * invocation until you either run `deploy:init` (overwrites) or
 * manually `rm` the file. That's intentional: deleting the file before
 * recovery would orphan the program IDs in explorer history.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execSync, spawnSync } from 'child_process';
import { Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { detectNetwork, createProvider } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { NetworkName, NETWORK_CONFIGS } from '../config/networks';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

function parseList(name: string): string[] | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return undefined;
  return a
    .split('=')
    .slice(1)
    .join('=')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Map a NetworkName to the `--url` value `solana` CLI expects. The
 * CLI accepts both moniker (`devnet`, `mainnet-beta`) and full RPC URL;
 * we prefer the moniker for the canonical clusters and the configured
 * `cluster` URL for everything else.
 */
function solanaUrlFor(network: NetworkName): string {
  if (network === 'devnet') return 'devnet';
  if (network === 'mainnet-beta') return 'mainnet-beta';
  if (network === 'localnet') return 'localhost';
  // Fork networks read their RPC from the network config.
  return NETWORK_CONFIGS[network].cluster;
}

interface ProgramShow {
  programId: PublicKey;
  authority: PublicKey | null;
  balanceLamports: bigint;
  dataLength: number;
  programDataAddress: PublicKey;
  closed: boolean;
  error?: string;
}

/**
 * `solana program show <id>` parser. Returns the on-chain authority,
 * the rent balance held in ProgramData, and a `closed` flag so callers
 * can skip already-closed programs without erroring out.
 */
function programShow(programId: string, url: string): ProgramShow {
  const out = spawnSync(
    'solana',
    ['program', 'show', programId, '--url', url],
    { encoding: 'utf-8' }
  );
  const text = `${out.stdout ?? ''}\n${out.stderr ?? ''}`;
  if (/has been closed/i.test(text)) {
    return {
      programId: new PublicKey(programId),
      authority: null,
      balanceLamports: 0n,
      dataLength: 0,
      programDataAddress: PublicKey.default,
      closed: true,
    };
  }
  if (out.status !== 0 && !text.includes('Program Id:')) {
    return {
      programId: new PublicKey(programId),
      authority: null,
      balanceLamports: 0n,
      dataLength: 0,
      programDataAddress: PublicKey.default,
      closed: false,
      error: text.trim().slice(0, 200),
    };
  }
  const get = (re: RegExp): string | null => {
    const m = text.match(re);
    return m ? m[1].trim() : null;
  };
  const authority = get(/Authority:\s*(\S+)/);
  const balanceStr = get(/Balance:\s*([0-9.]+)\s*SOL/);
  const dataLenStr = get(/Data Length:\s*([0-9]+)/);
  const programDataAddr = get(/ProgramData Address:\s*(\S+)/);
  return {
    programId: new PublicKey(programId),
    authority: authority ? new PublicKey(authority) : null,
    balanceLamports: balanceStr
      ? BigInt(Math.round(parseFloat(balanceStr) * LAMPORTS_PER_SOL))
      : 0n,
    dataLength: dataLenStr ? Number(dataLenStr) : 0,
    programDataAddress: programDataAddr
      ? new PublicKey(programDataAddr)
      : PublicKey.default,
    closed: false,
  };
}

function fmtSol(lamports: bigint): string {
  return (Number(lamports) / LAMPORTS_PER_SOL).toFixed(9);
}

/**
 * Read the Anchor.toml [programs.<section>] block to surface the IDs we
 * should NOT close (the next-deploy targets). Mirrors the parser in
 * addressBook.ts.
 */
function readAnchorTomlPrograms(
  section: 'devnet' | 'localnet' | 'mainnet'
): Set<string> {
  const tomlPath = path.join(process.cwd(), 'Anchor.toml');
  if (!fs.existsSync(tomlPath)) return new Set();
  const content = fs.readFileSync(tomlPath, 'utf-8');
  const re = new RegExp(`\\[programs\\.${section}\\][^\\[]*`, 'm');
  const block = content.match(re);
  if (!block) return new Set();
  const out = new Set<string>();
  const rowRe = /^\s*[a-z_][a-z0-9_]*\s*=\s*"([1-9A-HJ-NP-Za-km-z]{32,44})"/gim;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(block[0])) !== null) {
    out.add(m[1]);
  }
  return out;
}

function anchorSectionFor(
  network: NetworkName
): 'devnet' | 'localnet' | 'mainnet' {
  if (network === 'devnet' || network === 'devnet-fork') return 'devnet';
  if (network === 'mainnet-beta' || network === 'mainnet-fork') return 'mainnet';
  return 'localnet';
}

async function getBalance(
  conn: Connection,
  pk: PublicKey
): Promise<bigint> {
  return BigInt(await conn.getBalance(pk));
}

async function main() {
  const network = detectNetwork();
  logger.header(`close-programs (${network})`);

  if (network === 'devnet-fork' || network === 'mainnet-fork') {
    throw new Error(
      `close-programs is a real-chain action; running on ${network} is ` +
        `not supported. Use NETWORK=devnet or NETWORK=mainnet-beta.`
    );
  }

  const provider = createProvider(network);
  const wallet = provider.wallet.publicKey;
  const url = solanaUrlFor(network);

  // 1. Resolve the target program IDs.
  let ids = parseList('ids');
  let source: string;
  if (ids && ids.length > 0) {
    source = '--ids argument';
  } else {
    const dep = loadDeployment(network);
    if (!dep?.programs) {
      throw new Error(
        `No --ids passed and deployments/${network}.json has no programs. ` +
          `Nothing to close.`
      );
    }
    ids = [
      dep.programs.litePsm,
      dep.programs.okuDollarProgram,
      dep.programs.okuBridgeRouter,
    ].filter((x): x is string => typeof x === 'string' && x.length > 0);
    source = `deployments/${network}.json`;
    if (ids.length === 0) {
      throw new Error(
        `deployments/${network}.json has no program IDs to close.`
      );
    }
  }
  // Dedupe defensively.
  ids = Array.from(new Set(ids));

  // 2. Cross-check against Anchor.toml [programs.<network>] — refuse to
  // close currently-declared IDs unless the operator opts in.
  const anchorIds = readAnchorTomlPrograms(anchorSectionFor(network));
  const allowAnchor = process.argv.includes('--allow-anchor-toml-ids');
  const collisions = ids.filter((i) => anchorIds.has(i));
  if (collisions.length > 0 && !allowAnchor) {
    logger.warning(
      `${collisions.length} target ID(s) are declared in ` +
        `Anchor.toml [programs.${anchorSectionFor(network)}] — these are ` +
        `the next-deploy targets. Skipping them.`
    );
    for (const c of collisions) logger.warning(`  - ${c}`);
    logger.info(
      `Pass --allow-anchor-toml-ids to close these anyway (forces a ` +
        `keypair rotation in target/deploy/*-keypair.json on next deploy).`
    );
    ids = ids.filter((i) => !collisions.includes(i));
  }

  if (ids.length === 0) {
    logger.warning('No program IDs left to close.');
    return;
  }

  // 3. Fetch on-chain status for each.
  logger.info(`Inspecting ${ids.length} program(s) on ${network} (source: ${source})...`);
  const shows: ProgramShow[] = ids.map((id) => programShow(id, url));

  // Filter into actionable buckets.
  const skipClosed = shows.filter((s) => s.closed);
  const skipForeign = shows.filter(
    (s) => !s.closed && s.authority && !s.authority.equals(wallet)
  );
  const skipUnreadable = shows.filter((s) => s.error);
  const toClose = shows.filter(
    (s) => !s.closed && !s.error && s.authority?.equals(wallet)
  );

  // 4. Summary block.
  const summaryRows: Record<string, string> = {
    'network': network,
    'cluster (--url)': url,
    'deployer wallet': wallet.toBase58(),
    'targets (input)': String(ids.length),
    'already closed (skip)': String(skipClosed.length),
    'foreign authority (skip)': String(skipForeign.length),
    'unreadable (skip)': String(skipUnreadable.length),
    'to close': String(toClose.length),
  };
  const totalToRecover = toClose.reduce(
    (a, s) => a + s.balanceLamports,
    0n
  );
  summaryRows['estimated rent to recover (SOL)'] = fmtSol(totalToRecover);

  for (const s of toClose) {
    summaryRows[`  close ${s.programId.toBase58().slice(0, 8)}…`] =
      `balance=${fmtSol(s.balanceLamports)} SOL  dataLen=${s.dataLength}`;
  }
  for (const s of skipClosed) {
    summaryRows[`  skip  ${s.programId.toBase58().slice(0, 8)}…`] = 'already closed';
  }
  for (const s of skipForeign) {
    summaryRows[`  skip  ${s.programId.toBase58().slice(0, 8)}…`] =
      `foreign authority ${s.authority?.toBase58().slice(0, 8) ?? '(none)'}…`;
  }
  for (const s of skipUnreadable) {
    summaryRows[`  skip  ${s.programId.toBase58().slice(0, 8)}…`] =
      `unreadable: ${s.error?.slice(0, 50) ?? 'unknown'}`;
  }

  logger.info(summaryBlock('close-programs plan', summaryRows));

  if (toClose.length === 0) {
    logger.success('Nothing to do — all targets are already closed, foreign, or unreadable.');
    return;
  }

  if (isDryRun()) {
    logger.success('--dry-run set; not submitting.');
    return;
  }

  await confirmIfMainnet(
    network,
    `close-programs on mainnet — recovers ${fmtSol(totalToRecover)} SOL ` +
      `across ${toClose.length} program(s)`
  );

  // 5. Record pre-close wallet balance for end-of-run reconciliation.
  const balBefore = await getBalance(provider.connection, wallet);

  // 6. Run `solana program close` per ID, capturing output.
  let successCount = 0;
  let failCount = 0;
  for (const s of toClose) {
    const id = s.programId.toBase58();
    logger.info(`Closing ${id} (expected rent ${fmtSol(s.balanceLamports)} SOL)...`);
    try {
      const stdout = execSync(
        `solana program close ${id} --bypass-warning ` +
          `--recipient ${wallet.toBase58()} --url ${url}`,
        { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' }
      );
      // `solana program close` prints "Closed Program Id <id>, ..."
      logger.success(`closed ${id}: ${stdout.trim().split('\n').slice(-1)[0]}`);
      successCount += 1;
    } catch (e: any) {
      const msg = (e?.stderr ?? e?.stdout ?? String(e)).toString();
      logger.error(`close ${id} failed: ${msg.trim().slice(0, 240)}`);
      failCount += 1;
    }
  }

  // 7. Report recovered SOL.
  const balAfter = await getBalance(provider.connection, wallet);
  const recovered = balAfter - balBefore;
  logger.info(
    summaryBlock('close-programs result', {
      'closed': `${successCount} / ${toClose.length}`,
      'failed': String(failCount),
      'wallet before (SOL)': fmtSol(balBefore),
      'wallet after (SOL)': fmtSol(balAfter),
      'recovered (SOL)': fmtSol(recovered),
      'note': 'deployments/<network>.json was NOT modified — run `deploy:init` to overwrite, or rm manually.',
    })
  );
  if (failCount > 0) process.exit(1);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
