/**
 * Publish the OkuM rate schedule (rebaser-only): the normal operator path for
 * yield. The operator publishes a per-second RATE and a bounded window; the
 * multiplier follows from elapsed time. (`set-multiplier.ts` is an emergency
 * override, not part of this flow.)
 *
 *   --mode=active      set_okum_yield_rate(rate, end)
 *   --mode=successor   set_next_okum_yield_rate(rate, pendingEnd)
 *   --mode=atomic      set_okum_yield_rate_with_successor(rate, end, next, nextEnd)
 *
 * CROSS-CHAIN: these integers MUST be byte-identical to those sent to every
 * EVM deployment; nothing on-chain detects divergence. `atomic` re-anchors the
 * active rate and arms the next epoch in one tx.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-yield-rate.ts --mode=active --apy=0.05 --days=30
 *   NETWORK=devnet tsx scripts/admin/set-yield-rate.ts --mode=active --rate=<wad> --end=<unix>
 *   NETWORK=devnet tsx scripts/admin/set-yield-rate.ts --mode=atomic \
 *       --rate=<wad> --end=<unix> --next-rate=<wad> --next-end=<unix>
 *   --dry-run | --yes-i-mean-it-on-mainnet
 *
 * Rates are WAD (1e18); `1e18` means "no yield". Rates below PRECISION are
 * rejected on-chain (no representation of a loss).
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { resolveRoleSigner, describeRoleSigner } from '../utils/roleSigner';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';
import {
  PRECISION,
  MAX_RATE,
  computeMultiplier,
  scheduleFromConfig,
  ratePerSecondForApy,
} from "@okumoney/yield-tooling";

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

/** Resolve a rate from either an explicit WAD integer or a declared APY. */
function resolveRate(rateArg?: string, apyArg?: string, label = 'rate'): bigint {
  if (rateArg && apyArg) {
    throw new Error(`Pass either --${label} or --apy for ${label}, not both.`);
  }
  if (rateArg) {
    const r = BigInt(rateArg);
    if (r < PRECISION) {
      throw new Error(
        `--${label}=${r} is below PRECISION (${PRECISION}). The multiplier is ` +
          `monotonic; a sub-unity rate has no on-chain representation. To stop ` +
          `paying, pass exactly ${PRECISION} with --end=0.`,
      );
    }
    if (r > MAX_RATE) throw new Error(`--${label}=${r} exceeds MAX_RATE (${MAX_RATE}).`);
    return r;
  }
  if (apyArg) return ratePerSecondForApy(Number(apyArg));
  throw new Error(`Required: --${label}=<wad> or --apy=<decimal, e.g. 0.05>`);
}

/** Resolve an absolute unix expiry from `--end` or a relative `--days`. */
function resolveEnd(endArg: string | undefined, daysArg: string | undefined, nowSec: number): number {
  if (endArg !== undefined) return Number(endArg);
  if (daysArg !== undefined) return nowSec + Math.round(Number(daysArg) * 86_400);
  throw new Error('Required: --end=<unix seconds> or --days=<n>');
}

