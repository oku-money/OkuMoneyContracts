/**
 * Set the usdOku multiplier directly (rebaser-only).
 *
 * Wraps `lite_psm::set_multiplier`. The multiplier is never allowed to
 * decrease and is capped by `MAX_MULTIPLIER`. Stamps the
 * `last_yield_distribution_slot` so PSM/vault operations in the same
 * slot are rejected (sandwich prevention). SVM equivalent of EVM's
 * `LitePSM.setMultiplier`.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-multiplier.ts --new=<1e9-scaled>
 *   NETWORK=mainnet-beta tsx scripts/admin/set-multiplier.ts \
 *       --new=<1e9-scaled> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 *
 * Scale: multipliers are stored at 1e9 precision. `1_000_000_000` means 1x.
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
  logger.header(`set_multiplier (${network})`);

  const newMultiplierArg = parseArg('new');
  if (!newMultiplierArg) {
    throw new Error('Required: --new=<1e9-scaled multiplier, e.g. 1000000000 for 1x>');
  }
  const newMultiplier = new BN(newMultiplierArg);
  if (newMultiplier.isNeg() || newMultiplier.isZero()) {
    throw new Error('--new must be > 0.');
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment.tokens?.usdOku) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const usdOkuMint = new PublicKey(deployment.tokens.usdOku);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const oldMultiplier = cfg.multiplier as BN;
  logger.info(
    summaryBlock('set_multiplier()', {
      'config PDA': psmConfig.toBase58(),
      'usdOku mint': usdOkuMint.toBase58(),
      'current multiplier (1e9)': oldMultiplier.toString(),
      'new multiplier (1e9)': newMultiplier.toString(),
      'signer (rebaser)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (newMultiplier.lt(oldMultiplier)) {
    throw new Error(
      `Multiplier cannot decrease (program enforces MultiplierCannotDecrease); ` +
        `current ${oldMultiplier.toString()}, requested ${newMultiplier.toString()}.`
    );
  }

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `set_multiplier(${newMultiplier.toString()}) on mainnet — atomic multiplier bump`
  );

  const sig = await program.methods
    .setMultiplier(newMultiplier)
    .accountsPartial({
      rebaser: provider.wallet.publicKey,
      config: psmConfig,
      usdOkuMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  logger.success(`tx: ${sig}`);

  const after = await program.account.psmConfig.fetch(psmConfig);
  logger.info(`new multiplier: ${after.multiplier.toString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
