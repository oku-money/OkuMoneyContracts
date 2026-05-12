/**
 * Skip the bridge nonce for a destination chain (emergency recovery).
 *
 * Wraps `lite_psm::skip_nonce` (nonce_admin-gated). Bumps
 * `bridge_nonce.next_nonce` past stuck/dropped requests. The handler
 * enforces strict monotonicity (`new > old`) AND a maximum per-call
 * delta (`MAX_NONCE_SKIP` from `constants.rs`) so a fat-finger can't
 * push `next_nonce` near `u64::MAX`.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/skip-nonce.ts \
 *       --chain-id=<u16> --new-nonce=<u64>
 *   NETWORK=mainnet-beta tsx scripts/admin/skip-nonce.ts \
 *       --chain-id=<u16> --new-nonce=<u64> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey, SystemProgram } from '@solana/web3.js';
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
  logger.header(`skip_nonce (${network})`);

  const chainIdArg = parseArg('chain-id');
  const newNonceArg = parseArg('new-nonce');
  if (chainIdArg === undefined || newNonceArg === undefined) {
    throw new Error('Required: --chain-id=<u16> --new-nonce=<u64>');
  }
  const chainId = Number(chainIdArg);
  if (!Number.isInteger(chainId) || chainId < 0 || chainId > 0xffff) {
    throw new Error('--chain-id must be an integer in [0, 65535].');
  }
  const newNonce = new BN(newNonceArg);
  if (newNonce.isNeg()) throw new Error('--new-nonce must be >= 0.');

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  // Derive BridgeNonce PDA: seeds = [BridgeNonce::SEED, &destination_chain_id.to_le_bytes()]
  const chainIdLe = Buffer.from([chainId & 0xff, (chainId >> 8) & 0xff]);
  const [bridgeNonce] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_nonce'), chainIdLe],
    litePsmId
  );

  let currentNext: BN | null = null;
  try {
    const noncePda = await program.account.bridgeNonce.fetch(bridgeNonce);
    currentNext = noncePda.nextNonce as BN;
  } catch {
    // Not yet initialized — `init_if_needed` will create it.
  }

  logger.info(
    summaryBlock('skip_nonce()', {
      'bridge_config PDA': bridgeConfig.toBase58(),
      'bridge_nonce PDA': bridgeNonce.toBase58(),
      'chain_id': String(chainId),
      'current next_nonce': currentNext ? currentNext.toString() : '(uninitialised)',
      'new next_nonce': newNonce.toString(),
      'signer (nonce_admin)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (currentNext && newNonce.lte(currentNext)) {
    throw new Error(
      `--new-nonce (${newNonce}) must be strictly greater than current ` +
        `next_nonce (${currentNext}); program enforces NonceNotMonotonic.`
    );
  }

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `skip_nonce(chain_id=${chainId}, new=${newNonce.toString()}) on mainnet`
  );

  const sig = await program.methods
    .skipNonce(chainId, newNonce)
    .accountsPartial({
      nonceAdmin: provider.wallet.publicKey,
      bridgeConfig,
      bridgeNonce,
      systemProgram: SystemProgram.programId,
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
