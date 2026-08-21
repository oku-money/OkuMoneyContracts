/**
 * Distribute dollar-denominated yield across all OkuM holders.
 *
 * Wraps `lite_psm::distribute_yield` (rebaser-gated). The handler computes
 *   new_multiplier = old_multiplier + (yield_amount * 1e9 / total_supply)
 * and stamps `last_yield_distribution_slot = Clock::slot` so subsequent
 * mints/redeems in the same slot are rejected.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/distribute-yield.ts --amount=1000000   # 1 USD
 *   NETWORK=mainnet-beta tsx scripts/admin/distribute-yield.ts \
 *       --amount=<6dec> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getMint, getScaledUiAmountConfig } from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`distribute_yield (${network})`);

  const amountArg = parseArg('amount');
  if (!amountArg) {
    throw new Error('Required: --amount=<6-decimal yield amount>');
  }
  const amount = new BN(amountArg);
  if (amount.isNeg() || amount.isZero()) {
    throw new Error('--amount must be > 0.');
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment.tokens?.okuM) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const okuMMint = new PublicKey(deployment.tokens?.okuM);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  // The multiplier lives on the mint's ScaledUiAmountConfig extension, NOT on
  // PsmConfig. Reading `cfg.multiplier` (as this script previously did) yields
  // `undefined` — the field was removed when the multiplier moved to the mint.
  const readMultiplier = async (): Promise<string> => {
    const mintInfo = await getMint(provider.connection, okuMMint, undefined, TOKEN_2022_PROGRAM_ID);
    const scaled = getScaledUiAmountConfig(mintInfo);
    if (!scaled) return '<ScaledUiAmount extension missing>';
    const now = Math.floor(Date.now() / 1000);
    const effective =
      Number(scaled.newMultiplier) > 0 && now >= Number(scaled.newMultiplierEffectiveTimestamp)
        ? scaled.newMultiplier
        : scaled.multiplier;
    return String(effective);
  };

  logger.info(
    summaryBlock('distribute_yield()', {
      'config PDA': psmConfig.toBase58(),
      'OkuM mint': okuMMint.toBase58(),
      'current multiplier': await readMultiplier(),
      'yield amount (6dec)': amount.toString(),
      'signer (rebaser)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `distribute_yield(${amount.toString()}) on mainnet — bumps multiplier`
  );

  const sig = await program.methods
    .distributeYield(amount)
    .accountsPartial({
      rebaser: provider.wallet.publicKey,
      config: psmConfig,
      okuMMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  logger.success(`tx: ${sig}`);

  logger.info(`new multiplier: ${await readMultiplier()}`);
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Failed: ${err.message ?? String(err)}`);
  console.error(err);
  process.exit(1);
});
