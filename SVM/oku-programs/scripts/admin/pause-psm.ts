/**
 * Pause the PSM (emergency lever).
 * Wraps `lite_psm::pause` (pauser-gated).
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/pause-psm.ts
 *   NETWORK=mainnet-beta tsx scripts/admin/pause-psm.ts --yes-i-mean-it-on-mainnet
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

async function main() {
  const network = detectNetwork();
  logger.header(`pause PSM (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) throw new Error(`No deployment for ${network}.`);

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  if (cfg.isPaused) {
    logger.warning('PSM already paused — no-op.');
    return;
  }
  logger.info(
    summaryBlock('pause()', {
      'config PDA': psmConfig.toBase58(),
      'signer (pauser)': provider.wallet.publicKey.toBase58(),
    })
  );
  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, 'EMERGENCY: pause the PSM on mainnet');

  const sig = await program.methods
    .pause()
    .accountsPartial({ pauser: provider.wallet.publicKey, config: psmConfig })
    .rpc();
  logger.success(`tx: ${sig}`);
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Failed: ${err.message ?? String(err)}`);
  console.error(err);
  process.exit(1);
});
