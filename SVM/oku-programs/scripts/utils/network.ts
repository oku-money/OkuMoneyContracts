/**
 * Network detection and configuration loading
 */

import 'dotenv/config';
import { Connection, Keypair } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@anchor-lang/core';
import * as fs from 'fs';
import * as path from 'path';
import { NETWORK_CONFIGS, NetworkConfig, NetworkName } from '../config/networks';
import { logger } from './logger';

/**
 * Detect network from CLI args, environment, or Anchor.toml
 */
export function detectNetwork(): NetworkName {
  // 1. Check CLI argument
  const networkArg = process.argv.find((arg) => arg.startsWith('--network='));
  if (networkArg) {
    const network = networkArg.split('=')[1] as NetworkName;
    if (isValidNetwork(network)) {
      return network;
    }
    throw new Error(
      `Invalid network: ${network}. Valid options: localnet, devnet, mainnet-beta`
    );
  }

  // 2. Check environment variable
  const networkEnv = process.env.NETWORK as NetworkName | undefined;
  if (networkEnv && isValidNetwork(networkEnv)) {
    return networkEnv;
  }

  // 3. Check Anchor.toml
  const anchorTomlPath = path.join(process.cwd(), 'Anchor.toml');
  if (fs.existsSync(anchorTomlPath)) {
    const tomlContent = fs.readFileSync(anchorTomlPath, 'utf-8');
    const clusterMatch = tomlContent.match(/cluster\s*=\s*"(\w+)"/);
    if (clusterMatch) {
      const cluster = clusterMatch[1].toLowerCase();
      if (cluster === 'localnet' || cluster === 'devnet') {
        return cluster;
      }
      if (cluster === 'mainnet' || cluster === 'mainnet-beta') {
        return 'mainnet-beta';
      }
    }
  }

  // 4. Default to localnet
  logger.warning('No network specified, defaulting to localnet', false);
  return 'localnet';
}

function isValidNetwork(network: string): network is NetworkName {
  return (
    network === 'localnet' ||
    network === 'devnet' ||
    network === 'devnet-fork' ||
    network === 'mainnet-beta' ||
    network === 'mainnet-fork'
  );
}

/**
 * Check if we're running on a forked network
 */
export function isForkNetwork(network: NetworkName): boolean {
  return network === 'devnet-fork' || network === 'mainnet-fork';
}

/**
 * Get the parent network for a fork (e.g., devnet-fork -> devnet)
 */
export function getParentNetwork(network: NetworkName): NetworkName {
  if (network === 'devnet-fork') return 'devnet';
  if (network === 'mainnet-fork') return 'mainnet-beta';
  return network;
}

/**
 * Get network configuration
 */
export function getNetworkConfig(network?: NetworkName): NetworkConfig {
  const net = network || detectNetwork();
  return NETWORK_CONFIGS[net];
}

/**
 * Create Anchor provider for the specified network
 */
export function createProvider(network?: NetworkName): AnchorProvider {
  const config = getNetworkConfig(network);

  // Load wallet
  const walletPath =
    process.env.WALLET_PATH || path.join(process.env.HOME!, '.config/solana/id.json');

  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet not found at ${walletPath}`);
  }

  const walletKeypair = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(walletPath, 'utf-8')))
  );

  const wallet = new Wallet(walletKeypair);
  const connection = new Connection(config.cluster, {
    commitment: config.confirmationCommitment,
  });

  return new AnchorProvider(connection, wallet, {
    commitment: config.confirmationCommitment,
  });
}

/**
 * Load keypair from file path
 */
export function loadKeypair(filepath: string): Keypair {
  if (!fs.existsSync(filepath)) {
    throw new Error(`Keypair file not found: ${filepath}`);
  }

  const secretKey = JSON.parse(fs.readFileSync(filepath, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}


