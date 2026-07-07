/**
 * Update the OkuDollar USD multiplier (usd_rebaser-gated).
 *
 * Wraps `oku_dollar::update_usd_multiplier`. The handler enforces:
 *   - strict increase (new > old; no-op writes waste the yield-lock slot)
 *   - upper bound (`MAX_USD_MULTIPLIER` = 1e15)
 *   - collateralization check (vault must stay above `min_collateral_ratio`)
 *   - cross-program yield lock (rejects if PSM did a yield op in same slot)
 *   - self-fence (rejects if vault already did a yield op in same slot)
 *
 * This is the SVM equivalent of EVM's `OkuDollar.setUsdYieldRate` but
 * operates as a discrete multiplier bump rather than a continuous rate.
 *
 * Scale: multipliers are stored at 1e9 precision. `1_000_000_000` = $1.00.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/update-usd-multiplier.ts --new=1000133680
 *   NETWORK=mainnet-beta tsx scripts/admin/update-usd-multiplier.ts \
 *       --new=<1e9-scaled> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 *
 * Yield math (for reference):
 *   5% APY with weekly discrete bumps:
 *     weekly_factor = 1.05^(1/52) ~= 1.000938
 *     bump per week = current_multiplier * 0.000938 ~= +938_000 (from 1e9 base)
 *   5% APY with daily discrete bumps:
 *     daily_factor = 1.05^(1/365) ~= 1.0001336
 *     bump per day = current_multiplier * 0.0001336 ~= +133_680 (from 1e9 base)
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { OkuDollar } from '../../target/types/oku_dollar';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { deriveVaultConfigPDA, derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

const PRECISION = 1_000_000_000n; // 1e9

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`update_usd_multiplier (${network})`);

  const newMultArg = parseArg('new');
  if (!newMultArg) {
    throw new Error(
      'Required: --new=<1e9-scaled multiplier>. e.g. --new=1000133680 for ~$1.000134'
    );
  }
  const newMultiplier = BigInt(newMultArg);
  if (newMultiplier <= 0n) {
    throw new Error('--new must be > 0.');
  }
  if (newMultiplier <= PRECISION) {
    logger.warning(
      `--new (${newMultiplier}) <= PRECISION (${PRECISION}); ` +
        `this will revert if the current on-chain multiplier is >= this value.`
    );
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  const okuDollarProgramAddr =
    deployment?.programs?.okuDollarProgram ?? (deployment?.programs as any)?.okuDollar;
  if (!okuDollarProgramAddr) {
    throw new Error(`No okuDollar deployment for ${network}; run deploy:init first.`);
  }
  if (!deployment?.programs?.litePsm) {
    throw new Error(
      `No litePsm deployment for ${network}; update_usd_multiplier reads psm_config for yield lock.`
    );
  }

  const okuDollarId = new PublicKey(okuDollarProgramAddr);
  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.OkuDollar as Program<OkuDollar>;
  const [vaultConfig] = deriveVaultConfigPDA(okuDollarId);
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.okuDollarConfig.fetch(vaultConfig);
  const oldMultiplier = BigInt(cfg.usdMultiplier.toString());
  const fmtUsd = (m: bigint) => `$${(Number(m) / Number(PRECISION)).toFixed(9)}`;

  if (newMultiplier <= oldMultiplier) {
    throw new Error(
      `New multiplier (${newMultiplier}) must be strictly greater than current (${oldMultiplier}). ` +
        `Contract enforces MultiplierCannotDecrease.`
    );
  }

  const bumpAbs = newMultiplier - oldMultiplier;
  const bumpPct = (Number(bumpAbs) / Number(oldMultiplier) * 100).toFixed(6);

  logger.info(
    summaryBlock('update_usd_multiplier()', {
      'config PDA': vaultConfig.toBase58(),
      'psm_config PDA': psmConfig.toBase58(),
      'usd_oku_mint': cfg.usdOkuMint.toBase58(),
      'reserve_vault': cfg.reserveVault.toBase58(),
      'current multiplier': `${fmtUsd(oldMultiplier)} (${oldMultiplier})`,
      'new multiplier': `${fmtUsd(newMultiplier)} (${newMultiplier})`,
      'bump': `+${bumpAbs} (+${bumpPct}%)`,
      'signer (usd_rebaser)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    summaryBlock('update_usd_multiplier()', {
      'current': fmtUsd(oldMultiplier),
      'new': fmtUsd(newMultiplier),
      'bump': `+${bumpPct}%`,
    })
  );

  const sig = await program.methods
    .updateUsdMultiplier(new BN(newMultiplier.toString()))
    .accountsPartial({
      usdRebaser: provider.wallet.publicKey,
      config: vaultConfig,
      reserveVault: cfg.reserveVault,
      usdOkuMint: cfg.usdOkuMint,
      psmConfig,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  logger.success(`tx: ${sig}`);

  const after = await program.account.okuDollarConfig.fetch(vaultConfig);
  logger.info(`new usd_multiplier: ${after.usdMultiplier.toString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
