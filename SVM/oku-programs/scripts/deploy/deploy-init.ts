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

import * as fs from 'fs';
import * as path from 'path';
import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { decodePsmConfig } from '../upgrade/preState';

import { detectNetwork, createProvider,
  createProviderWithClusterCheck, getNetworkConfig } from '../utils/network';
import { confirmIfMainnet } from '../admin/_lib/confirm';
import { logger } from '../utils/logger';
import { loadDeployment, loadDeploymentStrict, saveDeployment, DeploymentAddresses } from '../utils/addressBook';
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

async function readPsmConfig(
  provider: Awaited<ReturnType<typeof createProviderWithClusterCheck>>,
  psmConfig: PublicKey
): Promise<any> {
  const info = await provider.connection.getAccountInfo(psmConfig, 'confirmed');
  if (!info) throw new Error(`PsmConfig ${psmConfig.toBase58()} not found after initialize`);
  const idl = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'target/idl/lite_psm.json'), 'utf-8'));
  return decodePsmConfig(idl, info.data);
}

async function onChainAuthorities(
  provider: Awaited<ReturnType<typeof createProviderWithClusterCheck>>,
  psmConfig: PublicKey
): Promise<{ coldMultisig: string; warmMultisig: string; orchestrator: string }> {
  const cfg = await readPsmConfig(provider, psmConfig);
  return {
    coldMultisig: cfg.roleAdmin.toBase58(),
    warmMultisig: cfg.pauser.toBase58(),
    orchestrator: cfg.rateManager.toBase58(),
  };
}

async function main() {
  const startTime = Date.now();

  logger.header('OkuMoney SVM - Initialize Programs');

  const network = detectNetwork();
  const networkConfig = getNetworkConfig(network);
  const config = getDeploymentConfig(network);

  logger.info(`Network: ${network}`);
  logger.info(`Cluster: ${networkConfig.cluster}`);
  logger.log('');

  // Load existing deployment (must have program IDs from deploy-programs)
  const existingDeployment = loadDeploymentStrict(network);
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

  // Create provider. Cluster-checked — see deploy-programs.ts.
  const provider = await createProviderWithClusterCheck(network);
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

  await confirmIfMainnet(
    network,
    [
      `network   ${network}`,
      `deployer  ${deployerPubkey.toBase58()}`,
      `program   ${programIds.litePsm.toBase58()}`,
      `action    initialize psm_config + mints (irreversible)`,
    ].join('\n'),
    provider.connection
  );

  // Derive PSM config PDA (needed for mint authority)
  const [psmConfigPDA] = derivePsmConfigPDA(programIds.litePsm);

  // Resolve the reserve mint: the configured Circle USDC on mainnet (no mock is
  // ever created there), else the mock USDC (idempotent — reuses any mint already
  // in the deployment file). Cyfrin audit finding #4.
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
    },
    // Read back from chain, not from the intended config: `initialize` forces
    // role_admin = the deployer whatever MAINNET_COLD_MULTISIG says, and the
    // record must say who actually holds it (README § Mainnet ceremony).
    authorities: await onChainAuthorities(provider, psmConfig),
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
  const litePsmId = finalDeployment.programs?.litePsm
    ? new PublicKey(finalDeployment.programs.litePsm)
    : undefined;
  const configuredUsdc = networkConfig.usdc.isNative ? undefined : networkConfig.usdc.mint;
  if (!(await verifyDeployment(provider, finalDeployment, litePsmId, configuredUsdc))) {
    throw new Error('Deployment verification failed: see the errors above');
  }

  // PSM minting state (Cyfrin audit finding #2). `initialize` is idempotent and
  // may have been skipped against an existing config, so read the chain.
  const onChainCfg = await readPsmConfig(provider, psmConfig);
  const allowance = onChainCfg.minterAllowance.toString();
  if (allowance === '0') {
    logger.info('PSM minter_allowance: 0 (PSM minting CLOSED until the multiplier matches the fleet; README § Opening PSM minting on a chain)');
  } else if (config.minterAllowance.isZero()) {
    throw new Error(
      `PsmConfig minter_allowance is ${allowance} but this deploy requires PSM minting closed (0). ` +
        'Have the allowance_manager run set_minter_allowance(0) before anything else.'
    );
  } else {
    logger.info(`PSM minter_allowance: ${allowance}`);
  }

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
