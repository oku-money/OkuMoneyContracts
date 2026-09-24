/**
 * Transfer or disable the BPFLoaderUpgradeable upgrade authority for a program.
 *
 * The operational complement to `anchor upgrade`: after deploying a new
 * version, the upgrade authority should be transferred to a Squads multisig
 * (production) or left on the developer keypair (testnet).
 *
 * Usage:
 *   # Transfer authority to a multisig
 *   NETWORK=devnet tsx scripts/admin/set-upgrade-authority.ts \
 *     --program=<LITE_PSM_PROGRAM_ID> --new-authority=<SQUADS_WALLET>
 *
 *   # Disable upgrades (irreversible! program becomes immutable)
 *   NETWORK=mainnet-beta tsx scripts/admin/set-upgrade-authority.ts \
 *     --program=<LITE_PSM_PROGRAM_ID> --disable \
 *     --yes-i-mean-it-on-mainnet
 *
 *   # Dry-run (inspect current authority without changing anything)
 *   NETWORK=devnet tsx scripts/admin/set-upgrade-authority.ts \
 *     --program=<LITE_PSM_PROGRAM_ID> --new-authority=<TARGET> --dry-run
 *
 * The script uses `solana program set-upgrade-authority` via a child process.
 * Ensure the active CLI keypair (WALLET_PATH or ~/.config/solana/id.json) holds
 * the current upgrade authority for the target program.
 */

import { execSync } from 'child_process';
import { Connection, PublicKey } from '@solana/web3.js';
import { createProvider, detectNetwork } from '../utils/network';
import { logger } from '../utils/logger';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';
import { NETWORK_CONFIGS } from '../config/networks';

async function main() {
  const network = detectNetwork();
  logger.header(`set-upgrade-authority (${network})`);

  // Parse CLI args
  const args = process.argv.slice(2);
  const programArg = args.find((a) => a.startsWith('--program='));
  const newAuthArg  = args.find((a) => a.startsWith('--new-authority='));
  const disableFlag = args.includes('--disable');

  if (!programArg) {
    throw new Error('--program=<PROGRAM_ID> is required');
  }
  if (!disableFlag && !newAuthArg) {
    throw new Error('Either --new-authority=<PUBKEY> or --disable must be specified');
  }
  if (disableFlag && newAuthArg) {
    throw new Error('--disable and --new-authority are mutually exclusive');
  }

  const programId = programArg.split('=')[1];
  const newAuthority = newAuthArg ? newAuthArg.split('=')[1] : null;

  // Validate pubkeys
  new PublicKey(programId); // throws if invalid
  if (newAuthority) new PublicKey(newAuthority);

  const provider = createProvider(network);
  const config   = NETWORK_CONFIGS[network];

  // Read current upgrade authority from on-chain program data
  let currentAuthority = '<unknown>';
  try {
    const output = execSync(
      `solana program show ${programId} --url ${config.cluster}`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const authMatch = output.match(/Upgrade Authority:\s+(\S+)/);
    if (authMatch) currentAuthority = authMatch[1];
  } catch {
    logger.warning('Could not fetch current upgrade authority — proceeding anyway.');
  }

  const summary = summaryBlock('set-upgrade-authority', {
    network:             network,
    program:             programId,
    'current authority': currentAuthority,
    'new authority':     newAuthority ?? '(DISABLE — IRREVERSIBLE)',
    'signer (current)':  provider.wallet.publicKey.toBase58(),
  });
  logger.info(summary);

  if (isDryRun()) {
    logger.success('--dry-run: no transaction submitted.');
    return;
  }

  await confirmIfMainnet(
    network,
    disableFlag
      ? `⚠️  DISABLING upgrade authority for ${programId} on MAINNET — IRREVERSIBLE!`
      : `Transferring upgrade authority for ${programId} to ${newAuthority} on MAINNET`,
    provider.connection
  );

  // Build the CLI command
  const walletFlag = process.env.WALLET_PATH
    ? `--keypair ${process.env.WALLET_PATH}`
    : '';
  const cmd = disableFlag
    ? `solana program set-upgrade-authority ${programId} --final --url ${config.cluster} ${walletFlag}`
    : `solana program set-upgrade-authority ${programId} ${newAuthority} --url ${config.cluster} ${walletFlag}`;

  logger.info(`Running: ${cmd}`);
  try {
    const output = execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    logger.success(`Done:\n${output.trim()}`);
  } catch (err: any) {
    const msg = err?.stderr ?? err?.stdout ?? String(err);
    throw new Error(`solana CLI failed:\n${msg}`);
  }
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Failed: ${err.message ?? String(err)}`);
  console.error(err);
  process.exit(1);
});
