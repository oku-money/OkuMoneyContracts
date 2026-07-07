/**
 * Pause the OkuDollar vault (emergency lever).
 * Wraps `oku_dollar::pause` (pauser-gated).
 *
 * Sibling of pause-psm.ts; the two pauses are independent. An incident may
 * require pausing both (psm + vault); operators should call both scripts.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/pause-vault.ts
 *   NETWORK=mainnet-beta tsx scripts/admin/pause-vault.ts --yes-i-mean-it-on-mainnet
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
  logger.header(`pause vault (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  const okuDollarAddr =
    deployment?.programs?.okuDollarProgram ?? (deployment?.programs as any)?.okuDollar;
  if (!okuDollarAddr) throw new Error(`No deployment for ${network}.`);

  const okuDollarId = new PublicKey(okuDollarAddr);
  const program = anchor.workspace.OkuDollar as Program<OkuDollar>;
  const [vaultConfig] = deriveVaultConfigPDA(okuDollarId);

  const cfg = await program.account.okuDollarConfig.fetch(vaultConfig);
  if (cfg.isPaused) {
    logger.warning('Vault already paused — no-op.');
    return;
  }
  logger.info(
    summaryBlock('pause()', {
      'config PDA': vaultConfig.toBase58(),
      'signer (pauser)': provider.wallet.publicKey.toBase58(),
    })
  );
  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, 'EMERGENCY: pause the OkuDollar vault on mainnet');

  const sig = await program.methods
    .pause()
    .accountsPartial({ pauser: provider.wallet.publicKey, config: vaultConfig })
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
