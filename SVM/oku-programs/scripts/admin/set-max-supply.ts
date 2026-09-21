/**
 * Update the okuM max-supply cap.
 *
 * Wraps `lite_psm::set_max_supply` (cap_manager-gated). The handler
 * refuses any new cap below the current circulating supply -- that would
 * silently brick every subsequent `mint_oku_m`. EVM
 * `OkuM.setMaxSupply` parity.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-max-supply.ts --new=<6dec>
 *   NETWORK=mainnet-beta tsx scripts/admin/set-max-supply.ts \
 *       --new=<6dec> --yes-i-mean-it-on-mainnet
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
import { resolveRoleSigner, describeRoleSigner } from '../utils/roleSigner';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`set_max_supply (${network})`);

  const newCapArg = parseArg('new');
  if (!newCapArg) {
    throw new Error('Required: --new=<6-decimal cap, e.g. 1000000000000>');
  }
  const newCap = new BN(newCapArg);
  if (newCap.isNeg()) throw new Error('--new must be >= 0.');

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

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const capManager = resolveRoleSigner(provider, cfg, 'capManager');
  logger.info(
    summaryBlock('set_max_supply()', {
      'config PDA': psmConfig.toBase58(),
      'OkuM mint': okuMMint.toBase58(),
      'current max_supply': cfg.maxSupply.toString(),
      'new max_supply': newCap.toString(),
      'signer (cap_manager)': describeRoleSigner('capManager', capManager),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `set_max_supply(${newCap.toString()}) on mainnet — refuses cap below current supply`
  );

  const sig = await program.methods
    .setMaxSupply(newCap)
    .accountsPartial({
      capManager: capManager.authority,
      config: psmConfig,
      okuMMint,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers(capManager.signers)
    .rpc();
  logger.success(`tx: ${sig}`);

  const after = await program.account.psmConfig.fetch(psmConfig);
  logger.info(`new max_supply: ${after.maxSupply.toString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
