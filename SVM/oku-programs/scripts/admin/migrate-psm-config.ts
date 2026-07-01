/**
 * One-time PsmConfig migration: realloc 674 -> 714 bytes.
 *
 * Extends PsmConfig to accommodate `direct_minter` + `direct_minter_allowance`
 * fields. Must be run after upgrading the lite-psm program bytecode and before
 * any instruction that deserializes the new PsmConfig layout.
 *
 * The migration is idempotent: reverts with `MigrationNotNeeded` if the
 * account is already at the new size.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/migrate-psm-config.ts
 *   --dry-run     do not submit
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

async function main() {
  const network = detectNetwork();
  logger.header(`migrate_psm_config (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  // Check current account size
  const accountInfo = await provider.connection.getAccountInfo(psmConfig);
  if (!accountInfo) throw new Error('PsmConfig account not found — PSM not initialized?');

  logger.info(
    summaryBlock('migrate_psm_config()', {
      'config PDA': psmConfig.toBase58(),
      'current account size': `${accountInfo.data.length} bytes`,
      'target account size': '714 bytes',
      'signer (role_admin)': provider.wallet.publicKey.toBase58(),
      'payer': provider.wallet.publicKey.toBase58(),
    })
  );

  if (accountInfo.data.length === 714) {
    logger.success('PsmConfig is already at 714 bytes — migration not needed.');
    return;
  }
  if (accountInfo.data.length !== 674) {
    throw new Error(
      `Unexpected account size: ${accountInfo.data.length}. Expected 674 (pre-migration) or 714 (post-migration).`
    );
  }

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    'migrate_psm_config() on mainnet — extends PsmConfig from 674 to 714 bytes (irreversible)'
  );

  const sig = await program.methods
    .migratePsmConfig()
    .accountsPartial({
      payer: provider.wallet.publicKey,
      roleAdmin: provider.wallet.publicKey,
      config: psmConfig,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  logger.success(`tx: ${sig}`);

  // Verify
  const after = await provider.connection.getAccountInfo(psmConfig);
  if (!after) throw new Error('PsmConfig account not found after migration?!');
  logger.info(`post-migration account size: ${after.data.length} bytes`);
  if (after.data.length !== 714) {
    throw new Error(`Migration failed: account size is ${after.data.length}, expected 714.`);
  }
  logger.success('PsmConfig migration complete.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
