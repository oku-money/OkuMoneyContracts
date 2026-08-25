/**
 * Open / close a cross-chain multiplier sync window (rebaser-only).
 *
 * Wraps `lite_psm::begin_sync_window` and `lite_psm::end_sync_window`.
 *
 * THE TICK PROTOCOL — all three steps on EVERY chain, same epoch number:
 *
 *   1. sync-window.ts --begin            (this script)
 *   2. set-multiplier.ts / distribute-yield.ts
 *   3. sync-window.ts --end              (this script)
 *
 * WHY. A multiplier tick is not atomic across chains. Between the SVM write and
 * the EVM write the two sides price a raw token differently, so `mint_oku_m` and
 * `redeem_oku_m` — the two instructions that convert value through the
 * multiplier — must not execute in that interval. Everything else stays open:
 * buffer movement is at par, and the direct mint/burn bridge legs conserve raw
 * 1:1 without consulting the multiplier at all.
 *
 * WHAT THIS IS NOT. It is not a defence against holding OkuM across a discrete
 * multiplier step. That attacker never transacts while the window is open, so
 * lengthening it accomplishes nothing — `tout` (see set-fees.ts) is the control
 * for that.
 *
 * SAFETY. The window auto-expires after `sync_window_secs` (bounded by
 * `MAX_SYNC_WINDOW_SECS` = 900s), so forgetting step 3 delays users rather than
 * stranding them. `MIN_SYNC_WINDOW_GAP_SECS` (21600s) between windows bounds the
 * duty cycle, giving a >=96% redemption-availability floor.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/sync-window.ts --begin
 *   NETWORK=devnet tsx scripts/admin/sync-window.ts --begin --epoch=42
 *   NETWORK=devnet tsx scripts/admin/sync-window.ts --end
 *   NETWORK=devnet tsx scripts/admin/sync-window.ts --status
 *   --dry-run     do not submit
 *
 * Verify cross-chain agreement with `check-sync-parity.ts` before and after.
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

const MIN_SYNC_WINDOW_GAP_SECS = 21_600;

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}
const has = (flag: string) => process.argv.includes(`--${flag}`);

async function main() {
  const network = detectNetwork();

  const begin = has('begin');
  const end = has('end');
  const statusOnly = has('status');

  if ([begin, end, statusOnly].filter(Boolean).length !== 1) {
    throw new Error('Exactly one of --begin | --end | --status is required.');
  }

  logger.header(`sync_window ${begin ? 'begin' : end ? 'end' : 'status'} (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) throw new Error(`No deployment for ${network}.`);

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg: any = await program.account.psmConfig.fetch(psmConfig);
  const nowTs = Math.floor(Date.now() / 1000);

  const storedEpoch = Number(cfg.syncEpoch.toString());
  const lockUntil = Number(cfg.syncLockUntilTs.toString());
  const windowSecs = Number(cfg.syncWindowSecs.toString());
  const isLocked = nowTs < lockUntil; // exclusive bound, matches on-chain

  logger.info(
    summaryBlock('sync window state', {
      'config PDA': psmConfig.toBase58(),
      sync_epoch: String(storedEpoch),
      sync_window_secs: `${windowSecs}${windowSecs === 0 ? '  (INERT)' : ''}`,
      sync_lock_until_ts: `${lockUntil}${lockUntil ? ` (${new Date(lockUntil * 1000).toISOString()})` : ''}`,
      'window open now': String(isLocked),
      'signer (rebaser)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (statusOnly) return;

  if (windowSecs === 0) {
    logger.warning(
      'sync_window_secs is 0 — the window mechanism is INERT. begin/end will move ' +
        'the epoch but gate nothing. Set a duration with set-sync-window-secs.ts first.'
    );
  }

  if (begin) {
    const requested = parseArg('epoch');
    const epoch = requested !== undefined ? Number(requested) : storedEpoch + 1;

    if (epoch !== storedEpoch + 1) {
      throw new Error(
        `epoch must be exactly sync_epoch + 1 (${storedEpoch + 1}), got ${epoch}. ` +
          `Strict succession is what keeps the cross-chain parity check meaningful.`
      );
    }
    if (isLocked) {
      throw new Error(
        `A window is already open until ${new Date(lockUntil * 1000).toISOString()}. ` +
          `Close it with --end (epoch ${storedEpoch}) or wait for expiry.`
      );
    }
    if (lockUntil !== 0 && nowTs < lockUntil + MIN_SYNC_WINDOW_GAP_SECS) {
      throw new Error(
        `MIN_SYNC_WINDOW_GAP_SECS has not elapsed. Earliest next open: ` +
          `${new Date((lockUntil + MIN_SYNC_WINDOW_GAP_SECS) * 1000).toISOString()}. ` +
          `This bound guarantees the redemption-availability floor.`
      );
    }

    if (isDryRun()) return logger.success('--dry-run set; not submitting.');
    await confirmIfMainnet(
      network,
      `begin_sync_window(${epoch}) on mainnet — blocks mint_oku_m/redeem_oku_m for ${windowSecs}s`
    );

    const sig = await program.methods
      .beginSyncWindow(new BN(epoch))
      .accountsPartial({ rebaser: provider.wallet.publicKey, config: psmConfig })
      .rpc();
    logger.success(`tx: ${sig}`);
    logger.warning(
      `NEXT: write the multiplier on every chain with THE SAME epoch (${epoch}), ` +
        `then run --end --epoch=${epoch} on every chain.`
    );
    return;
  }

  // --end
  const requested = parseArg('epoch');
  const epoch = requested !== undefined ? Number(requested) : storedEpoch;

  if (epoch !== storedEpoch) {
    throw new Error(
      `epoch must equal sync_epoch (${storedEpoch}), got ${epoch}. The equality check ` +
        `stops a stale release closing a window it never observed.`
    );
  }
  if (!isLocked) {
    logger.warning(
      'No window is currently open — this will be a no-op in effect. If you expected ' +
        'one, it may have already auto-expired, meaning the tick outlasted ' +
        'sync_window_secs.'
    );
  }

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, `end_sync_window(${epoch}) on mainnet — restores mint/redeem`);

  const sig = await program.methods
    .endSyncWindow(new BN(epoch))
    .accountsPartial({ rebaser: provider.wallet.publicKey, config: psmConfig })
    .rpc();
  logger.success(`tx: ${sig}`);
  logger.info('Verify cross-chain agreement with check-sync-parity.ts.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
