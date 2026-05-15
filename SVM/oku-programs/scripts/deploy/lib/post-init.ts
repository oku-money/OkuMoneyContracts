/**
 * Post-init lockdown steps wired into `deploy:init`.
 *
 * These were previously documented as "run these admin scripts after
 * `deploy:init`" — easy to miss, easy to forget, and the deploy isn't
 * actually safe without them. Now they're idempotent final steps of
 * `deploy:init` itself.
 *
 * The standalone admin scripts under `scripts/admin/` remain available
 * for operators who need to re-run them later (e.g. against a partial
 * or recovered deployment); they share the same idempotency guarantees.
 *
 * Steps wired:
 *
 *   1. `initializeBlacklistExempt(litePsm, bridgeConfig, routerProgramId)`
 *      — locks down the two `PsmConfig.blacklist_exempt_*` fields so
 *      `freeze_account` cannot brick the bridge or router PDAs. One-shot
 *      on-chain: the handler rejects re-calls once both fields are
 *      non-default.
 *
 *   2. `setupRouterAltIfMissing(provider, deployment)` — creates the
 *      Address Lookup Table that `mint_usd_oku` / `redeem_usd_oku` need
 *      to fit under the v0 tx-size ceiling. Skips if
 *      `deployment.addressLookupTables.router` is already populated.
 *      Persists the resulting ALT pubkey into the deployment file.
 *
 * Both steps run AFTER `deploy:init`'s main path completes and the
 * deployment file has been written — so they can read freshly-persisted
 * PDAs (`psmConfig`, `bridgeConfig`, `routerConfig`, `psmVaultUsdc`,
 * `psmOkuMoneyEscrow`, `vaultOkuMoney`, `redemptionQueue`) instead of
 * re-deriving them.
 */

import {
  AddressLookupTableProgram,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Program, AnchorProvider } from '@anchor-lang/core';
import { logger } from '../../utils/logger';
import {
  DeploymentAddresses,
  loadDeployment,
  saveDeployment,
} from '../../utils/addressBook';
import { NetworkName } from '../../config/networks';
import {
  derivePsmConfigPDA,
  deriveBridgeConfigPDA,
} from '../../utils/pdaHelpers';
import { loadIdlWithAddress } from './programs';
import litePsmIdl from '../../../target/idl/lite_psm.json';

/**
 * Step 1: lock down `PsmConfig.blacklist_exempt_{bridge,router}`.
 *
 * Idempotent: reads the current `PsmConfig` and skips if both fields
 * are already non-default. The on-chain handler also enforces a
 * one-shot guard (`BlacklistExemptAlreadyInitialized`), so even if our
 * pre-check races, the worst case is a wasted tx-fee.
 */
export async function initializeBlacklistExemptIfNeeded(
  provider: AnchorProvider,
  litePsmId: PublicKey,
  routerProgramId: PublicKey
): Promise<void> {
  logger.nextStep('Initializing Blacklist Exempts (idempotent)');

  const idl = loadIdlWithAddress(litePsmIdl, litePsmId);
  const program = new Program(idl as any, provider);

  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  // Idempotency: read current state. PsmConfig stores `blacklist_exempt_bridge`
  // (camel: blacklistExemptBridge) and `blacklist_exempt_router`. The
  // `as any` on the AccountNamespace access mirrors the pattern in
  // `scripts/test/test-devnet.ts` — `Program<Idl>` is type-erased here,
  // so we lean on runtime Anchor decoding (tsx ignores; tsc flags it).
  const cfg: any = await (program.account as any).psmConfig.fetch(psmConfig);
  const curBridge = cfg.blacklistExemptBridge as PublicKey;
  const curRouter = cfg.blacklistExemptRouter as PublicKey;
  if (
    !curBridge.equals(PublicKey.default) &&
    !curRouter.equals(PublicKey.default)
  ) {
    logger.warning('Blacklist exempts already initialised — skipping');
    logger.info(`  bridge = ${curBridge.toBase58()}`);
    logger.info(`  router = ${curRouter.toBase58()}`);
    return;
  }

  logger.info(`bridge exempt = ${bridgeConfig.toBase58()}`);
  logger.info(`router exempt = ${routerProgramId.toBase58()}`);

  const sig = await program.methods
    .initializeBlacklistExempt(bridgeConfig, routerProgramId)
    .accountsPartial({
      roleAdmin: provider.wallet.publicKey,
      config: psmConfig,
    })
    .rpc();
  logger.success(`initialize_blacklist_exempt tx: ${sig}`);
}

/**
 * Step 2: create the router Address Lookup Table.
 *
 * Idempotent at the deployment-file level: if
 * `deployment.addressLookupTables.router` is already populated AND
 * still exists on chain, we skip. If the field is populated but the
 * ALT account is gone (deactivated/closed manually), we re-create.
 *
 * Persists the resulting ALT pubkey into the deployment file.
 */
