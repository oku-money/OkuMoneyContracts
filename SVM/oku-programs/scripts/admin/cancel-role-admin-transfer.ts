/**
 * Abort a pending `role_admin` rotation: `cancel_role_admin_transfer`, signed
 * by the CURRENT role_admin. Use when the proposed address is wrong.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/cancel-role-admin-transfer.ts
 *   NETWORK=mainnet-beta tsx scripts/admin/cancel-role-admin-transfer.ts --emit   # Squads
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProviderWithClusterCheck, detectNetwork } from '../utils/network';
import { loadDeploymentStrict } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';
import { printInstructionForMultisig } from './_lib/emit';

async function main() {
  const network = detectNetwork();
  logger.header(`cancel role_admin transfer (${network})`);
  const provider = await createProviderWithClusterCheck(network);
  anchor.setProvider(provider);
  const deployment = loadDeploymentStrict(network);
  const litePsmId = new PublicKey(deployment.programs.litePsm!);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [config] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(config);
  if (cfg.pendingRoleAdmin.equals(PublicKey.default)) {
    logger.info('No transfer pending; nothing to cancel.');
    return;
  }
  const admin = cfg.roleAdmin as PublicKey;
  logger.info(
    summaryBlock('cancel_role_admin_transfer()', {
      'config PDA': config.toBase58(),
      'role_admin (signer)': admin.toBase58(),
      'pending (to clear)': cfg.pendingRoleAdmin.toBase58(),
    })
  );
  const ix = await program.methods
    .cancelRoleAdminTransfer()
    .accountsPartial({ roleAdmin: admin, config })
    .instruction();
  if (process.argv.includes('--emit') || !admin.equals(provider.wallet.publicKey)) {
    printInstructionForMultisig(ix, `cancel_role_admin_transfer — sign as ${admin.toBase58()}`);
    return;
  }
  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, 'cancel the pending role_admin transfer', provider.connection);
  const sig = await program.methods.cancelRoleAdminTransfer().accountsPartial({ roleAdmin: admin, config }).rpc();
  logger.success(`tx: ${sig}`);
  const after = await program.account.psmConfig.fetch(config);
  if (!after.pendingRoleAdmin.equals(PublicKey.default)) throw new Error('pending_role_admin was not cleared');
  logger.success('Pending transfer cleared.');
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Failed: ${err.message ?? String(err)}`);
  process.exit(1);
});
