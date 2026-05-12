/**
 * Update the bridge fee-recipient address.
 *
 * Wraps `lite_psm::update_fee_recipient` (fee_manager-gated). Refuses
 * the zero pubkey to prevent accidental lockout (mirrors EVM).
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/update-fee-recipient.ts \
 *       --new=<recipient-pubkey>
 *   NETWORK=mainnet-beta tsx scripts/admin/update-fee-recipient.ts \
 *       --new=<recipient-pubkey> --yes-i-mean-it-on-mainnet
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
  logger.header(`update_fee_recipient (${network})`);

  const newRecipientStr = parseArg('new');
  if (!newRecipientStr) throw new Error('Required: --new=<recipient-pubkey>');
  const newRecipient = new PublicKey(newRecipientStr);
  if (newRecipient.equals(PublicKey.default)) {
    throw new Error('--new cannot be the zero pubkey (program rejects).');
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
  const old = cfg.feeRecipient as PublicKey;
  logger.info(
    summaryBlock('update_fee_recipient()', {
      'bridge_config PDA': bridgeConfig.toBase58(),
      'current fee_recipient': old.toBase58(),
      'new fee_recipient': newRecipient.toBase58(),
      'signer (fee_manager)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (old.equals(newRecipient)) {
    logger.warning('Recipient already set to that pubkey — no-op.');
    return;
  }

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `update_fee_recipient(${newRecipient.toBase58()}) on mainnet`
  );

  const sig = await program.methods
    .updateFeeRecipient(newRecipient)
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
