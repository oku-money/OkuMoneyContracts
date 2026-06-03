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
  verifyDeployment,
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
  };

  logger.info('Found deployed programs:');
  logger.info(`  lite_psm: ${programIds.litePsm.toBase58()}`);
  logger.info(`  oku_dollar: ${programIds.okuDollar.toBase58()}`);
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
      vaultConfig: vaultConfig.toBase58(),
      // PSM-owned ATAs (created by `initialize()` / `setup_oku_money_escrow()`).
      // Persisted so admin/test scripts can read them without re-deriving
      // from mint+config at every call site.
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
      orchestrator: authorities.psm.rebaser.toBase58(),
    },
  };

  saveDeployment(network, deployment);

  // Mirror into the repo-root testnet-addresses.json registry (non-localnet only).
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
