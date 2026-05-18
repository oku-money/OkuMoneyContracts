/**
 * Configure or disable the PSM's reserve-attestation oracle.
 *
 * Calling with `--oracle=disable` (or `--oracle=11111111111111111111111111111111`)
 * sets the oracle to `Pubkey::default()`, which the runtime treats as
 * "oracle disabled". Otherwise sets the supplied feed and a staleness
 * threshold (in seconds, must lie in [60, 7 days] per the program's bounds).
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-oracle.ts \
 *       --oracle=<pyth-feed-pubkey> --staleness=300
 *   NETWORK=devnet tsx scripts/admin/set-oracle.ts --oracle=disable
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`set_oracle (${network})`);

  const oracleArg = parseArg('oracle');
  if (!oracleArg) {
    throw new Error('Missing --oracle=<pubkey> (or --oracle=disable to clear)');
  }
  const isDisable = oracleArg === 'disable';
  const oracle = isDisable
    ? PublicKey.default
    : new PublicKey(oracleArg);

  const stalenessArg = parseArg('staleness');
  let staleness = isDisable ? 0 : 300; // 5 minutes default
  if (stalenessArg !== undefined) {
    const n = Number.parseInt(stalenessArg, 10);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error(`Invalid --staleness: ${stalenessArg}`);
    }
    staleness = n;
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

  logger.info(`oracle:    ${isDisable ? '(disabled)' : oracle.toBase58()}`);
  logger.info(`staleness: ${staleness}s`);

  // `oracle_account` is required when configuring a non-default oracle so
  // the program can pre-flight the Pyth header (magic / version / expo)
  // before persisting the new pubkey. Pass `null` when disabling.
  const sig = await program.methods
    .setOracle(oracle, new BN(staleness))
    .accountsPartial({
      oracleManager: provider.wallet.publicKey,
      config: psmConfig,
      oracleAccount: isDisable ? null : oracle,
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
