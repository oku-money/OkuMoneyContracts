/**
 * Set the cross-chain sync window length in seconds (cap_manager-only).
 *
 * Wraps `lite_psm::set_sync_window_secs`.
 *
 * `0` disables the window entirely, which is the initialization default — the
 * mechanism ships audited but inert and is switched on once the cross-chain tick
 * cadence is settled.
 *
 * SIZING. This is a propagation budget, not an economic parameter. It needs to
 * outlast "the tick has landed on every chain", which the orchestrator confirms
 * explicitly via `end_sync_window`; the configured value is only the fallback for
 * when that confirmation never arrives. Bounded by `MAX_SYNC_WINDOW_SECS`
 * (900s) so no key — cold included — can turn it into an indefinite block on
 * mint/redeem.
 *
 * Do NOT reach for a longer window to deter step arbitrage. That attacker does
 * not transact during the window, so length is irrelevant; `tout` is the control
 * there (see set-fees.ts).
 *
 * Apply the SAME value on every chain so tick windows are symmetric —
 * `check-sync-parity.ts` warns on a mismatch.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-sync-window-secs.ts --secs=60
 *   NETWORK=devnet tsx scripts/admin/set-sync-window-secs.ts --secs=0    # disable
 *   --dry-run     do not submit
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

const MAX_SYNC_WINDOW_SECS = 900;

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`set_sync_window_secs (${network})`);

  const secsArg = parseArg('secs');
  if (secsArg === undefined) throw new Error('Required: --secs=<seconds> (0 disables)');
  const secs = Number(secsArg);
  if (!Number.isInteger(secs) || secs < 0) {
    throw new Error('--secs must be a non-negative integer');
  }
  if (secs > MAX_SYNC_WINDOW_SECS) {
    throw new Error(
      `--secs=${secs} exceeds MAX_SYNC_WINDOW_SECS (${MAX_SYNC_WINDOW_SECS}). This ` +
        `bound is a compile-time constant and cannot be raised by any key.`
    );
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) throw new Error(`No deployment for ${network}.`);

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg: any = await program.account.psmConfig.fetch(psmConfig);
  const current = Number(cfg.syncWindowSecs.toString());
  const lockUntil = Number(cfg.syncLockUntilTs.toString());
  const isLocked = Math.floor(Date.now() / 1000) < lockUntil;

  logger.info(
    summaryBlock('set_sync_window_secs()', {
      'config PDA': psmConfig.toBase58(),
      'current secs': `${current}${current === 0 ? '  (INERT)' : ''}`,
      'new secs': `${secs}${secs === 0 ? '  (INERT)' : ''}`,
      'window open now': String(isLocked),
      'signer (cap_manager)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (secs === 0 && current !== 0) {
    logger.warning(
      'Disabling the sync window. Cross-chain ticks will no longer gate ' +
        'mint_oku_m/redeem_oku_m, so a tick that lands unevenly across chains ' +
        'becomes exploitable for the duration of the divergence.'
    );
  }
  if (isLocked) {
    logger.warning(
      'A window is currently OPEN. Changing the length does not alter the live ' +
        'window — it only affects windows armed after this call.'
    );
  }

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, `set_sync_window_secs(${secs}) on mainnet`);

  const sig = await program.methods
    .setSyncWindowSecs(new BN(secs))
    .accountsPartial({ capManager: provider.wallet.publicKey, config: psmConfig })
    .rpc();
  logger.success(`tx: ${sig}`);

  const after: any = await program.account.psmConfig.fetch(psmConfig);
  logger.info(`sync_window_secs = ${after.syncWindowSecs.toString()}`);
  logger.warning('Apply the SAME value on every chain so tick windows are symmetric.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
