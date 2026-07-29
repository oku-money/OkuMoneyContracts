/**
 * Shared safety helpers for admin scripts.
 *
 * Every admin script that mutates on-chain state should:
 *   1. Print a human-readable summary of WHAT it's about to do.
 *   2. Honor `--dry-run` (don't submit, just simulate).
 *   3. On `mainnet-beta` / `mainnet-fork`, require an explicit
 *      `--yes-i-mean-it-on-mainnet` flag (or stdin "yes" prompt).
 *
 * This file owns those checks so individual admin scripts stay focused
 * on their target instruction.
 */

import * as readline from 'readline';
import type { NetworkName } from '../../config/networks';
import { verifyCluster } from '../../utils/network';
import { Connection } from '@solana/web3.js';

/**
 * True if a dry run was requested, via either the `--dry-run` CLI flag
 * OR the `DRY_RUN=true` environment variable.
 *
 * Both conventions exist across this repo's scripts (some non-admin
 * scripts, e.g. bridge-svm-evm.ts, historically only supported the env
 * var). Supporting both here prevents an operator who reaches for the
 * "wrong" convention from silently executing a real, non-simulated
 * mutation. This bit us for real once: `DRY_RUN=true tsx
 * scripts/admin/grant-roles.ts` (no `--dry-run` flag) submitted 9 live
 * role-rotation transactions against devnet because only the flag was
 * checked.
 */
export function isDryRun(): boolean {
  return process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
}

/**
 * Prompt the operator before submitting an irreversible mainnet tx.
 *
 * On mainnet networks, requires either:
 *   - the `--yes-i-mean-it-on-mainnet` flag, OR
 *   - an interactive `yes` typed into stdin.
 *
 * On devnet/localnet, no-op.
 */
export async function confirmIfMainnet(
  network: NetworkName,
  summary: string,
  /** Optional connection for genesis-hash cluster verification (WS5.6). */
  connection?: Connection
): Promise<void> {
  const isMainnet =
    network === 'mainnet-beta' || network === 'mainnet-fork';
  if (!isMainnet) return;

  // WS5.6: verify cluster genesis hash to catch wrong-cluster RPC misconfigurations.
  if (connection) {
    await verifyCluster(connection, network);
  }

  if (process.argv.includes('--yes-i-mean-it-on-mainnet')) return;

  console.log('');
  console.log('================================================================');
  console.log('  MAINNET CHANGE — confirm before submitting');
  console.log('================================================================');
  console.log(summary);
  console.log('');
  console.log('Type "yes" to proceed, anything else to abort:');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const answer: string = await new Promise((resolve) => {
    rl.question('> ', (a) => {
      rl.close();
      resolve(a.trim().toLowerCase());
    });
  });

  if (answer !== 'yes') {
    console.log('Aborted.');
    process.exit(0);
  }
}

/**
 * Print a key/value summary block prefixed with a banner. Useful as the
 * argument to `confirmIfMainnet`.
 */
export function summaryBlock(title: string, kv: Record<string, string>): string {
  const lines = [`${title}`, ''];
  for (const [k, v] of Object.entries(kv)) {
    lines.push(`  ${k.padEnd(28)} ${v}`);
  }
  return lines.join('\n');
}
