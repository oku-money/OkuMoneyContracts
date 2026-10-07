/**
 * Emergency-override multiplier set (rebaser-only): `set_okum_multiplier`.
 * NOT part of the normal flow (see `set-yield-rate.ts`); use it to re-anchor a
 * chain that fell BEHIND the fleet (see `checkMultiplierDrift.ts`).
 *
 * SIDE EFFECT: this HALTS the running schedule (rate = PRECISION, end = 0,
 * pending cleared). Run it FIRST, then publish the schedule with
 * `set-yield-rate.ts`, never the reverse. Also strictly monotonic
 * (`MultiplierCannotDecrease`), capped (`MultiplierTooHigh`) and `!is_paused`.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-multiplier.ts --to=<wad>
 *   NETWORK=devnet tsx scripts/admin/set-multiplier.ts --to-match-evm=<evmMultiplierWad>
 *   --dry-run | --yes-i-mean-it-on-mainnet
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeploymentStrict } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { resolveRoleSigner, describeRoleSigner } from '../utils/roleSigner';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';
import { computeMultiplier, scheduleFromConfig, MAX_MULTIPLIER } from '@okumoney/yield-tooling';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`set multiplier (emergency override) — ${network}`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeploymentStrict(network);
  if (!deployment?.programs?.litePsm) throw new Error(`No deployment for ${network}.`);

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg: any = await program.account.psmConfig.fetch(psmConfig);
  const rebaser = resolveRoleSigner(provider, cfg, 'rebaser');
  const schedule = scheduleFromConfig(cfg);
  const nowSec = Math.floor(Date.now() / 1000);
  const current = computeMultiplier(schedule, BigInt(nowSec));

  const toArg = parseArg('to');
  const toMatchEvmArg = parseArg('to-match-evm');
  if (!!toArg === !!toMatchEvmArg) {
    throw new Error('Pass exactly one of --to=<wad> or --to-match-evm=<wad>.');
  }
  const target = BigInt(toArg ?? toMatchEvmArg!);

  if (target <= current) {
    throw new Error(
      `--to=${target} is not strictly ABOVE the current multiplier ${current}. ` +
        `set_okum_multiplier is monotonic-increase-only on-chain and will revert ` +
        `MultiplierCannotDecrease. If this chain is AHEAD of the target, there is ` +
        `no correction available — see the "one-way divergence" note in TRACKER.md.`,
    );
  }
  if (target > MAX_MULTIPLIER) {
    throw new Error(`--to=${target} exceeds MAX_MULTIPLIER (${MAX_MULTIPLIER}).`);
  }

  const deltaBps = ((target - current) * 10_000n) / current;

  logger.info(
    summaryBlock('set multiplier', {
      'config PDA': psmConfig.toBase58(),
      'signer (rebaser)': describeRoleSigner('rebaser', rebaser),
      'current multiplier (wad)': current.toString(),
      'target multiplier (wad)': target.toString(),
      'delta': `+${deltaBps} bps`,
      'current rate (wad)': schedule.ratePerSecond.toString(),
      'current rateEnd': schedule.rateEnd.toString(),
    }),
  );
  logger.warning(
    'This HALTS the schedule as a side effect (rate -> PRECISION, rateEnd -> 0, ' +
      'pending cleared). If a schedule should be running afterward, publish it ' +
      'IMMEDIATELY after this confirms — see the module doc.',
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, 'set multiplier (emergency override) on mainnet', provider.connection);

  const sig = await program.methods
    .setOkumMultiplier(new BN(target.toString()))
    .accountsPartial({
      rebaser: rebaser.authority,
      config: psmConfig,
      okuMMint: new PublicKey(deployment.tokens!.okuM),
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers(rebaser.signers)
    .rpc();
  logger.success(`tx: ${sig}`);

  const after = scheduleFromConfig((await program.account.psmConfig.fetch(psmConfig)) as any);
  logger.info(
    summaryBlock('schedule after', {
      'multiplier now (wad)': computeMultiplier(after, BigInt(Math.floor(Date.now() / 1000))).toString(),
      'rate (wad, should be PRECISION)': after.ratePerSecond.toString(),
      'rateEnd (should be 0)': after.rateEnd.toString(),
    }),
  );
  logger.warning('Schedule is now HALTED. Publish the shared schedule next with set-yield-rate.ts.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
