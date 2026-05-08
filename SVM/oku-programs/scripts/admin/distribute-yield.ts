/**
 * Distribute dollar-denominated yield across all OkuMoney holders.
 *
 * Wraps `lite_psm::distribute_yield` (rebaser-gated). The handler computes
 *   new_oku_m_price = old_oku_m_price + (yield_amount * 1e9 / total_supply)
 * and stamps `last_yield_distribution_slot = Clock::slot` so subsequent
 * mints/redeems/wraps/unwraps in the same slot are rejected.
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
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
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
  if (!deployment?.programs?.litePsm || !deployment.tokens?.okuMoney) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const okuMoneyMint = new PublicKey(deployment.tokens.okuMoney);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  logger.info(
    summaryBlock('distribute_yield()', {
      'config PDA': psmConfig.toBase58(),
      'okuMoney mint': okuMoneyMint.toBase58(),
      'current oku_m_price': cfg.okuMPrice.toString(),
      'yield amount (6dec)': amount.toString(),
      'signer (rebaser)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `distribute_yield(${amount.toString()}) on mainnet — bumps oku_m_price`
  );

  const sig = await program.methods
    .distributeYield(amount)
    .accountsPartial({
      rebaser: provider.wallet.publicKey,
      config: psmConfig,
      okuMoneyMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  logger.success(`tx: ${sig}`);

  const after = await program.account.psmConfig.fetch(psmConfig);
  logger.info(`new oku_m_price: ${after.okuMPrice.toString()}`);
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Failed: ${err.message ?? String(err)}`);
  console.error(err);
  process.exit(1);
});
