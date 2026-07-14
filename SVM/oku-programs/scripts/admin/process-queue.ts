/**
 * Drain the PSM redemption queue (queue_processor / orchestrator action).
 *
 * Wraps `lite_psm::process_queue`. Reads the on-chain queue, derives each
 * non-skipped entry's USDC ATA, and submits one or more transactions —
 * each capped at `MAX_BATCH_ENTRIES = 50` per the on-chain hard cap — until
 * the queue is empty (or `--max` total entries have been drained).
 *
 * Pause-state note: `process_queue` is deliberately allowed during pause
 * (users must be able to receive queued redemptions even when the PSM is
 * paused). The yield-distribution-slot lock is also NOT applied here
 * (matches EVM `processQueue`'s lack of `whenYieldNotDistributing`).
 *
 * Operational SLA: with `MAX_ENTRIES = 200` (Phase 13b zero-copy ring) the
 * queue can hold up to 200 simultaneously-pending redemptions. Draining a
 * full queue requires at least ceil(200 / 50) = 4 sequential txs; this
 * script does that loop in-process so a single invocation can fully drain.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/process-queue.ts            # drain to empty
 *   NETWORK=devnet tsx scripts/admin/process-queue.ts --max=100  # drain at most 100 entries
 *   NETWORK=mainnet-beta tsx scripts/admin/process-queue.ts \
 *       --yes-i-mean-it-on-mainnet
 *   --dry-run     simulate (build + describe), do not submit
 *
 * Without `--max` the script auto-loops until the queue is empty. With
 * `--max=N` it drains at most N entries (still in batches of up to 50).
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
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

// Mirrors `RedemptionQueue::MAX_ENTRIES` in
// programs/lite-psm/src/state.rs (Phase 13b: 10 -> 200, zero-copy).
const QUEUE_MAX_ENTRIES = 200n;

// Mirrors `MAX_BATCH_ENTRIES` in
// programs/lite-psm/src/instructions/psm.rs (hard-cap on a single tx).
const MAX_BATCH_ENTRIES = 50;

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

/**
 * Convert an Anchor-decoded u64 (BN) field to bigint without going through
 * `Number()` (which truncates above 2^53). `head`/`tail` were widened to
 * u64 in Phase 13b; `Number(q.head)` would silently lose precision after
 * ~9.0e15 enqueues. Practically irrelevant today, but the script is
 * correctness-by-construction this way.
 */
function bnToBigInt(bn: anchor.BN): bigint {
  return BigInt(bn.toString());
}

interface QueueEntry {
  user: PublicKey;
  usdOkuAmount: anchor.BN;
}

/**
 * Build the `remainingAccounts` list for one batch of up to
 * `MAX_BATCH_ENTRIES` entries starting at the current `head`.
 *
 * Skipped entries (user == default) do NOT consume a remainingAccounts
 * slot -- this matches the on-chain `payouts` counter in `process_queue`
 * which only increments for non-skipped entries.
 *
 * Returns the entries to be processed in this batch (for the summary
 * block) plus the recipient ATA list in queue order.
 */
function buildBatch(
  head: bigint,
  tail: bigint,
  entries: QueueEntry[],
  usdcMint: PublicKey,
  batchSize: number
): {
  pendingThisBatch: number;
  recipientAtas: PublicKey[];
  summary: Record<string, string>;
} {
  const totalPending = Number(tail - head);
  const pendingThisBatch = Math.min(totalPending, batchSize);

  const recipientAtas: PublicKey[] = [];
  const summary: Record<string, string> = {};

  for (let i = 0; i < pendingThisBatch; i++) {
    // On-chain ring index is `(head + i) % MAX_ENTRIES` over u64 head/tail.
    const absolute = head + BigInt(i);
    const slot = Number(absolute % QUEUE_MAX_ENTRIES);
    const entry = entries[slot];
    const user = entry.user;
    if (user.equals(PublicKey.default)) {
      summary[`slot[${slot}]`] = 'skipped (rescued)';
      continue;
    }
    const ata = getAssociatedTokenAddressSync(
      usdcMint,
      user,
      false,
      TOKEN_PROGRAM_ID
    );
    summary[`slot[${slot}]`] =
      `${user.toBase58()} (usdOku=${entry.usdOkuAmount.toString()}) ata=${ata.toBase58()}`;
    recipientAtas.push(ata);
  }

  return { pendingThisBatch, recipientAtas, summary };
}

