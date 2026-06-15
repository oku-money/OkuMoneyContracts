/**
 * Configure or disable the USDC peg circuit-breaker (oracle relay).
 *
 * Wraps four `oracle_manager`-gated instructions on `lite_psm`:
 *
 *   - `set_oracle_relay_feed(new_feed)` — rotate the Pyth USDC/USD feed.
 *     `new_feed = 11111111111111111111111111111111` (`Pubkey::default()`)
 *     is the operational kill switch — disables the peg check entirely.
 *   - `set_oracle_relay_staleness(secs)` — bounded by [60s, 7 days].
 *   - `set_oracle_relay_band(min_e9, max_e9)` — peg window in 1e9 precision.
 *     Constrained by `ORACLE_USDC_PRICE_FLOOR = 0.95e9` and
 *     `ORACLE_USDC_PRICE_CEILING = 1.05e9`.
 *   - `set_oracle_relay_pyth_program_owner(new_owner)` — migration hook for
 *     future Pyth deployments.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-oracle-relay.ts set-feed \
 *       --feed=<pubkey>
 *   NETWORK=devnet tsx scripts/admin/set-oracle-relay.ts set-feed --feed=disable
 *   NETWORK=devnet tsx scripts/admin/set-oracle-relay.ts set-staleness --secs=3600
 *   NETWORK=devnet tsx scripts/admin/set-oracle-relay.ts set-band \
 *       --min=970000000 --max=1030000000
 *   NETWORK=devnet tsx scripts/admin/set-oracle-relay.ts set-pyth-program-owner \
 *       --new=<pubkey>
 *
 * `--dry-run` skips submission; mainnet requires `--yes-i-mean-it-on-mainnet`
 * (or an interactive prompt).
 */

import * as anchor from '@anchor-lang/core';
import { Program, BN } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

type Subcommand =
  | 'set-feed'
  | 'set-staleness'
  | 'set-band'
  | 'set-pyth-program-owner';

const SUBCOMMANDS: readonly Subcommand[] = [
  'set-feed',
  'set-staleness',
  'set-band',
  'set-pyth-program-owner',
] as const;

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

function parseSubcommand(): Subcommand {
  const positional = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!positional) {
    throw new Error(
      `Missing subcommand. Use one of: ${SUBCOMMANDS.join(' | ')}`
    );
  }
  if (!SUBCOMMANDS.includes(positional as Subcommand)) {
    throw new Error(
      `Unknown subcommand "${positional}". Use one of: ${SUBCOMMANDS.join(' | ')}`
    );
  }
  return positional as Subcommand;
}

async function main() {
  const network = detectNetwork();
  const subcommand = parseSubcommand();
  logger.header(`set-oracle-relay ${subcommand} (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No deployment for ${network}; run deploy:programs first.`);
  }
  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  switch (subcommand) {
    case 'set-feed': {
      const feedArg = parseArg('feed');
      if (!feedArg) {
        throw new Error('set-feed requires --feed=<pubkey> (or --feed=disable)');
      }
      const isDisable = feedArg === 'disable';
      const newFeed = isDisable ? PublicKey.default : new PublicKey(feedArg);

      logger.info(
        summaryBlock('set_oracle_relay_feed()', {
          network,
          config: psmConfig.toBase58(),
          new_feed: isDisable ? '(disabled / kill switch)' : newFeed.toBase58(),
          signer: provider.wallet.publicKey.toBase58(),
        })
      );

      if (isDryRun()) {
        logger.success('--dry-run set; not submitting.');
        return;
      }
      await confirmIfMainnet(
        network,
        `set_oracle_relay_feed(${isDisable ? 'disable' : newFeed.toBase58()})`
      );

      const sig = await program.methods
        .setOracleRelayFeed(newFeed)
        .accountsPartial({
          oracleManager: provider.wallet.publicKey,
          config: psmConfig,
          oracleAccount: isDisable ? null : newFeed,
        })
        .rpc();
      logger.success(`tx: ${sig}`);
      return;
    }

    case 'set-staleness': {
      const secsArg = parseArg('secs');
      if (!secsArg) {
        throw new Error('set-staleness requires --secs=<u64>');
      }
      const secs = Number.parseInt(secsArg, 10);
      if (!Number.isFinite(secs) || secs <= 0) {
        throw new Error(`Invalid --secs="${secsArg}"`);
      }

      logger.info(
        summaryBlock('set_oracle_relay_staleness()', {
          network,
          config: psmConfig.toBase58(),
          new_staleness_secs: String(secs),
          signer: provider.wallet.publicKey.toBase58(),
        })
      );

      if (isDryRun()) {
        logger.success('--dry-run set; not submitting.');
        return;
      }
      await confirmIfMainnet(network, `set_oracle_relay_staleness(${secs}s)`);

      const sig = await program.methods
        .setOracleRelayStaleness(new BN(secs))
        .accountsPartial({
          oracleManager: provider.wallet.publicKey,
          config: psmConfig,
          oracleAccount: null,
        })
        .rpc();
      logger.success(`tx: ${sig}`);
      return;
    }

    case 'set-band': {
      const minArg = parseArg('min');
      const maxArg = parseArg('max');
      if (!minArg || !maxArg) {
        throw new Error(
          'set-band requires --min=<u64> --max=<u64> (1e9 precision)'
        );
      }
      const minE9 = new BN(minArg);
      const maxE9 = new BN(maxArg);

      logger.info(
        summaryBlock('set_oracle_relay_band()', {
          network,
          config: psmConfig.toBase58(),
          new_min_e9: minE9.toString(),
          new_max_e9: maxE9.toString(),
          signer: provider.wallet.publicKey.toBase58(),
        })
      );

      if (isDryRun()) {
        logger.success('--dry-run set; not submitting.');
        return;
      }
      await confirmIfMainnet(
        network,
        `set_oracle_relay_band(${minE9.toString()}, ${maxE9.toString()})`
      );

      const sig = await program.methods
        .setOracleRelayBand(minE9, maxE9)
        .accountsPartial({
          oracleManager: provider.wallet.publicKey,
          config: psmConfig,
          oracleAccount: null,
        })
        .rpc();
      logger.success(`tx: ${sig}`);
      return;
    }

    case 'set-pyth-program-owner': {
      const newArg = parseArg('new');
      if (!newArg) {
        throw new Error('set-pyth-program-owner requires --new=<pubkey>');
      }
      const newOwner = new PublicKey(newArg);
      if (newOwner.equals(PublicKey.default)) {
        throw new Error('Pyth program owner cannot be the zero pubkey');
      }

      logger.info(
        summaryBlock('set_oracle_relay_pyth_program_owner()', {
          network,
          config: psmConfig.toBase58(),
          new_owner: newOwner.toBase58(),
          signer: provider.wallet.publicKey.toBase58(),
        })
      );

      if (isDryRun()) {
        logger.success('--dry-run set; not submitting.');
        return;
      }
      await confirmIfMainnet(
        network,
        `set_oracle_relay_pyth_program_owner(${newOwner.toBase58()})`
      );

      const sig = await program.methods
        .setOracleRelayPythProgramOwner(newOwner)
        .accountsPartial({
          oracleManager: provider.wallet.publicKey,
          config: psmConfig,
          oracleAccount: null,
        })
        .rpc();
      logger.success(`tx: ${sig}`);
      return;
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
