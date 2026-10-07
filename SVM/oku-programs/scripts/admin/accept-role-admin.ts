/**
 * Second step of the two-step `role_admin` rotation: `accept_role_admin`,
 * signed by the PENDING admin (see admin:set-authority --role=roleAdmin).
 *
 * Usage:
 *   # The pending admin is this wallet (devnet / an EOA): sends it.
 *   NETWORK=devnet tsx scripts/admin/accept-role-admin.ts
 *
 *   # The pending admin is a Squads vault: prints the instruction to put in a
 *   # Squads vault transaction (program, accounts, data). Sends nothing.
 *   NETWORK=mainnet-beta tsx scripts/admin/accept-role-admin.ts --emit
 *
 * Afterwards it (or a re-run) verifies `role_admin == <new admin>` and
 * `pending_role_admin` is cleared.
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
  logger.header(`accept role_admin (${network})`);
  const provider = await createProviderWithClusterCheck(network);
  anchor.setProvider(provider);
  const deployment = loadDeploymentStrict(network);
  const litePsmId = new PublicKey(deployment.programs.litePsm!);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [config] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(config);
  const pending = cfg.pendingRoleAdmin as PublicKey;
  if (pending.equals(PublicKey.default)) {
    logger.info(`No transfer pending; role_admin is ${cfg.roleAdmin.toBase58()}.`);
    return;
  }
  logger.info(
    summaryBlock('accept_role_admin()', {
      'config PDA': config.toBase58(),
      'current role_admin': cfg.roleAdmin.toBase58(),
      'pending role_admin (signer)': pending.toBase58(),
    })
  );

  const ix = await program.methods
    .acceptRoleAdmin()
    .accountsPartial({ newRoleAdmin: pending, config })
    .instruction();

  if (process.argv.includes('--emit') || !pending.equals(provider.wallet.publicKey)) {
    if (!process.argv.includes('--emit')) {
      logger.warning(`This wallet is not the pending admin; printing the instruction instead (--emit).`);
    }
    printInstructionForMultisig(ix, `accept_role_admin — sign as ${pending.toBase58()}`);
    return;
  }
  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, `accept role_admin as ${pending.toBase58()}`, provider.connection);
  const sig = await program.methods.acceptRoleAdmin().accountsPartial({ newRoleAdmin: pending, config }).rpc();
  logger.success(`tx: ${sig}`);

  const after = await program.account.psmConfig.fetch(config);
  if (!after.roleAdmin.equals(pending) || !after.pendingRoleAdmin.equals(PublicKey.default)) {
    throw new Error(`role_admin is ${after.roleAdmin.toBase58()}, pending ${after.pendingRoleAdmin.toBase58()}`);
  }
  logger.success(`role_admin is now ${pending.toBase58()}; nothing pending.`);
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Failed: ${err.message ?? String(err)}`);
  process.exit(1);
});
