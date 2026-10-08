/**
 * Unpause the PSM. Wraps `lite_psm::unpause` (unpauser-gated; on mainnet
 * this should be the cold multisig).
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/unpause-psm.ts [--dry-run]
 *   NETWORK=mainnet-beta tsx scripts/admin/unpause-psm.ts --yes-i-mean-it-on-mainnet
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeploymentStrict } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { resolveRoleSigner, describeRoleSigner } from '../utils/roleSigner';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

async function main() {
  const network = detectNetwork();
  logger.header(`unpause PSM (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeploymentStrict(network);
  if (!deployment?.programs?.litePsm) throw new Error(`No deployment for ${network}.`);

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  if (!cfg.isPaused) {
    logger.warning('PSM is not paused — no-op.');
    return;
  }
  const unpauser = resolveRoleSigner(provider, cfg, 'unpauser');
  logger.info(
    summaryBlock('unpause()', {
      'config PDA': psmConfig.toBase58(),
      'signer (unpauser)': describeRoleSigner('unpauser', unpauser),
    })
  );
  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, 'Unpause the PSM on mainnet (resumes mints/redeems)', provider.connection);

  const sig = await program.methods
    .unpause()
    .accountsPartial({ unpauser: unpauser.authority, config: psmConfig })
    .signers(unpauser.signers)
    .rpc();
  logger.success(`tx: ${sig}`);
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Failed: ${err.message ?? String(err)}`);
  console.error(err);
  process.exit(1);
});
