/**
 * Rotate the accepted Pyth program-owner pubkey.
 *
 * Lets the protocol migrate between Pyth deployments (e.g. legacy Pyth V2
 * <-> Pyth Solana Receiver) without redeploying the lite-psm program.
 * `oracle_manager`-gated; rejects the zero pubkey.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-pyth-program-owner.ts \
 *       --new=<pyth-program-id>
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
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
  logger.header(`set_pyth_program_owner (${network})`);

  const newOwnerStr = parseArg('new');
  if (!newOwnerStr) throw new Error('Missing --new=<pyth-program-id>');
  const newOwner = new PublicKey(newOwnerStr);
  if (newOwner.equals(PublicKey.default)) {
    throw new Error('New Pyth program owner cannot be the zero pubkey.');
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No deployment for ${network}; run deploy:programs first.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const old = cfg.pythProgramOwner as PublicKey;
  logger.info(
    summaryBlock('set_pyth_program_owner()', {
      'config PDA': psmConfig.toBase58(),
      'current Pyth owner': old.toBase58(),
      'new Pyth owner': newOwner.toBase58(),
      'signer (oracle_manager)': provider.wallet.publicKey.toBase58(),
    })
  );
  if (old.equals(newOwner)) {
    logger.warning('Already set to that program — no-op.');
    return;
  }

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `set_pyth_program_owner(${newOwner.toBase58()}) on mainnet — rotates accepted Pyth program ID`
  );

  const sig = await program.methods
    .setPythProgramOwner(newOwner)
    .accountsPartial({
      oracleManager: provider.wallet.publicKey,
      config: psmConfig,
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
