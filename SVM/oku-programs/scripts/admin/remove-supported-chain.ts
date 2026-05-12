/**
 * Remove a destination chain from the bridge's supported set.
 *
 * Wraps `lite_psm::remove_supported_chain` (chain_manager-gated). After
 * removal, `bridge_burn` to that chain rejects with
 * `ChainNotSupported`. In-flight requests (already burned + signed by
 * the orchestrator) continue to function — only NEW burns are blocked.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/remove-supported-chain.ts --chain-id=<u16>
 *   NETWORK=mainnet-beta tsx scripts/admin/remove-supported-chain.ts \
 *       --chain-id=<u16> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { deriveBridgeConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`remove_supported_chain (${network})`);

  const chainIdArg = parseArg('chain-id');
  if (chainIdArg === undefined) throw new Error('Required: --chain-id=<u16>');
  const chainId = Number(chainIdArg);
  if (!Number.isInteger(chainId) || chainId < 0 || chainId > 0xffff) {
    throw new Error('--chain-id must be an integer in [0, 65535].');
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  logger.info(
    summaryBlock('remove_supported_chain()', {
      'bridge_config PDA': bridgeConfig.toBase58(),
      'chain_id': String(chainId),
      'signer (chain_manager)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `remove_supported_chain(${chainId}) on mainnet — blocks NEW bridge_burns to this chain`
  );

  const sig = await program.methods
    .removeSupportedChain(chainId)
    .accountsPartial({
      chainManager: provider.wallet.publicKey,
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
