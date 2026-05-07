/**
 * Rotate the bridge orchestrator signing key.
 *
 * Calls `lite_psm::update_orchestrator_signer` (signer_manager-gated). On
 * mainnet the new key MUST be a KMS-backed wallet; this script's only job is
 * to land the rotation tx — it does NOT touch keys on disk.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/rotate-orchestrator.ts \
 *       --new=<base58 pubkey>
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { deriveBridgeConfigPDA } from '../utils/pdaHelpers';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`update_orchestrator_signer (${network})`);

  const newSignerStr = parseArg('new');
  if (!newSignerStr) {
    throw new Error('Missing --new=<base58 pubkey>');
  }
  const newSigner = new PublicKey(newSignerStr);
  if (newSigner.equals(PublicKey.default)) {
    throw new Error('New signer cannot be the zero pubkey.');
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No deployment for ${network}; run deploy:programs first.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  const cfg = await program.account.bridgeConfig.fetch(bridgeConfig);
  const old = cfg.orchestratorSigner as PublicKey;
  logger.info(`current orchestrator: ${old.toBase58()}`);
  logger.info(`new orchestrator:     ${newSigner.toBase58()}`);
  if (old.equals(newSigner)) {
    logger.warning('Already set to that key — no-op.');
    return;
  }

  const sig = await program.methods
    .updateOrchestratorSigner(newSigner)
    .accountsPartial({
      signerManager: provider.wallet.publicKey,
      bridgeConfig,
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
