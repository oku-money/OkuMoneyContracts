/**
 * Set the OkuDollar minimum collateral ratio (role_admin-gated).
 *
 * Wraps `oku_dollar::set_min_collateral_ratio`. The instruction enforces a
 * live-health gate: if the proposed floor is above the current vault's
 * collateralization, the tx reverts with `InsufficientCollateral`. To raise
 * the floor above current health, call `deposit_reserves` first.
 *
 * Scale: PRECISION = 1e9 = 100%. So 1.05e9 = 105%.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-min-collateral-ratio.ts --ratio=1050000000
 *   NETWORK=mainnet-beta tsx scripts/admin/set-min-collateral-ratio.ts \
 *       --ratio=1050000000 --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit, just print intent
 */

import * as anchor from '@anchor-lang/core';
import { Program, BN } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { OkuDollar } from '../../target/types/oku_dollar';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { deriveVaultConfigPDA, derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

const PRECISION = 1_000_000_000n; // 1e9 — matches PRECISION in oku-shared

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`set_min_collateral_ratio (${network})`);

  const ratioArg = parseArg('ratio');
  if (!ratioArg) {
    throw new Error('Required: --ratio=<1e9-scaled ratio>. e.g. --ratio=1050000000 for 105%');
  }
  const newRatio = BigInt(ratioArg);
  if (newRatio <= 0n) {
    throw new Error('--ratio must be > 0');
  }
  if (newRatio > PRECISION) {
    // The handler enforces `<= PRECISION`. Catch typos before sending.
    throw new Error(`--ratio (${newRatio}) > PRECISION (${PRECISION}); contract rejects RatioExceedsMax`);
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.okuDollar) {
    throw new Error(`No deployment for ${network}; run deploy:programs first.`);
  }
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No litePsm deployment for ${network}; oku_dollar reads psm_config.oku_m_price.`);
  }

  const okuDollarId = new PublicKey(deployment.programs.okuDollar);
  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.OkuDollar as Program<OkuDollar>;
  const [vaultConfig] = deriveVaultConfigPDA(okuDollarId);
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.okuDollarConfig.fetch(vaultConfig);
  const oldRatio = BigInt(cfg.minCollateralRatio.toString());
  const fmtPct = (r: bigint) => `${(Number(r) / Number(PRECISION) * 100).toFixed(4)}%`;

  logger.info(
    summaryBlock('set_min_collateral_ratio()', {
      'config PDA': vaultConfig.toBase58(),
      'psm_config PDA': psmConfig.toBase58(),
      'usd_oku_mint': cfg.usdOkuMint.toBase58(),
      'reserve_vault': cfg.reserveVault.toBase58(),
      'old ratio': `${fmtPct(oldRatio)} (${oldRatio})`,
      'new ratio': `${fmtPct(newRatio)} (${newRatio})`,
      'signer (role_admin)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (newRatio > oldRatio) {
    logger.warning(
      'Raising the floor — instruction will revert if live collateralization is below the proposed value. ' +
      'Call deposit-reserves first if needed.'
    );
  }

  if (isDryRun()) {
    logger.success('--dry-run set; not submitting.');
    return;
  }

  await confirmIfMainnet(
    network,
    summaryBlock('set_min_collateral_ratio()', {
      old: `${fmtPct(oldRatio)}`,
      new: `${fmtPct(newRatio)}`,
    })
  );

  const sig = await program.methods
    .setMinCollateralRatio(new BN(newRatio.toString()))
    .accountsPartial({
      roleAdmin: provider.wallet.publicKey,
      config: vaultConfig,
      usdOkuMint: cfg.usdOkuMint,
      reserveVault: cfg.reserveVault,
      psmConfig,
    })
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