async function main() {
  const network = detectNetwork();
  logger.header(`process_queue (${network})`);

  const maxArg = parseArg('max');
  const maxTotalToDrain =
    maxArg === undefined ? Number.POSITIVE_INFINITY : Number(maxArg);
  if (
    maxArg !== undefined &&
    (!Number.isFinite(maxTotalToDrain) || maxTotalToDrain < 1)
  ) {
    throw new Error(`--max must be a positive integer (got ${maxArg}).`);
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (
    !deployment?.programs?.litePsm ||
    !deployment.tokens?.usdOku ||
    !deployment.tokens?.usdc
  ) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const usdOkuMint = new PublicKey(deployment.tokens.usdOku);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [redemptionQueue] = deriveRedemptionQueuePDA(litePsmId);

  // Derive the vault ATAs (USDC + usdOku escrow) -- both are config-PDA-owned.
  const vaultUsdc = getAssociatedTokenAddressSync(
    usdcMint,
    psmConfig,
    true,
    TOKEN_PROGRAM_ID
  );
  const vaultUsdOku = getAssociatedTokenAddressSync(
    usdOkuMint,
    psmConfig,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  // Fetch the queue once for the initial summary; refetch each iteration
  // because every successful processQueue tx advances `head`.
  const initial = await program.account.redemptionQueue.fetch(redemptionQueue);
  const initialHead = bnToBigInt(initial.head as anchor.BN);
  const initialTail = bnToBigInt(initial.tail as anchor.BN);
  if (initialTail < initialHead) {
    throw new Error(
      `queue corruption: tail (${initialTail}) < head (${initialHead}). ` +
        `Bail out and inspect on-chain state.`
    );
  }
  const initialPending = initialTail - initialHead;
  if (initialPending === 0n) {
    logger.warning('Queue is empty -- nothing to process.');
    return;
  }

  const targetTotal =
    maxArg === undefined
      ? Number(initialPending)
      : Math.min(Number(initialPending), maxTotalToDrain);
  const expectedBatches = Math.ceil(targetTotal / MAX_BATCH_ENTRIES);

  logger.info(
    summaryBlock('process_queue() -- drain plan', {
      'config PDA': psmConfig.toBase58(),
      'queue PDA': redemptionQueue.toBase58(),
      'usdcMint': usdcMint.toBase58(),
      'usdOkuMint': usdOkuMint.toBase58(),
      'vault USDC': vaultUsdc.toBase58(),
      'vault usdOku': vaultUsdOku.toBase58(),
      'queue head (initial)': initialHead.toString(),
      'queue tail (initial)': initialTail.toString(),
      'pending entries': initialPending.toString(),
      'max requested (--max)': maxArg ?? '(drain to empty)',
      'will drain (this run)': String(targetTotal),
      'batches expected': String(expectedBatches),
      'per-tx cap (MAX_BATCH_ENTRIES)': String(MAX_BATCH_ENTRIES),
      'signer (queue_processor)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) {
    logger.success('--dry-run set; not submitting.');
    return;
  }
  await confirmIfMainnet(
    network,
    `process_queue auto-drain on mainnet -- ${targetTotal} entries across ${expectedBatches} tx(s)`
  );

  // Auto-loop: re-fetch the queue between batches because each successful
  // call advances `head` on-chain and may have processed slightly fewer
  // entries than requested (e.g. skipped slots, or vault USDC ran out
  // mid-batch and the program returned early). Bail when the queue is
  // empty OR we've reached `--max`, whichever comes first.
  let drained = 0;
  let batchNum = 0;
  while (drained < targetTotal) {
    const queue = await program.account.redemptionQueue.fetch(redemptionQueue);
    const head = bnToBigInt(queue.head as anchor.BN);
    const tail = bnToBigInt(queue.tail as anchor.BN);
    if (tail <= head) {
      logger.success('Queue is now empty -- drain complete.');
      break;
    }
    const remainingTarget = targetTotal - drained;
    const thisBatchCap = Math.min(MAX_BATCH_ENTRIES, remainingTarget);

    const { pendingThisBatch, recipientAtas, summary } = buildBatch(
      head,
      tail,
      queue.entries as QueueEntry[],
      usdcMint,
      thisBatchCap
    );
    if (pendingThisBatch === 0) {
      logger.warning(
        'Calculated batch size 0 with queue non-empty -- likely all-skipped slots; bailing.'
      );
      break;
    }

    batchNum += 1;
    logger.info(
      summaryBlock(`batch ${batchNum} of ~${expectedBatches}`, {
        'head (this batch)': head.toString(),
        'tail (this batch)': tail.toString(),
        'walking entries': String(pendingThisBatch),
        'paying recipients': String(recipientAtas.length),
        ...summary,
      })
    );

    const sig = await program.methods
      .processQueue(pendingThisBatch)
      .accountsPartial({
        queueProcessor: provider.wallet.publicKey,
        config: psmConfig,
        redemptionQueue,
        usdOkuMint,
        vaultUsdc,
        vaultUsdOku,
        tokenProgram: TOKEN_PROGRAM_ID,
        token2022Program: TOKEN_2022_PROGRAM_ID,
      })
      .remainingAccounts(
        recipientAtas.map((pk) => ({
          pubkey: pk,
          isWritable: true,
          isSigner: false,
        }))
      )
      .rpc();
    logger.success(`batch ${batchNum} tx: ${sig}`);

    // Confirm head advanced -- otherwise we'd loop forever. The on-chain
    // handler returns Ok with `processed = 0` only when the queue was
    // already empty on entry (caught above) or it ran out of CU mid-call;
    // in either case re-running this script later is the right answer.
    const after = await program.account.redemptionQueue.fetch(redemptionQueue);
    const headAfter = bnToBigInt(after.head as anchor.BN);
    const advanced = Number(headAfter - head);
    if (advanced === 0) {
      logger.warning(
        `head did not advance after batch ${batchNum} (still ${headAfter}). ` +
          'Likely the on-chain handler returned early (e.g. all entries ' +
          'skipped, or vault USDC depleted). Stopping the loop -- re-run ' +
          'after investigating.'
      );
      break;
    }
    drained += advanced;
    logger.info(
      `Progress: drained ${drained} / target ${targetTotal} ` +
        `(head ${head} -> ${headAfter}).`
    );
  }

  logger.success(
    `Done. Drained ${drained} entries across ${batchNum} tx(s).`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