async function main() {
  const network = detectNetwork();
  const mode = parseArg('mode') ?? 'active';
  logger.header(`set yield rate — mode=${mode} (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) throw new Error(`No deployment for ${network}.`);

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg: any = await program.account.psmConfig.fetch(psmConfig);
  const rebaser = resolveRoleSigner(provider, cfg, 'rebaser');
  const schedule = scheduleFromConfig(cfg);
  const nowSec = Math.floor(Date.now() / 1000);
  const currentMultiplier = computeMultiplier(schedule, BigInt(nowSec));

  const common = {
    'config PDA': psmConfig.toBase58(),
    'signer (rebaser)': describeRoleSigner('rebaser', rebaser),
    'current multiplier (wad)': currentMultiplier.toString(),
    'current rate (wad)': schedule.ratePerSecond.toString(),
    'current rateEnd': schedule.rateEnd.toString(),
    'current pendingRate (wad)': schedule.pendingRatePerSecond.toString(),
    'current pendingRateEnd': schedule.pendingRateEnd.toString(),
  };

  // Loud warning: an expired window means accrual has already HALTED.
  if (schedule.rateEnd !== 0n && BigInt(nowSec) > schedule.rateEnd) {
    const pendingLive = schedule.pendingRateEnd !== 0n && BigInt(nowSec) <= schedule.pendingRateEnd;
    logger.warning(
      pendingLive
        ? 'Active window has expired; the SUCCESSOR is currently accruing.'
        : 'Active window has expired and no successor is live — ACCRUAL IS HALTED on this chain.',
    );
  }

  let method;
  let summary: Record<string, string>;

  if (mode === 'successor') {
    const rate = resolveRate(parseArg('rate'), parseArg('apy'));
    const end = resolveEnd(parseArg('end'), parseArg('days'), nowSec);
    if (schedule.rateEnd === 0n) {
      throw new Error(
        'Cannot stage a successor: no active rate window is set (rateEnd == 0). ' +
          'Publish an active rate first with --mode=active.',
      );
    }
    if (BigInt(end) <= schedule.rateEnd) {
      throw new Error(
        `Successor expiry ${end} must be strictly after the active rateEnd ` +
          `${schedule.rateEnd}.`,
      );
    }
    summary = { ...common, mode, 'successor rate (wad)': rate.toString(), 'successor end': String(end) };
    method = program.methods
      .setNextOkumYieldRate(new BN(rate.toString()), new BN(end))
      .accountsPartial({ rebaser: rebaser.authority, config: psmConfig })
      .signers(rebaser.signers);
  } else if (mode === 'atomic') {
    const rate = resolveRate(parseArg('rate'), parseArg('apy'));
    const end = resolveEnd(parseArg('end'), parseArg('days'), nowSec);
    const nextRate = resolveRate(parseArg('next-rate'), parseArg('next-apy'), 'next-rate');
    const nextEnd = Number(
      parseArg('next-end') ?? (() => { throw new Error('Required: --next-end=<unix seconds>'); })(),
    );
    if (nextEnd <= end) throw new Error(`--next-end (${nextEnd}) must be after --end (${end}).`);
    summary = {
      ...common,
      mode,
      'active rate (wad)': rate.toString(),
      'active end': String(end),
      'successor rate (wad)': nextRate.toString(),
      'successor end': String(nextEnd),
    };
    method = program.methods
      .setOkumYieldRateWithSuccessor(
        new BN(rate.toString()),
        new BN(end),
        new BN(nextRate.toString()),
        new BN(nextEnd),
      )
      .accountsPartial({ rebaser: rebaser.authority, config: psmConfig })
      .signers(rebaser.signers);
  } else if (mode === 'active') {
    const rate = resolveRate(parseArg('rate'), parseArg('apy'));
    // Halting is the one case with no window.
    const halting = rate === PRECISION;
    const end = halting ? 0 : resolveEnd(parseArg('end'), parseArg('days'), nowSec);
    if (!halting && end <= nowSec) {
      throw new Error(
        `--end=${end} is not in the future. Every yielding rate must carry a ` +
          `bounded window so an unattended schedule halts rather than running on.`,
      );
    }
    summary = {
      ...common,
      mode: halting ? 'active (HALT)' : 'active',
      'new rate (wad)': rate.toString(),
      'new end': halting ? '0 (halted)' : String(end),
    };
    method = program.methods
      .setOkumYieldRate(new BN(rate.toString()), new BN(end))
      .accountsPartial({ rebaser: rebaser.authority, config: psmConfig })
      .signers(rebaser.signers);
  } else {
    throw new Error(`Unknown --mode=${mode}. Expected one of: active, successor, atomic.`);
  }

  logger.info(summaryBlock('set yield rate', summary));
  logger.warning(
    'Broadcast the IDENTICAL integers to every other chain. Cross-chain ' +
      'multiplier agreement has no on-chain enforcement layer.',
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, `set yield rate (${mode}) on mainnet`);

  const sig = await method.rpc();
  logger.success(`tx: ${sig}`);

  const after = scheduleFromConfig((await program.account.psmConfig.fetch(psmConfig)) as any);
  logger.info(
    summaryBlock('schedule after', {
      'rate (wad)': after.ratePerSecond.toString(),
      rateEnd: after.rateEnd.toString(),
      'pendingRate (wad)': after.pendingRatePerSecond.toString(),
      pendingRateEnd: after.pendingRateEnd.toString(),
      'base (wad)': after.baseMultiplier.toString(),
      'multiplier now (wad)': computeMultiplier(after, BigInt(Math.floor(Date.now() / 1000))).toString(),
    }),
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
