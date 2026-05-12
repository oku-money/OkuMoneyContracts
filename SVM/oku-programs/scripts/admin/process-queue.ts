/**
 * Drain the PSM redemption queue (queue_processor / orchestrator action).
 *
 * Wraps `lite_psm::process_queue`. Reads the on-chain queue, derives
 * each non-skipped entry's USDC ATA, and submits a single tx with all
 * recipient ATAs supplied via `remainingAccounts` in queue order.
 *
 * Pause-state note: `process_queue` is deliberately allowed during pause
 * (users must be able to receive queued redemptions even when the PSM
 * is paused). The yield-distribution-slot lock is also NOT applied
 * here (matches EVM `processQueue`'s lack of `whenYieldNotDistributing`).
 *
 * Operational SLA: with `MAX_ENTRIES = 10`, this should be invoked at
 * least once between any two batches of enqueues to keep the ring buffer
 * from filling. The Phase 9 README runbook captures this.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/process-queue.ts [--max=<N>]
 *   NETWORK=mainnet-beta tsx scripts/admin/process-queue.ts [--max=<N>] \
 *       --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 *
 * If `--max` is omitted, drains up to the on-chain `MAX_ENTRIES` (10).
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

const ON_CHAIN_MAX_ENTRIES = 10;

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`process_queue (${network})`);

  const maxArg = parseArg('max');
  const maxEntries = maxArg ? Number(maxArg) : ON_CHAIN_MAX_ENTRIES;
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(`--max must be a positive integer (got ${maxArg}).`);
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (
    !deployment?.programs?.litePsm ||
    !deployment.tokens?.okuMoney ||
    !deployment.tokens?.usdc
  ) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const okuMoneyMint = new PublicKey(deployment.tokens.okuMoney);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [redemptionQueue] = deriveRedemptionQueuePDA(litePsmId);

  // Read the on-chain queue. Per `state.rs::RedemptionQueue`,
  //   pending = (tail - head) wrapped mod MAX_ENTRIES.
  // Entries are stored in a fixed [10]; iteration follows
  //   for i in 0..pending:  idx = (head + i) % MAX_ENTRIES.
  const q = await program.account.redemptionQueue.fetch(redemptionQueue);
  const head = Number(q.head);
  const tail = Number(q.tail);
  // Compute pending count the way the on-chain helper does, with wrap.
  let pending = tail - head;
  if (pending < 0) pending += 0; // head/tail are u32 in storage; both non-negative here.
  // The queue stores absolute counters, so (tail - head) is the count.
  pending = tail - head;
  if (pending < 0) {
    throw new Error(
      `queue corruption: tail (${tail}) < head (${head}). ` +
        `Bail out and inspect on-chain state.`
    );
  }
  if (pending === 0) {
    logger.warning('Queue is empty — nothing to process.');
    return;
  }

  // Walk pending entries; collect each non-skipped entry's USDC ATA.
  // Skipped entries (user == default) do NOT consume a remaining_accounts
  // slot (matches the program's `payouts` counter).
  const entries = q.entries as Array<{ user: PublicKey; okuMAmount: anchor.BN }>;
  const recipientAtas: PublicKey[] = [];
  const summaryLines: Record<string, string> = {};
  for (let i = 0; i < pending; i++) {
    const idx = (head + i) % ON_CHAIN_MAX_ENTRIES;
    const entry = entries[idx];
    const user = entry.user;
    const amount = entry.okuMAmount.toString();
    if (user.equals(PublicKey.default)) {
      summaryLines[`slot[${idx}]`] = `skipped (rescued)`;
      continue;
    }
    const ata = getAssociatedTokenAddressSync(
      usdcMint,
      user,
      false,
      TOKEN_PROGRAM_ID
    );
    summaryLines[`slot[${idx}]`] = `${user.toBase58()} (okuM=${amount}) ata=${ata.toBase58()}`;
    recipientAtas.push(ata);
  }

  // Derive the vault ATAs (USDC + OkuMoney escrow) — both are config-PDA-owned.
  const vaultUsdc = getAssociatedTokenAddressSync(
    usdcMint,
    psmConfig,
    true,
    TOKEN_PROGRAM_ID
  );
  const vaultOkuMoney = getAssociatedTokenAddressSync(
    okuMoneyMint,
    psmConfig,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  logger.info(
    summaryBlock('process_queue()', {
      'config PDA': psmConfig.toBase58(),
      'queue PDA': redemptionQueue.toBase58(),
      'usdcMint': usdcMint.toBase58(),
      'okuMoneyMint': okuMoneyMint.toBase58(),
      'vault USDC': vaultUsdc.toBase58(),
      'vault OkuMoney': vaultOkuMoney.toBase58(),
      'pending entries': String(pending),
      'max_entries arg': String(maxEntries),
      'payouts (non-skipped)': String(recipientAtas.length),
      'signer (queue_processor)': provider.wallet.publicKey.toBase58(),
      ...summaryLines,
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `process_queue(max=${maxEntries}) on mainnet — pays ${recipientAtas.length} recipients`
  );

  const sig = await program.methods
    .processQueue(maxEntries)
    .accountsPartial({
      queueProcessor: provider.wallet.publicKey,
      config: psmConfig,
      redemptionQueue,
      okuMoneyMint,
      vaultUsdc,
      vaultOkuMoney,
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
  logger.success(`tx: ${sig}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