export async function setupRouterAltIfMissing(
  provider: AnchorProvider,
  network: NetworkName
): Promise<PublicKey | null> {
  logger.nextStep('Setting up Router Address Lookup Table (idempotent)');

  const deployment = loadDeployment(network);
  if (!deployment) {
    throw new Error(
      `No deployment for ${network} — should never happen, deploy:init just wrote it.`
    );
  }

  // 1. Skip if already set up AND alive on chain.
  const existing = deployment.addressLookupTables?.router;
  if (existing) {
    const info = await provider.connection.getAccountInfo(
      new PublicKey(existing)
    );
    if (info) {
      logger.warning(`Router ALT already exists — skipping (${existing})`);
      return new PublicKey(existing);
    }
    logger.warning(
      `Router ALT pubkey in deployment file (${existing}) has no on-chain ` +
        `account — recreating.`
    );
  }

  // 2. Pull everything we need from the deployment file (now fully
  //    populated by Phase 13c's psmVaultUsdc + vaultOkuMoney additions).
  const required = [
    'programs.litePsm',
    'programs.okuDollarProgram',
    'programs.okuBridgeRouter',
    'tokens.usdc',
    'tokens.okuMoney',
    'tokens.usdOku',
    'pdas.psmConfig',
    'pdas.bridgeConfig',
    'pdas.vaultConfig',
    'pdas.routerConfig',
    'pdas.psmVaultUsdc',
    'pdas.psmOkuMoneyEscrow',
    'pdas.vaultOkuMoney',
    'pdas.redemptionQueue',
  ];
  const missing: string[] = [];
  const get = (path: string): string | undefined => {
    const [section, key] = path.split('.');
    return (deployment as any)[section]?.[key];
  };
  for (const p of required) {
    if (!get(p)) missing.push(p);
  }
  if (missing.length > 0) {
    throw new Error(
      `Router ALT setup needs these fields in deployments/${network}.json ` +
        `but they are missing: ${missing.join(', ')}. Did deploy:init complete?`
    );
  }

  const addresses: PublicKey[] = [
    // Program IDs
    new PublicKey(deployment.programs.litePsm!),
    new PublicKey(deployment.programs.okuDollarProgram!),
    new PublicKey(deployment.programs.okuBridgeRouter!),
    TOKEN_PROGRAM_ID,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    // Mints
    new PublicKey(deployment.tokens.usdc!),
    new PublicKey(deployment.tokens.okuMoney!),
    new PublicKey(deployment.tokens.usdOku!),
    // Config PDAs
    new PublicKey(deployment.pdas.psmConfig!),
    new PublicKey(deployment.pdas.bridgeConfig!),
    new PublicKey(deployment.pdas.vaultConfig!),
    new PublicKey(deployment.pdas.routerConfig!),
    // Vault accounts
    new PublicKey(deployment.pdas.psmVaultUsdc!),
    new PublicKey(deployment.pdas.psmOkuMoneyEscrow!),
    new PublicKey(deployment.pdas.vaultOkuMoney!),
    new PublicKey(deployment.pdas.redemptionQueue!),
  ];

  // 3. createLookupTable returns the [ix, derived-address] tuple. The
  //    address derives from (authority, recent-slot), so it's
  //    deterministic per slot — re-run between slots gives a different
  //    ALT, which is fine because we're tracking it in the deployment
  //    file.
  const slot = await provider.connection.getSlot('finalized');
  const [createIx, lookupTableAddress] =
    AddressLookupTableProgram.createLookupTable({
      authority: provider.wallet.publicKey,
      payer: provider.wallet.publicKey,
      recentSlot: slot,
    });

  // 4. Chunk extends at 20 entries per tx to stay under v0 tx-size limit.
  const CHUNK = 20;
  const extendIxs = [];
  for (let i = 0; i < addresses.length; i += CHUNK) {
    extendIxs.push(
      AddressLookupTableProgram.extendLookupTable({
        payer: provider.wallet.publicKey,
        authority: provider.wallet.publicKey,
        lookupTable: lookupTableAddress,
        addresses: addresses.slice(i, i + CHUNK),
      })
    );
  }

  const blockhash = (await provider.connection.getLatestBlockhash()).blockhash;
  const message = new TransactionMessage({
    payerKey: provider.wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [createIx, ...extendIxs],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const signed = await provider.wallet.signTransaction(tx);
  const sig = await provider.connection.sendTransaction(signed);
  await provider.connection.confirmTransaction(sig, 'confirmed');
  logger.success(`createLookupTable + extend tx: ${sig}`);
  logger.success(`router ALT: ${lookupTableAddress.toBase58()}`);

  // 5. Persist. saveDeployment merges, so we don't lose other fields.
  saveDeployment(network, {
    addressLookupTables: { router: lookupTableAddress.toBase58() },
  });

  logger.info('');
  logger.info(
    'Note: the ALT remains AUTHORIZED by the deployer key. For mainnet,'
  );
  logger.info(
    'rotate the authority to a multisig before relying on it (or revoke'
  );
  logger.info('with AddressLookupTableProgram.deactivateLookupTable).');

  return lookupTableAddress;
}
