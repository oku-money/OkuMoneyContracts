/**
 * Program build utilities
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { logger } from '../../utils/logger';

const PROGRAMS = ['lite_psm', 'oku_dollar', 'oku_bridge_router'];

/**
 * Build programs, optionally swapping keypairs for fork deployment
 */
export async function buildPrograms(isFork: boolean): Promise<{ originalKeypairs: Record<string, Buffer> }> {
  logger.nextStep('Building Programs');

  const keypairDir = isFork ? 'target/deploy-fork' : 'target/deploy';
  const originalKeypairs: Record<string, Buffer> = {};

  if (isFork) {
    // For fork: swap keypairs, sync, build
    logger.info('Preparing fork build...');

    // Backup original keypairs and copy fork keypairs
    for (const prog of PROGRAMS) {
      const originalPath = join(process.cwd(), 'target/deploy', `${prog}-keypair.json`);
      const forkPath = join(process.cwd(), keypairDir, `${prog}-keypair.json`);

      if (!existsSync(forkPath)) {
        throw new Error(`Fork keypair not found: ${forkPath}. Run: solana-keygen new -o ${forkPath}`);
      }

      if (existsSync(originalPath)) {
        originalKeypairs[prog] = readFileSync(originalPath);
      }

      execSync(`cp ${forkPath} ${originalPath}`);
    }

    // Sync declare_id! macros to match fork keypairs
    logger.info('Syncing program IDs...');
    execSync('anchor keys sync', { stdio: 'pipe' });

    // Build
    logger.info('Running anchor build...');
    execSync('anchor build', { stdio: 'inherit' });
    logger.success('Programs built');
  } else {
    // Standard build
    logger.info('Running anchor build...');
    execSync('anchor build', { stdio: 'inherit' });
    logger.success('Programs built');
  }

  return { originalKeypairs };
}

/**
 * Restore original keypairs after fork deployment
 */
export function restoreOriginalKeypairs(originalKeypairs: Record<string, Buffer>): void {
  if (Object.keys(originalKeypairs).length === 0) return;
  
  logger.info('Restoring original keypairs...');
  for (const [prog, data] of Object.entries(originalKeypairs)) {
    const originalPath = join(process.cwd(), 'target/deploy', `${prog}-keypair.json`);
    writeFileSync(originalPath, data);
  }
  execSync('anchor keys sync', { stdio: 'pipe' });
}
