#!/usr/bin/env tsx
/**
 * Phase 1: Deploy Programs Only
 * 
 * Builds and deploys the Solana programs without initialization.
 * This is the flaky part that may need retries due to network congestion.
 * 
 * Programs are idempotent - can be retried safely until all succeed.
 * 
 * Usage:
 *   # Deploy to devnet
 *   npm run deploy:programs
 * 
 *   # Deploy to devnet fork (Surfpool)
 *   NETWORK=devnet-fork npm run deploy:programs
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { detectNetwork, createProvider, getNetworkConfig, isForkNetwork, getParentNetwork } from '../utils/network';
import { logger } from '../utils/logger';
import { saveDeployment } from '../utils/addressBook';
import { NETWORK_CONFIGS, getActiveRpcInfo } from '../config/networks';
import {
  buildPrograms,
  restoreOriginalKeypairs,
  deployPrograms,
  verifyPrograms,
} from './lib';

function formatSol(lamports: number): string {
  return (lamports / LAMPORTS_PER_SOL).toFixed(6);
}

async function main() {
  const startTime = Date.now();

  logger.header('OkuMoney SVM - Deploy Programs');

  const network = detectNetwork();
  const networkConfig = getNetworkConfig(network);
  const isFork = isForkNetwork(network);

  logger.info(`Network: ${network}`);
  logger.info(`Cluster: ${networkConfig.cluster}`);
  logger.info(`Mode: ${isFork ? 'Fork' : 'Live'}`);
  
  // Log RPC source for live networks
  if (!isFork && (network === 'devnet' || network === 'mainnet-beta')) {
    const rpcInfo = getActiveRpcInfo(network === 'devnet' ? 'devnet' : 'mainnet');
    logger.info(`RPC source: ${rpcInfo.source}`);
  }
  logger.log('');

  // Create provider
  const provider = createProvider(network);
  const deployerPubkey = provider.wallet.publicKey;
  const balance = await provider.connection.getBalance(deployerPubkey);
  
  logger.info(`Deployer: ${deployerPubkey.toBase58()}`);
  logger.info(`Balance: ${formatSol(balance)} SOL`);
  
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

  // Build programs
  const { originalKeypairs } = await buildPrograms(isFork);
  logger.log('');

  // Deploy programs
  let programIds;
  try {
    programIds = await deployPrograms(provider, isFork);
  } finally {
    if (isFork) {
      restoreOriginalKeypairs(originalKeypairs);
    }
  }
  logger.log('');

  // Verify programs are on-chain
  const verified = await verifyPrograms(provider, programIds);
  if (!verified) {
    throw new Error('Program verification failed');
  }
  logger.log('');

  // Save program IDs to deployment file
  saveDeployment(network, {
    programs: {
      litePsm: programIds.litePsm.toBase58(),
      okuDollarProgram: programIds.okuDollar.toBase58(),
      okuBridgeRouter: programIds.okuBridgeRouter.toBase58(),
    },
  });

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.log('');
  logger.header('Programs Deployed Successfully');
  logger.success(`Total time: ${duration}s`);
  logger.log('');
  logger.info('Program IDs saved to: deployments/' + network + '.json');
  logger.info('');
  logger.info('Next step: Run initialization');
  logger.info(`  npm run deploy:init`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Deployment failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
