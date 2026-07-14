/**
 * Rescue a stuck redemption-queue entry (queue_processor-gated on SVM).
 *
 * Wraps `lite_psm::rescue_queue_entry(queue_index)`. Returns the escrowed
 * usdOku for the entry to `--recipient`, then clears the slot in the
 * ring buffer (subsequent `process_queue` calls will skip it).
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/rescue-queue-entry.ts \
 *       --index=3 --recipient=<recipient-pubkey>
 *
 *   NETWORK=mainnet-beta tsx scripts/admin/rescue-queue-entry.ts \
 *       --index=3 --recipient=<recipient-pubkey> \
 *       --yes-i-mean-it-on-mainnet
 *   --dry-run    do not submit
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import {
  derivePsmConfigPDA,
  deriveRedemptionQueuePDA,
} from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

const QUEUE_MAX_ENTRIES = 200n;

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

function bnToBigInt(bn: anchor.BN): bigint {
  return BigInt(bn.toString());
}

async function main() {
  const network = detectNetwork();
  logger.header(`rescue_queue_entry (${network})`);

  const indexArg = parseArg('index');
  const recipientArg = parseArg('recipient');
  if (!indexArg) throw new Error('Required: --index=<queue absolute index>');
  if (!recipientArg) throw new Error('Required: --recipient=<owner-pubkey>');

  const queueIndex = new BN(indexArg);
  if (queueIndex.isNeg()) throw new Error('--index must be >= 0');
  const recipientOwner = new PublicKey(recipientArg);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment.tokens?.usdOku) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const usdOkuMint = new PublicKey(deployment.tokens.usdOku);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [redemptionQueue] = deriveRedemptionQueuePDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const vaultUsdOku = cfg.vaultUsdOku as PublicKey;

  // Derive the recipient's usdOku ATA (Token-2022).
  const recipientUsdOkuAta = getAssociatedTokenAddressSync(
    usdOkuMint,
    recipientOwner,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // Pre-state: fetch the queue and read the targeted entry for the operator.
  const queue = await program.account.redemptionQueue.fetch(redemptionQueue);
  const head = bnToBigInt(queue.head as anchor.BN);
  const tail = bnToBigInt(queue.tail as anchor.BN);
  const absolute = bnToBigInt(queueIndex);
  if (absolute < head || absolute >= tail) {
    throw new Error(
      `--index ${absolute} out of range [${head}, ${tail}); cannot rescue.`
    );
  }
  const slot = Number(absolute % QUEUE_MAX_ENTRIES);
  const entry = (queue.entries as Array<{ user: PublicKey; usdOkuAmount: anchor.BN }>)[slot];

  logger.info(
    summaryBlock('rescue_queue_entry()', {
      'config PDA': psmConfig.toBase58(),
      'queue PDA': redemptionQueue.toBase58(),
      'usdOkuMint': usdOkuMint.toBase58(),
      'vault usdOku': vaultUsdOku.toBase58(),
      'queue head': head.toString(),
      'queue tail': tail.toString(),
      'absolute index': absolute.toString(),
      'ring slot': String(slot),
      'entry user (original)': entry.user.toBase58(),
      'entry usdOku (raw)': entry.usdOkuAmount.toString(),
      'recipient owner': recipientOwner.toBase58(),
      'recipient usdOku ATA': recipientUsdOkuAta.toBase58(),
      'signer (queue_processor)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `rescue_queue_entry(index=${absolute}) on mainnet — returns escrowed usdOku to ${recipientOwner.toBase58()}`
  );

  const sig = await program.methods
    .rescueQueueEntry(queueIndex)
    .accountsPartial({
      queueProcessor: provider.wallet.publicKey,
      config: psmConfig,
      redemptionQueue,
      usdOkuMint,
      vaultUsdOku,
      recipientUsdOkuAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
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
