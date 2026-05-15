#!/usr/bin/env tsx
/**
 * Phase 2: Initialize Programs
 * 
 * Creates tokens and initializes all program PDAs.
 * Run this AFTER deploy-programs.ts has succeeded.
 * 
 * Prerequisites:
 *   - Programs must be deployed (run deploy:programs first)
 *   - deployments/{network}.json must have program IDs
 * 
 * Usage:
 *   pnpm run deploy:init
 */

import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

import { detectNetwork, createProvider, getNetworkConfig } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment, saveDeployment, DeploymentAddresses } from '../utils/addressBook';
import { syncSvmRegistry } from '../utils/testnetRegistry';
import { loadAuthorities } from '../config/authorities';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';

// Import shared lib modules
import {
  getDeploymentConfig,
  deployTokens,
  initializePsm,
  initializeVault,
  initializeRouter,
  verifyDeployment,
  initializeBlacklistExemptIfNeeded,
  setupRouterAltIfMissing,
} from './lib';

// ============================================================================
// Helper Functions
// ============================================================================

function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(6);
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const startTime = Date.now();

  logger.header('OkuMoney SVM - Initialize Programs');

  const network = detectNetwork();
  const networkConfig = getNetworkConfig(network);
  const config = getDeploymentConfig();

  logger.info(`Network: ${network}`);
  logger.info(`Cluster: ${networkConfig.cluster}`);
  logger.log('');

  // Load existing deployment (must have program IDs from deploy-programs)
  const existingDeployment = loadDeployment(network);
  if (!existingDeployment?.programs?.litePsm) {
    throw new Error(
      `No program deployment found for ${network}. Run 'pnpm run deploy:programs' first.`
    );
  }

  const programIds = {
    litePsm: new PublicKey(existingDeployment.programs.litePsm),
    okuDollar: new PublicKey(existingDeployment.programs.okuDollarProgram),
    okuBridgeRouter: new PublicKey(existingDeployment.programs.okuBridgeRouter),
  };

  logger.info('Found deployed programs:');
  logger.info(`  lite_psm: ${programIds.litePsm.toBase58()}`);
  logger.info(`  oku_dollar: ${programIds.okuDollar.toBase58()}`);
  logger.info(`  oku_bridge_router: ${programIds.okuBridgeRouter.toBase58()}`);
  logger.log('');

  // Create provider
  const provider = createProvider(network);
  const authorities = loadAuthorities(
    network,
    provider.wallet.publicKey,
    programIds.litePsm
  );

  const deployerPubkey = provider.wallet.publicKey;
  const balance = await provider.connection.getBalance(deployerPubkey);
  logger.info(`Deployer: ${deployerPubkey.toBase58()}`);
  logger.info(`Balance: ${formatSol(balance)} SOL`);
  logger.log('');

  // Derive PSM config PDA (needed for mint authority)
  const [psmConfigPDA] = derivePsmConfigPDA(programIds.litePsm);

  // Deploy tokens (idempotent — reuses any mints already in the deployment file)
  const { usdcMint, okuMoneyMint } = await deployTokens(
    provider,
    psmConfigPDA,
    authorities,
    network
  );
  logger.log('');

  // Initialize PSM
  const {
    psmConfig,
    redemptionQueue,
    bridgeConfig,
    vaultUsdc: psmVaultUsdc,
    vaultOkuMoney: psmOkuMoneyEscrow,
  } = await initializePsm(
    provider,
    programIds.litePsm,
    usdcMint,
    okuMoneyMint,
    authorities,
    config,
    networkConfig
  );
  logger.log('');

  // Initialize Vault
  const { vaultConfig, usdOkuMint, reserveVault: vaultOkuMoney } = await initializeVault(
    provider,
    programIds.okuDollar,
    programIds.litePsm,
    okuMoneyMint,
    authorities,
    config
  );
  logger.log('');

  // Initialize Router
  const { routerConfig } = await initializeRouter(
    provider,
    programIds.okuBridgeRouter,
    okuMoneyMint,
    usdOkuMint,
    authorities
  );
  logger.log('');

  // Save complete deployment
  const deployment: DeploymentAddresses = {
    network,
    timestamp: new Date().toISOString(),
    tokens: {
      usdc: usdcMint.toBase58(),
      okuMoney: okuMoneyMint.toBase58(),
      usdOku: usdOkuMint.toBase58(),
    },
    programs: existingDeployment.programs,
    pdas: {
      psmConfig: psmConfig.toBase58(),
      redemptionQueue: redemptionQueue.toBase58(),
      bridgeConfig: bridgeConfig.toBase58(),
      vaultConfig: vaultConfig.toBase58(),
      routerConfig: routerConfig.toBase58(),
      // PSM-owned ATAs (created by `initialize()` / `setup_oku_money_escrow()`).
      // Both are referenced by `admin:setup-router-alt` and admin/bridge
      // scripts; persist them rather than re-deriving from mint+config at
      // every call site.
      psmVaultUsdc: psmVaultUsdc.toBase58(),
      psmOkuMoneyEscrow: psmOkuMoneyEscrow.toBase58(),
      // Vault-owned OkuMoney reserve ATA, returned by `initializeVault`
      // as `reserveVault`. Distinct from `psmOkuMoneyEscrow` above:
      //   - `psmOkuMoneyEscrow` holds queued-redemption escrow on the PSM.
      //   - `vaultOkuMoney` holds the OkuDollar vault's reserves backing usdOku.
      vaultOkuMoney: vaultOkuMoney.toBase58(),
    },
    authorities: {
      coldMultisig: authorities.psm.roleAdmin.toBase58(),
      warmMultisig: authorities.psm.pauser.toBase58(),
      orchestrator: authorities.bridge.orchestratorSigner.toBase58(),
      feeRecipient: authorities.bridge.feeRecipient.toBase58(),
    },
  };

  saveDeployment(network, deployment);

  // -----------------------------------------------------------------
  // Post-init lockdown (idempotent — safe to re-run, no-ops on second
  // pass). Previously documented as "run these admin scripts after
  // deploy:init", which was easy to miss. Wiring them here removes the
  // human-error surface.
  // -----------------------------------------------------------------

  // Step 1: lock down `PsmConfig.blacklist_exempt_{bridge,router}` so
  // `freeze_account` cannot brick the bridge or router PDAs. One-shot
  // on-chain; the helper skips if already initialised.
  try {
    await initializeBlacklistExemptIfNeeded(
      provider,
      programIds.litePsm,
      programIds.okuBridgeRouter
    );
  } catch (err: any) {
    logger.warning(
      `Blacklist-exempt initialization failed (non-fatal): ${err.message}. ` +
        `Re-run manually with: npm run admin:blacklist-exempt`
    );
  }
  logger.log('');

  // Step 2: create the router Address Lookup Table so `mint_usd_oku`
  // and `redeem_usd_oku` fit under the v0 tx-size ceiling. The helper
  // skips if the ALT is already recorded in the deployment file AND
  // alive on chain.
  try {
    await setupRouterAltIfMissing(provider, network);
  } catch (err: any) {
    logger.warning(
      `Router ALT setup failed (non-fatal): ${err.message}. ` +
        `Re-run manually with: npm run admin:setup-router-alt`
    );
  }
  logger.log('');

  // Mirror into the repo-root testnet-addresses.json registry (non-localnet only)
  // — runs AFTER post-init so the registry captures the ALT too.
  if (network !== 'localnet') {
    try {
      const finalDeployment = loadDeployment(network)!;
      syncSvmRegistry(finalDeployment);
    } catch (err: any) {
      logger.warning(`Registry sync failed (non-fatal): ${err.message}`);
    }
  }

  // Verify — reads the latest persisted deployment file (post-ALT).
  const finalDeployment = loadDeployment(network)!;
  await verifyDeployment(provider, finalDeployment);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.log('');
  logger.header('Initialization Complete');
  logger.success(`Total time: ${duration}s`);
  logger.log('');
  logger.info('Deployment saved to: deployments/' + network + '.json');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Initialization failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
