/**
 * Grow the `psm_config` PDA to the current `PsmConfig::LEN`.
 *
 * One-shot migration for a deployment that predates `PsmConfig::reserved`.
 * Idempotent — a no-op once the account is already at the target size, so it is
 * safe to re-run.
 *
 * Usage:
 *   NETWORK=devnet npx tsx scripts/admin/migrate-config-space.ts [--dry-run]
 */
import * as anchor from '@coral-xyz/anchor';
import { PublicKey, SystemProgram } from '@solana/web3.js';

import { LitePsm } from '../../target/types/lite_psm';
import { detectNetwork, createProvider } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { logger } from '../utils/logger';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';
import { PSM_CONFIG_LEN } from '../lib/account-sizes';

async function main() {
  const network = detectNetwork();
  logger.header(`migrate config space (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);

  const deployment = loadDeployment(network);
  const programId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as anchor.Program<LitePsm>;
  const [configPda] = derivePsmConfigPDA(programId);

  const before = await provider.connection.getAccountInfo(configPda);
  if (!before) throw new Error(`psm_config not found at ${configPda.toBase58()}`);

  logger.info(
    summaryBlock('migrate config space', {
      'config PDA': configPda.toBase58(),
      'current size': `${before.data.length} bytes`,
      'target size': `${PSM_CONFIG_LEN} bytes`,
      'signer (role_admin)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (before.data.length === PSM_CONFIG_LEN) {
    logger.success(`Already ${PSM_CONFIG_LEN} bytes — nothing to do.`);
    return;
  }

  if (isDryRun()) {
    logger.success('--dry-run set; not submitting.');
    return;
  }

  await confirmIfMainnet(network, 'resize psm_config', provider.connection);

  const sig = await program.methods
    .migrateConfigSpace()
    .accountsPartial({
      roleAdmin: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      config: configPda,
      systemProgram: SystemProgram.programId,
    })
    .rpc();

  logger.success(`tx: ${sig}`);

  const after = await provider.connection.getAccountInfo(configPda);
  logger.info(`size ${before.data.length} -> ${after!.data.length} bytes`);
  if (after!.data.length !== PSM_CONFIG_LEN) {
    throw new Error(`expected ${PSM_CONFIG_LEN} bytes, got ${after!.data.length}`);
  }
  logger.success('psm_config resized');
}

main().catch((e) => {
  logger.error(e.message ?? String(e));
  process.exit(1);
});
