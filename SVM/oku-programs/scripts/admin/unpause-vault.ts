/**
 * Unpause the OkuDollar vault. Wraps `oku_dollar::unpause` (unpauser-gated;
 * on mainnet this should be the cold multisig).
 *
 * Sibling of unpause-psm.ts; the two unpauses are independent.
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { OkuDollar } from '../../target/types/oku_dollar';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { deriveVaultConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

async function main() {
  const network = detectNetwork();
  logger.header(`unpause vault (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.okuDollar) throw new Error(`No deployment for ${network}.`);

  const okuDollarId = new PublicKey(deployment.programs.okuDollar);
  const program = anchor.workspace.OkuDollar as Program<OkuDollar>;
  const [vaultConfig] = deriveVaultConfigPDA(okuDollarId);

  const cfg = await program.account.okuDollarConfig.fetch(vaultConfig);
  if (!cfg.isPaused) {
    logger.warning('Vault is not paused — no-op.');
    return;
  }
  logger.info(
    summaryBlock('unpause()', {
      'config PDA': vaultConfig.toBase58(),
      'signer (unpauser)': provider.wallet.publicKey.toBase58(),
    })
  );
  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, 'Unpause the OkuDollar vault on mainnet (resumes wrap/unwrap)');

  const sig = await program.methods
    .unpause()
    .accountsPartial({ unpauser: provider.wallet.publicKey, config: vaultConfig })
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
