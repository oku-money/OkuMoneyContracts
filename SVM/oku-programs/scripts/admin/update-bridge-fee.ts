/**
 * Update the bridge fee (bps charged on `bridge_burn`).
 *
 * Wraps `lite_psm::update_bridge_fee` (fee_manager-gated). Accepts a
 * basis-point value in `[0, 10_000]`; the handler clamps via
 * `InvalidFeeBps`. Mirrors EVM `OkuBridge.updateBridgeFee`.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/update-bridge-fee.ts --bps=<0..10000>
 *   NETWORK=mainnet-beta tsx scripts/admin/update-bridge-fee.ts \
 *       --bps=<0..10000> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
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

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`update_bridge_fee (${network})`);

  const bpsArg = parseArg('bps');
  if (bpsArg === undefined) throw new Error('Required: --bps=<0..10000>');
  const bps = Number(bpsArg);
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
    throw new Error('--bps must be an integer in [0, 10000].');
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
    summaryBlock('update_bridge_fee()', {
      'bridge_config PDA': bridgeConfig.toBase58(),
      'current bps': String(cfg.bridgeFeeBps),
      'new bps': String(bps),
      'signer (fee_manager)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `update_bridge_fee(${bps} bps) on mainnet — affects every subsequent bridge_burn`
  );

  const sig = await program.methods
    .updateBridgeFee(bps)
    .accountsPartial({
      feeManager: provider.wallet.publicKey,
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
