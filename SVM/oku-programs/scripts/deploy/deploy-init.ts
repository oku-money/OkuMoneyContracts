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
  };

  logger.info('Found deployed programs:');
  logger.info(`  lite_psm: ${programIds.litePsm.toBase58()}`);
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

  // Deploy mock USDC (idempotent — reuses any mint already in the deployment file)
  const { usdcMint } = await deployTokens(
    provider,
    psmConfigPDA,
    network
  );
  logger.log('');

  // Initialize PSM (single-token model: OkuM mint created on-chain
  // by the initialize instruction with ScaledUiAmount extension)
  const {
    psmConfig,
    okuMMint,
    vaultUsdc: psmVaultUsdc,
    vaultOkuM: psmOkuMEscrow,
  } = await initializePsm(
    provider,
    programIds.litePsm,
    usdcMint,
    authorities,
    config,
    networkConfig
  );
  logger.log('');

  // Save complete deployment
  const deployment: DeploymentAddresses = {
    network,
    timestamp: new Date().toISOString(),
    tokens: {
      usdc: usdcMint.toBase58(),
      okuM: okuMMint.toBase58(),
    },
    programs: existingDeployment.programs,
    pdas: {
      psmConfig: psmConfig.toBase58(),
      psmVaultUsdc: psmVaultUsdc.toBase58(),
      psmOkuMoneyEscrow: psmOkuMEscrow.toBase58(),
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
