/**
 * Set the OkuMoney price directly (rebaser-only).
 *
 * Wraps `lite_psm::set_oku_m_price`. Price is never allowed to decrease
 * and is capped by `MAX_OKU_M_PRICE`. Stamps the
 * `last_yield_distribution_slot` so PSM/vault operations in the same
 * slot are rejected (sandwich prevention). SVM equivalent of EVM's
 * `LitePSM.setOkuMPrice`.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-oku-m-price.ts --new=<1e9-scaled>
 *   NETWORK=mainnet-beta tsx scripts/admin/set-oku-m-price.ts \
 *       --new=<1e9-scaled> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 *
 * Scale: prices are stored at 1e9 precision. `1_000_000_000` means $1.00.
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
  logger.header(`set_oku_m_price (${network})`);

  const newPriceArg = parseArg('new');
  if (!newPriceArg) {
    throw new Error('Required: --new=<1e9-scaled price, e.g. 1000000000 for $1.00>');
  }
  const newPrice = new BN(newPriceArg);
  if (newPrice.isNeg() || newPrice.isZero()) {
    throw new Error('--new must be > 0.');
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
  const oldPrice = cfg.okuMPrice as BN;
  logger.info(
    summaryBlock('set_oku_m_price()', {
      'config PDA': psmConfig.toBase58(),
      'okuMoney mint': okuMoneyMint.toBase58(),
      'current oku_m_price (1e9)': oldPrice.toString(),
      'new oku_m_price (1e9)': newPrice.toString(),
      'signer (rebaser)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (newPrice.lt(oldPrice)) {
    throw new Error(
      `Price cannot decrease (program enforces PriceCannotDecrease); ` +
        `current ${oldPrice.toString()}, requested ${newPrice.toString()}.`
    );
  }

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `set_oku_m_price(${newPrice.toString()}) on mainnet — atomic price bump`
  );

  const sig = await program.methods
    .setOkuMPrice(newPrice)
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

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
