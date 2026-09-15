/**
 * Refresh the wallet-facing ScaledUiAmount display mirror.
 *
 * ## What this is (and is not)
 *
 * It is **cosmetic**. The canonical multiplier is computed on read from the
 * rate schedule and streams with no transactions at all; this instruction only
 * refreshes what Phantom, Solflare, Jupiter and `getTokenAccountBalance`
 * render, because Token-2022's `ScaledUiAmount` extension is a step function
 * and cannot stream.
 *
 * Consequences worth being clear about before wiring this into a keeper:
 *
 * - Missing a run does NOT stop yield. It only makes wallet balances read
 *   slightly low. At 60s cadence and 20% APY the under-read is about
 *   $0.35 per $1,000,000.
 * - Display is always `<=` canonical, so a redeem pays at least what the
 *   wallet showed. The error is always in the user's favour.
 * - The instruction is **permissionless** — the value written is fully
 *   determined by on-chain state, so anyone can crank it and nobody can
 *   influence the result.
 * - Each run also pre-arms the next step, so the display keeps advancing for a
 *   full interval even if the following run never happens.
 * - PSM mints and redeems sync opportunistically too, so an actively-used
 *   deployment largely maintains itself.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/sync-display.ts
 *   NETWORK=devnet tsx scripts/admin/sync-display.ts --loop --interval=60
 *   --dry-run     report drift without submitting
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getMint, getScaledUiAmountConfig } from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { isDryRun, summaryBlock } from './_lib/confirm';
import { PRECISION, computeMultiplier, scheduleFromConfig } from '../utils/multiplier';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

/** What a wallet currently renders, per `ScaledUiAmountConfig::current_multiplier`. */
async function readDisplay(
  connection: Parameters<typeof getMint>[0],
  mint: PublicKey,
): Promise<number> {
  const mintInfo = await getMint(connection, mint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  const cfg = getScaledUiAmountConfig(mintInfo);
  if (!cfg) throw new Error('OkuM mint has no ScaledUiAmountConfig extension');
  const nowSec = Math.floor(Date.now() / 1000);
  return nowSec >= Number(cfg.newMultiplierEffectiveTimestamp) ? cfg.newMultiplier : cfg.multiplier;
}

async function syncOnce(
  program: Program<LitePsm>,
  provider: anchor.AnchorProvider,
  psmConfig: PublicKey,
  okuMMint: PublicKey,
): Promise<void> {
  const cfg: any = await program.account.psmConfig.fetch(psmConfig);
  const schedule = scheduleFromConfig(cfg);
  const nowSec = Math.floor(Date.now() / 1000);

  const canonical = computeMultiplier(schedule, BigInt(nowSec));
  const display = await readDisplay(provider.connection, okuMMint);
  const displayWad = BigInt(Math.floor(display * 1e18));

  // Relative drift in basis points of a basis point, for legibility.
  const driftPpb =
    canonical === 0n ? 0n : ((canonical - displayWad) * 1_000_000_000n) / canonical;

  logger.info(
    summaryBlock('display mirror', {
      'canonical (wad)': canonical.toString(),
      'display (ratio)': display.toString(),
      'drift (parts per billion)': driftPpb.toString(),
      'last sync ts': cfg.lastDisplaySyncTs?.toString() ?? 'n/a',
    }),
  );

  if (displayWad > canonical) {
    // Should be impossible: the program floors the f64 conversion and pins the
    // pre-armed step to the curve. Worth shouting about rather than ignoring.
    logger.error(
      'INVARIANT VIOLATION: display reads ABOVE canonical. Wallets are ' +
        'promising more than the PSM will pay. Investigate before cranking.',
    );
  }

  if (isDryRun()) {
    logger.success('--dry-run set; not submitting.');
    return;
  }

  const sig = await program.methods
    .syncDisplayMultiplier()
    .accountsPartial({
      cranker: provider.wallet.publicKey,
      config: psmConfig,
      okuMMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  logger.success(`tx: ${sig}`);
}

async function main() {
  const network = detectNetwork();
  logger.header(`sync display multiplier (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment.tokens?.okuM) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const okuMMint = new PublicKey(deployment.tokens.okuM);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  // No mainnet confirmation gate: this is permissionless, cosmetic, and
  // cannot move value. Prompting for it would discourage running it.
  if (!process.argv.includes('--loop')) {
    await syncOnce(program, provider as anchor.AnchorProvider, psmConfig, okuMMint);
    return;
  }

  const intervalSec = Number(parseArg('interval') ?? 60);
  logger.info(`Looping every ${intervalSec}s. Ctrl-C to stop.`);
  // Deliberately naive: a real keeper belongs in infrastructure with
  // supervision and alerting, not in a CLI script. This is for operating a
  // devnet deployment by hand.
  for (;;) {
    try {
      await syncOnce(program, provider as anchor.AnchorProvider, psmConfig, okuMMint);
    } catch (err) {
      logger.warning(`sync failed (will retry): ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
