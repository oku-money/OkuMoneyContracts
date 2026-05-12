/**
 * Update the bridge min/max per-tx amount limits.
 *
 * Wraps `lite_psm::update_bridge_limits` (limits_manager-gated). The
 * handler requires `min <= max`; both bounds apply only on `bridge_burn`
 * (the SVM-burn->EVM-mint direction). Per Phase 8 the EVM-burn->SVM-mint
 * direction (`bridge_mint`) intentionally does NOT re-validate limits.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/update-bridge-limits.ts \
 *       --min=<6dec> --max=<6dec>
 *   NETWORK=mainnet-beta tsx scripts/admin/update-bridge-limits.ts \
 *       --min=<6dec> --max=<6dec> --yes-i-mean-it-on-mainnet
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
  logger.header(`update_bridge_limits (${network})`);

  const minArg = parseArg('min');
  const maxArg = parseArg('max');
  if (!minArg || !maxArg) {
    throw new Error('Required: --min=<6dec> --max=<6dec>');
  }
  const minAmount = new BN(minArg);
  const maxAmount = new BN(maxArg);
  if (minAmount.isNeg() || maxAmount.isNeg()) {
    throw new Error('--min and --max must be >= 0.');
  }
  if (minAmount.gt(maxAmount)) {
    throw new Error(`--min (${minAmount}) must be <= --max (${maxAmount}).`);
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
    summaryBlock('update_bridge_limits()', {
      'bridge_config PDA': bridgeConfig.toBase58(),
      'current min': cfg.minBridgeAmount.toString(),
      'current max': cfg.maxBridgeAmount.toString(),
      'new min': minAmount.toString(),
      'new max': maxAmount.toString(),
      'signer (limits_manager)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `update_bridge_limits(min=${minAmount}, max=${maxAmount}) on mainnet`
  );

  const sig = await program.methods
    .updateBridgeLimits(minAmount, maxAmount)
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
