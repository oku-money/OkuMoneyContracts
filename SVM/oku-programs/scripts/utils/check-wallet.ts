#!/usr/bin/env tsx
/**
 * Check wallet balance across networks
 */

import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { detectNetwork, createProvider, getNetworkConfig } from './network';
import { NETWORK_CONFIGS, getActiveRpcInfo } from '../config/networks';
import { logger } from './logger';

async function main() {
  const network = detectNetwork();
  const provider = createProvider(network);
  const wallet = provider.wallet.publicKey;

  logger.header('Wallet Check');
  logger.info(`Wallet: ${wallet.toBase58()}`);
  logger.info(`Network: ${network}`);
  logger.log('');

  // Check balance on current network
  const balance = await provider.connection.getBalance(wallet);
  logger.success(`Balance on ${network}: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);

  // If on fork, also check parent network balance
  if (network === 'devnet-fork') {
    const rpcInfo = getActiveRpcInfo('devnet');
    logger.info(`Devnet RPC: ${rpcInfo.source}`);
    const devnetConnection = new Connection(NETWORK_CONFIGS.devnet.cluster, 'confirmed');
    try {
      const devnetBalance = await devnetConnection.getBalance(wallet);
      logger.success(`Balance on devnet (real): ${(devnetBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    } catch (e) {
      logger.warning('Could not fetch devnet balance');
    }
  } else if (network === 'mainnet-fork') {
    const rpcInfo = getActiveRpcInfo('mainnet');
    logger.info(`Mainnet RPC: ${rpcInfo.source}`);
    const mainnetConnection = new Connection(NETWORK_CONFIGS['mainnet-beta'].cluster, 'confirmed');
    try {
      const mainnetBalance = await mainnetConnection.getBalance(wallet);
      logger.success(`Balance on mainnet (real): ${(mainnetBalance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    } catch (e) {
      logger.warning('Could not fetch mainnet balance');
    }
  } else if (network === 'devnet' || network === 'mainnet-beta') {
    const rpcInfo = getActiveRpcInfo(network === 'devnet' ? 'devnet' : 'mainnet');
    logger.info(`RPC source: ${rpcInfo.source}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message);
    process.exit(1);
  });
