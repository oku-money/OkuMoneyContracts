#!/usr/bin/env tsx
/**
 * Unified Deployment Script for OkuMoney SVM Contracts
 *
 * Deploys all programs and configures them in a single execution.
 * Designed for fresh ephemeral deployments on Surfpool fork of devnet.
 *
 * Usage:
 *   # Local Surfpool fork (recommended for testing)
 *   surfpool start --rpc-url https://api.devnet.solana.com
 *   NETWORK=devnet-fork npm run deploy
 *
 *   # Live devnet (when ready)
 *   NETWORK=devnet npm run deploy
 *
 * Each run creates fresh tokens and programs - no state reuse.
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import * as readline from 'readline';

import { detectNetwork, createProvider, getNetworkConfig, isForkNetwork, getParentNetwork } from '../utils/network';
import { logger } from '../utils/logger';
import { clearDeployment, saveDeployment, hasDeployment, DeploymentAddresses } from '../utils/addressBook';
import { NETWORK_CONFIGS, getActiveRpcInfo } from '../config/networks';
import { loadAuthorities } from '../config/authorities';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';

// Import from lib modules
import {
  getDeploymentConfig,
  buildPrograms,
  restoreOriginalKeypairs,
  deployPrograms,
  deployTokens,
  initializePsm,
  initializeVault,
  initializeRouter,
  verifyDeployment,
} from './lib';

// ============================================================================
// Helper Functions
// ============================================================================

function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(6);
}

function isLiveNetwork(network: string): boolean {
  return network === 'devnet' || network === 'mainnet-beta';
}

async function confirmLiveDeployment(network: string): Promise<boolean> {
  if (process.argv.includes('--yes') || process.argv.includes('-y')) {
    return true;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    logger.warning(`\nExisting deployment found for ${network}.`);
    logger.warning('This will OVERWRITE the existing deployment addresses.');
    rl.question('\nProceed with deployment? (y/N): ', (answer) => {
      rl.close();
      resolve(answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes');
    });
  });
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const startTime = Date.now();

  logger.header('OkuMoney SVM Deployment');

  const network = detectNetwork();
  const networkConfig = getNetworkConfig(network);
  const isFork = isForkNetwork(network);
  const config = getDeploymentConfig();

  logger.info(`Network: ${network}`);
  logger.info(`Cluster: ${networkConfig.cluster}`);
  logger.info(`Mode: ${isFork ? 'Fork (fresh deploy)' : 'Live'}`);
  
  // Log RPC source for live networks
  if (!isFork && (network === 'devnet' || network === 'mainnet-beta')) {
    const rpcInfo = getActiveRpcInfo(network === 'devnet' ? 'devnet' : 'mainnet');
    logger.info(`RPC source: ${rpcInfo.source}`);
  }
  logger.log('');

  // Create provider first to get wallet info
  const provider = createProvider(network);
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  // Display deployer info and balance
  const deployerPubkey = provider.wallet.publicKey;
  const balance = await provider.connection.getBalance(deployerPubkey);
  logger.info(`Deployer: ${deployerPubkey.toBase58()}`);
  logger.info(`Balance: ${formatSol(balance)} SOL`);
  
  // For fork networks, also show the real balance on the parent network
  if (isFork) {
    const parentNetwork = getParentNetwork(network);
    const parentConfig = NETWORK_CONFIGS[parentNetwork];
    const parentConnection = new Connection(parentConfig.cluster, 'confirmed');
    try {
      const realBalance = await parentConnection.getBalance(deployerPubkey);
      logger.info(`Balance on ${parentNetwork}: ${formatSol(realBalance)} SOL (real)`);
    } catch (e) {
      logger.warning(`Could not fetch ${parentNetwork} balance`);
    }
  }
  logger.log('');

  // For live networks, check for existing deployment and confirm overwrite
  if (isLiveNetwork(network) && hasDeployment(network)) {
    const confirmed = await confirmLiveDeployment(network);
    if (!confirmed) {
      logger.info('Deployment cancelled.');
      process.exit(0);
    }
    logger.log('');
  }

  // For fork networks, always clear previous deployment (no confirmation needed)
  if (isFork) {
    logger.info('Clearing previous fork deployment...');
    clearDeployment(network);
  }

  // Step 1: Build programs (keeps fork keypairs in place for deployment)
  const { originalKeypairs } = await buildPrograms(isFork);
  logger.log('');

  // Step 2: Deploy programs
  let programIds;
  try {
    programIds = await deployPrograms(provider, isFork);
  } finally {
    // Always restore original keypairs after deployment attempt
    if (isFork) {
      restoreOriginalKeypairs(originalKeypairs);
    }
  }
  logger.log('');

  // Derive PSM config PDA (needed for mint authority)
  const [psmConfigPDA] = derivePsmConfigPDA(programIds.litePsm);

  // Step 3: Deploy tokens
  const { usdcMint, okuMoneyMint } = await deployTokens(provider, psmConfigPDA, authorities);
  logger.log('');

  // Step 4: Initialize PSM
  const { psmConfig, redemptionQueue, bridgeConfig, vaultOkuMoney } = await initializePsm(
    provider,
    programIds.litePsm,
    usdcMint,
    okuMoneyMint,
    authorities,
    config
  );
  logger.log('');

  // Step 5: Initialize Vault
  const { vaultConfig, usdOkuMint, reserveVault } = await initializeVault(
    provider,
    programIds.okuDollar,
    programIds.litePsm,
    okuMoneyMint,
    authorities,
    config
  );
  logger.log('');

  // Step 6: Initialize Router
  const { routerConfig } = await initializeRouter(
    provider,
    programIds.okuBridgeRouter,
    okuMoneyMint,
    usdOkuMint,
    authorities
  );
  logger.log('');

  // Save deployment
  const deployment: DeploymentAddresses = {
    network,
    timestamp: new Date().toISOString(),
    tokens: {
      usdc: usdcMint.toBase58(),
      okusd: okuMoneyMint.toBase58(),
      usdOku: usdOkuMint.toBase58(),
    },
    programs: {
      litePsm: programIds.litePsm.toBase58(),
      wokusdVault: programIds.okuDollar.toBase58(),
      okuBridgeRouter: programIds.okuBridgeRouter.toBase58(),
    },
    pdas: {
      psmConfig: psmConfig.toBase58(),
      redemptionQueue: redemptionQueue.toBase58(),
      bridgeConfig: bridgeConfig.toBase58(),
      vaultConfig: vaultConfig.toBase58(),
      routerConfig: routerConfig.toBase58(),
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

  // Step 7: Verify
  await verifyDeployment(provider, deployment);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.log('');
  logger.header('Deployment Complete');
  logger.success(`Total time: ${duration}s`);
  logger.log('');
  logger.info('Deployment saved to: deployments/' + network + '.json');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
