/**
 * Transfer (or remove) the BPFLoaderUpgradeable upgrade authority of a program.
 *
 * Mainnet ordering (README § Mainnet ceremony): `initialize` requires the
 * signer to BE the upgrade authority, so transfer only after `initialize`,
 * and after the cold vault has accepted `role_admin` — the deployer stays a
 * recovery path until then. After the transfer, upgrades go through
 * `MODE=propose` in scripts/upgrade/index.ts.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-upgrade-authority.ts \
 *     --program=<PROGRAM_ID> --new-authority=<SQUADS_VAULT> --confirm=<SQUADS_VAULT>
 *
 *   # Irreversible: program becomes immutable
 *   NETWORK=mainnet-beta tsx scripts/admin/set-upgrade-authority.ts \
 *     --program=<PROGRAM_ID> --disable --yes-i-mean-it-on-mainnet
 *
 *   --dry-run prints the current and new authority and sends nothing.
 *
 * The new authority (a Squads vault PDA) cannot co-sign, so the CLI's
 * new-authority signer check is skipped; `--confirm=<same pubkey>` is required
 * instead so a mistyped address cannot strand the program. The CLI is given
 * the wallet explicitly (`--keypair`), never its own config.yml default.
 */

import { execFileSync } from 'child_process';
import { PublicKey } from '@solana/web3.js';
import { createProviderWithClusterCheck, detectNetwork, walletPath } from '../utils/network';
import { logger } from '../utils/logger';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';
import { getUpgradeAuthority } from '../upgrade/lib/elfCompare';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];

async function main() {
  const network = detectNetwork();
  logger.header(`set-upgrade-authority (${network})`);

  const programArg = arg('program');
  const newAuthArg = arg('new-authority');
  const disable = process.argv.includes('--disable');
  if (!programArg) throw new Error('--program=<PROGRAM_ID> is required');
  if (disable === !!newAuthArg) throw new Error('Pass exactly one of --new-authority=<PUBKEY> or --disable');

  const programId = new PublicKey(programArg);
  const newAuthority = newAuthArg ? new PublicKey(newAuthArg) : null;
  if (newAuthority && arg('confirm') !== newAuthority.toBase58()) {
    throw new Error('--confirm=<new authority> must repeat --new-authority exactly');
  }

  const provider = await createProviderWithClusterCheck(network);
  const conn = provider.connection;
  const wallet = provider.wallet.publicKey;
  const current = await getUpgradeAuthority(conn, programId);
  if (!current) throw new Error(`${programId.toBase58()} is already immutable`);
  if (!current.equals(wallet)) {
    throw new Error(`Current authority is ${current.toBase58()}, not this wallet (${wallet.toBase58()})`);
  }

  const summary = summaryBlock('set-upgrade-authority', {
    network,
    program: programId.toBase58(),
    'current authority': current.toBase58(),
    'new authority': newAuthority?.toBase58() ?? '(NONE — PROGRAM BECOMES IMMUTABLE)',
    signer: `${wallet.toBase58()} (${walletPath()})`,
  });
  logger.info(summary);
  if (isDryRun()) {
    logger.success('--dry-run: nothing sent.');
    return;
  }
  await confirmIfMainnet(network, summary, conn);

  const url = network === 'localnet' ? 'localhost' : conn.rpcEndpoint;
  const args = ['program', 'set-upgrade-authority', programId.toBase58()];
  if (newAuthority) {
    args.push('--new-upgrade-authority', newAuthority.toBase58(), '--skip-new-upgrade-authority-signer-check');
  } else {
    args.push('--final');
  }
  args.push('--keypair', walletPath(), '--url', url);
  logger.info(`$ solana ${args.join(' ')}`);
  try {
    logger.info(execFileSync('solana', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] }).trim());
  } catch (err: any) {
    throw new Error(`solana CLI failed:\n${err?.stderr ?? err?.stdout ?? err}`);
  }

  const after = await getUpgradeAuthority(conn, programId);
  const ok = newAuthority ? after?.equals(newAuthority) : after === null;
  if (!ok) throw new Error(`On-chain authority is ${after?.toBase58() ?? '<none>'} after the transfer`);
  logger.success(`Upgrade authority is now ${after?.toBase58() ?? '<none> (immutable)'}`);
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Failed: ${err.message ?? String(err)}`);
  process.exit(1);
});
