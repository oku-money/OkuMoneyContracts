/**
 * Program build utilities.
 *
 * A fork build compiles the programs under the FORK program ids: the fork
 * keypairs are copied over `target/deploy/<prog>-keypair.json` and
 * `anchor keys sync` rewrites `declare_id!` and `Anchor.toml` to match. All of
 * that mutates the live workspace, so it must be undone on every exit path —
 * a leftover fork keypair or fork `declare_id!` is exactly what lets a later
 * live upgrade compile for the wrong id (audit U-04). `withForkBuild` owns
 * that lifecycle: it records each live keypair (or its absence) BEFORE the
 * first mutation and restores in `finally`, including deleting keypairs that
 * did not exist, then re-syncs ids.
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync, unlinkSync, copyFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger';

const PROGRAMS = ['lite_psm'];

/** prog -> original keypair bytes, or null if no live keypair existed. */
export type KeypairBackup = Record<string, Buffer | null>;

function livePath(prog: string): string {
  return join(process.cwd(), 'target/deploy', `${prog}-keypair.json`);
}

/** Snapshot the live keypairs (or their absence). Call before any mutation. */
export function backupLiveKeypairs(): KeypairBackup {
  const backup: KeypairBackup = {};
  for (const prog of PROGRAMS) {
    const p = livePath(prog);
    backup[prog] = existsSync(p) ? readFileSync(p) : null;
  }
  return backup;
}

/** Put the live keypairs back exactly as they were, then re-sync ids. */
export function restoreOriginalKeypairs(backup: KeypairBackup): void {
  logger.info('Restoring live program keypairs and declare_id!...');
  for (const [prog, data] of Object.entries(backup)) {
    const p = livePath(prog);
    if (data === null) {
      if (existsSync(p)) unlinkSync(p);
    } else {
      writeFileSync(p, data);
    }
  }
  // Always re-sync: `anchor keys sync` may have rewritten declare_id! and
  // Anchor.toml even if the build itself failed. With an absent keypair there
  // is nothing to sync from, so the operator is told to check by hand.
  if (Object.values(backup).every((d) => d !== null)) {
    execSync('anchor keys sync', { stdio: 'pipe' });
  } else {
    logger.warning(
      'No live keypair existed before the fork build; check declare_id! and Anchor.toml ' +
        'against deployments/<network>.json (git diff programs/ Anchor.toml).'
    );
  }
}

function anchorBuild(): void {
  logger.info('Running anchor build...');
  execSync('anchor build', { stdio: 'inherit' });
  logger.success('Programs built');
}

/**
 * Live build: `anchor build` against the live ids. Fork build: swap in the
 * fork keypairs, sync, build, run `fn` (the fork deploy), then restore — on
 * success AND on any failure.
 */
export async function withProgramsBuilt<T>(isFork: boolean, fn: () => Promise<T>): Promise<T> {
  logger.nextStep('Building Programs');
  if (!isFork) {
    anchorBuild();
    return fn();
  }

  const backup = backupLiveKeypairs();
  try {
    logger.info('Preparing fork build...');
    for (const prog of PROGRAMS) {
      const forkPath = join(process.cwd(), 'target/deploy-fork', `${prog}-keypair.json`);
      if (!existsSync(forkPath)) {
        throw new Error(`Fork keypair not found: ${forkPath}. Run: solana-keygen new -o ${forkPath}`);
      }
      copyFileSync(forkPath, livePath(prog));
    }
    logger.info('Syncing program IDs...');
    execSync('anchor keys sync', { stdio: 'pipe' });
    anchorBuild();
    return await fn();
  } finally {
    restoreOriginalKeypairs(backup);
  }
}
