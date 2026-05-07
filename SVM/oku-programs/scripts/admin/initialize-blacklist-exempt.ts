/**
 * One-shot post-init admin call: lock down `PsmConfig.blacklist_exempt_bridge`
 * and `PsmConfig.blacklist_exempt_router` so `freeze_account` cannot freeze
 * the bridge or router PDAs.
 *
 * Default values are derived as:
 *   - blacklist_exempt_bridge = lite-psm BridgeConfig PDA
 *   - blacklist_exempt_router = oku_bridge_router program ID
 *
 * Both can be overridden via --bridge=<pubkey> / --router=<pubkey>. The
 * on-chain handler rejects default-pubkey arguments and the one-shot guard
 * fires once both fields are non-default; this script idempotently no-ops
 * if already initialised.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/initialize-blacklist-exempt.ts
 *   NETWORK=mainnet-beta tsx scripts/admin/initialize-blacklist-exempt.ts \
 *       --bridge=<pubkey> --router=<pubkey>
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA, deriveBridgeConfigPDA } from '../utils/pdaHelpers';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`initialize_blacklist_exempt (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);

  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No deployment for ${network}; run deploy:programs first.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const routerId = deployment.programs?.okuBridgeRouter
    ? new PublicKey(deployment.programs.okuBridgeRouter)
    : undefined;

  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  const bridgeOverride = parseArg('bridge');
  const routerOverride = parseArg('router');

  const bridge = new PublicKey(bridgeOverride ?? bridgeConfig.toBase58());
  if (!routerOverride && !routerId) {
    throw new Error(
      'Router program ID not in deployment file and --router=<pubkey> not supplied.'
    );
  }
  const router = new PublicKey(routerOverride ?? routerId!.toBase58());

  // Idempotency: read the current PsmConfig and skip if already locked down.
  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const cur = {
    bridge: (cfg.blacklistExemptBridge as PublicKey),
    router: (cfg.blacklistExemptRouter as PublicKey),
  };
  if (
    !cur.bridge.equals(PublicKey.default) &&
    !cur.router.equals(PublicKey.default)
  ) {
    logger.success('Already initialized:');
    logger.info(`  bridge = ${cur.bridge.toBase58()}`);
    logger.info(`  router = ${cur.router.toBase58()}`);
    return;
  }

  logger.info(`bridge = ${bridge.toBase58()}`);
  logger.info(`router = ${router.toBase58()}`);

  const sig = await program.methods
    .initializeBlacklistExempt(bridge, router)
    .accountsPartial({
      roleAdmin: provider.wallet.publicKey,
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
