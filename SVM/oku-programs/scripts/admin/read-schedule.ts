/**
 * Read the OkuM rate schedule and the multiplier it implies.
 *
 * Read-only. This is the SVM analogue of calling `okuMMultiplier()` on EVM —
 * except Solana has no view functions, so the multiplier is recomputed here
 * from `PsmConfig` using the shared TS mirror of the on-chain math.
 *
 * Use this to:
 *   - confirm a broadcast landed with the exact integers you intended
 *   - check whether accrual has HALTED (an expired window with no live
 *     successor) before it costs a day of yield
 *   - compare against EVM before wiring SVM into `checkMultiplierDrift.ts`
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/read-schedule.ts
 *   NETWORK=devnet tsx scripts/admin/read-schedule.ts --at=<unix seconds>
 *   NETWORK=devnet tsx scripts/admin/read-schedule.ts --json
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import {
  PRECISION,
  SECONDS_PER_YEAR,
  computeMultiplier,
  effectiveRate,
  scheduleFromConfig,
} from '../utils/multiplier';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

/** Present a WAD per-second rate as an approximate APY, for human eyes only. */
function apyOf(ratePerSecond: bigint): string {
  if (ratePerSecond <= PRECISION) return '0% (halted)';
  const r = Number(ratePerSecond) / 1e18;
  const apy = Math.pow(r, Number(SECONDS_PER_YEAR)) - 1;
  return `${(apy * 100).toFixed(4)}%`;
}

async function main() {
  const network = detectNetwork();
  const provider = createProvider(network);
  anchor.setProvider(provider);

  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) throw new Error(`No deployment for ${network}.`);

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg: any = await program.account.psmConfig.fetch(psmConfig);
  const schedule = scheduleFromConfig(cfg);

  const nowSec = Number(parseArg('at') ?? Math.floor(Date.now() / 1000));
  const multiplier = computeMultiplier(schedule, BigInt(nowSec));
  const effective = effectiveRate(schedule, BigInt(nowSec));

  // Health: has accrual stopped?
  let status: string;
  if (schedule.ratePerSecond <= PRECISION && schedule.rateEnd === 0n) {
    status = 'HALTED (no rate published)';
  } else if (schedule.rateEnd !== 0n && BigInt(nowSec) > schedule.rateEnd) {
    if (schedule.pendingRateEnd !== 0n && BigInt(nowSec) <= schedule.pendingRateEnd) {
      status = 'successor accruing (active window expired)';
    } else {
      status = 'HALTED (window expired, no live successor)';
    }
  } else {
    status = 'accruing';
  }

  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify(
        {
          network,
          evaluatedAt: nowSec,
          status,
          multiplier: multiplier.toString(),
          effectiveRate: effective.toString(),
          schedule: {
            baseMultiplier: schedule.baseMultiplier.toString(),
            ratePerSecond: schedule.ratePerSecond.toString(),
            lastAccrualTime: schedule.lastAccrualTime.toString(),
            rateEnd: schedule.rateEnd.toString(),
            pendingRatePerSecond: schedule.pendingRatePerSecond.toString(),
            pendingRateEnd: schedule.pendingRateEnd.toString(),
          },
        },
        null,
        2,
      ),
    );
    return;
  }

  logger.header(`OkuM rate schedule (${network})`);
  logger.info(`status                : ${status}`);
  logger.info(`evaluated at          : ${nowSec} (${new Date(nowSec * 1000).toISOString()})`);
  logger.info(`multiplier (wad)      : ${multiplier.toString()}`);
  logger.info(`multiplier (ratio)    : ${(Number(multiplier) / 1e18).toFixed(12)}`);
  logger.info('');
  logger.info(`base multiplier (wad) : ${schedule.baseMultiplier.toString()}`);
  logger.info(`anchor                : ${schedule.lastAccrualTime.toString()}`);
  logger.info(
    `active rate (wad)     : ${schedule.ratePerSecond.toString()}  (~${apyOf(schedule.ratePerSecond)})`,
  );
  logger.info(
    `rateEnd               : ${schedule.rateEnd.toString()}` +
      (schedule.rateEnd === 0n
        ? '  (halted)'
        : `  (${new Date(Number(schedule.rateEnd) * 1000).toISOString()})`),
  );
  logger.info(
    `pending rate (wad)    : ${schedule.pendingRatePerSecond.toString()}  (~${apyOf(schedule.pendingRatePerSecond)})`,
  );
  logger.info(
    `pendingRateEnd        : ${schedule.pendingRateEnd.toString()}` +
      (schedule.pendingRateEnd === 0n
        ? '  (none armed)'
        : `  (${new Date(Number(schedule.pendingRateEnd) * 1000).toISOString()})`),
  );
  logger.info(`effective rate (wad)  : ${effective.toString()}  (~${apyOf(effective)})`);

  if (status.startsWith('HALTED') && schedule.rateEnd !== 0n) {
    logger.error(
      'Accrual has HALTED on this chain. Every second from here earns nothing. ' +
        'Publish a fresh schedule with scripts/admin/set-yield-rate.ts.',
    );
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
