/**
 * Unpause the bridge. Wraps `lite_psm::unpause_bridge` (bridge_unpauser-gated).
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { deriveBridgeConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

async function main() {
  const network = detectNetwork();
  logger.header(`unpause bridge (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) throw new Error(`No deployment for ${network}.`);

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  const cfg = await program.account.bridgeConfig.fetch(bridgeConfig);
  if (!cfg.isPaused) {
    logger.warning('Bridge is not paused — no-op.');
    return;
  }
  logger.info(
    summaryBlock('unpauseBridge()', {
      'bridge config PDA': bridgeConfig.toBase58(),
      'signer (bridge_unpauser)': provider.wallet.publicKey.toBase58(),
    })
  );
  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, 'Unpause the bridge on mainnet');

  const sig = await program.methods
    .unpauseBridge()
    .accountsPartial({
      bridgeUnpauser: provider.wallet.publicKey,
      bridgeConfig,
    })
    .rpc();
  logger.success(`tx: ${sig}`);
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Failed: ${err.message ?? String(err)}`);
  console.error(err);
  process.exit(1);
});
