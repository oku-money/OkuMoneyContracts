/**
 * Add a destination chain to the bridge's supported set.
 *
 * Wraps `lite_psm::add_supported_chain` (chain_manager-gated). Chain IDs
 * here are protocol-internal u16 values, NOT EIP-155 chain IDs — see
 * `SVM/EVM_VS_SVM.md` for the mapping. Refuses duplicates
 * (`ChainAlreadySupported`).
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/add-supported-chain.ts --chain-id=<u16>
 *   NETWORK=mainnet-beta tsx scripts/admin/add-supported-chain.ts \
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
  logger.header(`add_supported_chain (${network})`);

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
    summaryBlock('add_supported_chain()', {
      'bridge_config PDA': bridgeConfig.toBase58(),
      'chain_id': String(chainId),
      'signer (chain_manager)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `add_supported_chain(${chainId}) on mainnet — enables a new bridge destination`
  );

  const sig = await program.methods
    .addSupportedChain(chainId)
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
