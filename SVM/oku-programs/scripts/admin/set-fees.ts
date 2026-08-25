/**
 * Set the PSM `tin` / `tout` fee schedule (cap_manager-only, cold multisig).
 *
 * Wraps `lite_psm::set_fees`. Restores the fee parameters from the upstream this
 * PSM was modelled on (`makerdao/dss-lite-psm`), which the original port omitted.
 *
 * ============================================================================
 * WHY `tout` MATTERS ON SVM SPECIFICALLY
 * ============================================================================
 *
 * The OkuM multiplier moves in DISCRETE STEPS here. Token-2022 refuses
 * `ScaledUiAmount` alongside `InterestBearingConfig`, so continuous accrual —
 * which is what makes the EVM side immune — is unavailable on this chain.
 *
 * A discrete step is free money without a fee:
 *
 *   1. mint_oku_m at multiplier M0
 *   2. wait for the step to M1 (no risk, no meaningful holding period)
 *   3. redeem_oku_m at M1, pocket the entire step
 *
 * Repeatable every step, bounded only by `minter_allowance` and buffer depth.
 * The yield captured is yield that belonged to holders who actually held.
 *
 * THE SYNC WINDOW DOES NOT STOP THIS. The attacker never transacts while the
 * window is open — they transact before and after it. Window length is
 * irrelevant to them. `tout` is the only control that works, and it works
 * regardless of timing or cadence.
 *
 * SIZING. `tout` must exceed the yield delivered by the largest single step the
 * rebase cadence can produce, with margin. At 5% APY:
 *
 *     hourly  ~0.06 bps      daily  ~1.4 bps      weekly  ~9.6 bps
 *
 * A weekly cadence therefore needs `tout` comfortably above 10 bps. Bounded by
 * `MAX_FEE_BPS` (100 = 1%).
 *
 * WHERE THE FEE GOES. Nowhere — it is withheld, not forwarded. `tin` is
 * deposited into the vault without OkuM being minted against it; `tout` is owed
 * but never transferred out. Both raise the collateral ratio. No recipient, no
 * sweep.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-fees.ts --tin=0 --tout=15
 *   NETWORK=devnet tsx scripts/admin/set-fees.ts --tin=0 --tout=0   # disable
 *   NETWORK=mainnet-beta tsx scripts/admin/set-fees.ts --tin=0 --tout=15 \
 *       --yes-i-mean-it-on-mainnet
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

const MAX_FEE_BPS = 100;

/** Yield delivered by one multiplier step, in bps, at a given APY and cadence. */
const STEP_BPS = { hourly: 0.06, daily: 1.37, weekly: 9.62 } as const;

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`set_fees (${network})`);

  const tinArg = parseArg('tin');
  const toutArg = parseArg('tout');
  if (tinArg === undefined || toutArg === undefined) {
    throw new Error('Required: --tin=<bps> --tout=<bps>');
  }
  const tinBps = Number(tinArg);
  const toutBps = Number(toutArg);

  for (const [label, v] of [
    ['tin', tinBps],
    ['tout', toutBps],
  ] as const) {
    if (!Number.isInteger(v) || v < 0) throw new Error(`--${label} must be a non-negative integer`);
    if (v > MAX_FEE_BPS) {
      throw new Error(
        `--${label}=${v} exceeds MAX_FEE_BPS (${MAX_FEE_BPS}). This bound is a ` +
          `compile-time constant and cannot be raised by any key.`
      );
    }
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) throw new Error(`No deployment for ${network}.`);

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg: any = await program.account.psmConfig.fetch(psmConfig);
  const oldTin = Number(cfg.tinBps.toString());
  const oldTout = Number(cfg.toutBps.toString());

  logger.info(
    summaryBlock('set_fees()', {
      'config PDA': psmConfig.toBase58(),
      tin: `${oldTin}bps -> ${tinBps}bps`,
      tout: `${oldTout}bps -> ${toutBps}bps`,
      'signer (cap_manager)': provider.wallet.publicKey.toBase58(),
    })
  );

  // Surface the step-arbitrage arithmetic rather than making the operator
  // remember it. This is the whole reason `tout` exists on this chain.
  logger.info('Step yield at 5% APY (tout must exceed the cadence in use):');
  for (const [cadence, bps] of Object.entries(STEP_BPS)) {
    const safe = toutBps > bps;
    logger.info(
      `  ${cadence.padEnd(7)} ~${String(bps).padEnd(5)}bps   ` +
        `${safe ? 'covered' : 'NOT COVERED — mint-hold-redeem is profitable'}`
    );
  }

  if (toutBps === 0) {
    logger.warning(
      'tout = 0 leaves local step arbitrage fully OPEN. Anyone can mint before a ' +
        'multiplier step and redeem after it for the whole step, risk-free and ' +
        'repeatably. The sync window does not prevent this.'
    );
  } else if (toutBps < oldTout) {
    logger.warning(
      `Lowering tout (${oldTout} -> ${toutBps}bps). Confirm it still exceeds the ` +
        `largest step your rebase cadence produces.`
    );
  }

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `set_fees(tin=${tinBps}, tout=${toutBps}) on mainnet — changes user-facing pricing`
  );

  const sig = await program.methods
    .setFees(new BN(tinBps), new BN(toutBps))
    .accountsPartial({ capManager: provider.wallet.publicKey, config: psmConfig })
    .rpc();
  logger.success(`tx: ${sig}`);

  const after: any = await program.account.psmConfig.fetch(psmConfig);
  logger.info(`tin=${after.tinBps.toString()}bps tout=${after.toutBps.toString()}bps`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
