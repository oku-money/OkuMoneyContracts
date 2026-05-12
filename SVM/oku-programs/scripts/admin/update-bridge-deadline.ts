/**
 * Update the bridge deadline (seconds added to `Clock::unix_timestamp`
 * at burn time to derive the request's expiration).
 *
 * Wraps `lite_psm::update_bridge_deadline` (limits_manager-gated). The
 * handler enforces `BRIDGE_DEADLINE_MIN_SECS..BRIDGE_DEADLINE_MAX_SECS`.
 * Only affects burns submitted AFTER this call — already-in-flight
 * requests keep their original deadline.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/update-bridge-deadline.ts --secs=3600
 *   NETWORK=mainnet-beta tsx scripts/admin/update-bridge-deadline.ts \
 *       --secs=3600 --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { deriveBridgeConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`update_bridge_deadline (${network})`);

  const secsArg = parseArg('secs');
  if (!secsArg) throw new Error('Required: --secs=<positive integer>');
  const secs = new BN(secsArg);
  if (secs.isNeg() || secs.isZero()) {
    throw new Error('--secs must be > 0.');
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  const cfg = await program.account.bridgeConfig.fetch(bridgeConfig);
  logger.info(
    summaryBlock('update_bridge_deadline()', {
      'bridge_config PDA': bridgeConfig.toBase58(),
      'current deadline_secs': cfg.bridgeDeadlineSecs.toString(),
      'new deadline_secs': secs.toString(),
      'signer (limits_manager)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `update_bridge_deadline(${secs.toString()}s) on mainnet — affects new burns only`
  );

  const sig = await program.methods
    .updateBridgeDeadline(secs)
    .accountsPartial({
      limitsManager: provider.wallet.publicKey,
      bridgeConfig,
    })
    .rpc();
  logger.success(`tx: ${sig}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
