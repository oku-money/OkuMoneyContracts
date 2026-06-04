/**
 * Network detection and configuration loading
 */

import './env';
import { Connection, Keypair } from '@solana/web3.js';
import { AnchorProvider, Wallet } from '@anchor-lang/core';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NETWORK_CONFIGS, NetworkConfig, NetworkName } from '../config/networks';
import { logger } from './logger';

/** Resolve a path that may begin with `~` to an absolute filesystem path. */
function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return path.join(os.homedir(), p.slice(1));
  }
  return p;
}

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
      `Invalid network: ${network}. Valid options: localnet, devnet, devnet-fork, mainnet-beta, mainnet-fork`
    );
  }

  // 2. Check environment variable
  const networkEnv = process.env.NETWORK as NetworkName | undefined;
  if (networkEnv && isValidNetwork(networkEnv)) {
    return networkEnv;
  }

  // 3. Check Anchor.toml. Match `cluster = "<value>"` where value can be
  // a known cluster name (`localnet`, `devnet`, `mainnet`/`mainnet-beta`)
  // or a custom RPC URL (e.g. `cluster = "https://api.devnet.solana.com"`).
  // The previous `\w+` pattern silently ignored URL-form clusters.
  const anchorTomlPath = path.join(process.cwd(), 'Anchor.toml');
  if (fs.existsSync(anchorTomlPath)) {
    const tomlContent = fs.readFileSync(anchorTomlPath, 'utf-8');
    const clusterMatch = tomlContent.match(/cluster\s*=\s*"([^"]+)"/);
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
 * Known genesis hashes for cluster verification (WS5.6).
 * These are the canonical, immutable hashes for mainnet-beta and devnet.
 * If the connected RPC serves a different genesis hash the cluster is wrong.
 */
const GENESIS_HASHES: Partial<Record<NetworkName, string>> = {
  'mainnet-beta': '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d',
  devnet:         'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  // localnet, devnet-fork, mainnet-fork: genesis hash varies per session — skip verification
};

/**
 * Verify that the connected RPC's genesis hash matches the expected cluster.
 * Throws if connected to the wrong cluster (e.g., SOLANA_RPC_URL pointing at
 * mainnet when NETWORK=devnet).
 *
 * Called from createProvider(). No-op on localnet and fork networks.
 */
export async function verifyCluster(connection: Connection, network: NetworkName): Promise<void> {
  const expected = GENESIS_HASHES[network];
  if (!expected) return; // no verification for localnet / forks
  const actual = await connection.getGenesisHash();
  if (actual !== expected) {
    throw new Error(
      `Cluster mismatch: NETWORK=${network} expects genesis ${expected} ` +
      `but connected RPC returned ${actual}.\n` +
      `Check SOLANA_RPC_URL / HELIUS_RPC and ensure they point at the correct cluster.`
    );
  }
}

/**
 * Create Anchor provider for the specified network (synchronous).
 * Does NOT verify the genesis hash — use createProviderWithClusterCheck for
 * scripts that must guard against wrong-cluster RPC misconfigurations.
 */
export function createProvider(network?: NetworkName): AnchorProvider {
  const config = getNetworkConfig(network);

  // Load wallet — accept ~ in WALLET_PATH and fall back to ~/.config/solana/id.json.
  const walletPath = expandHome(
    process.env.WALLET_PATH || path.join(os.homedir(), '.config/solana/id.json')
  );

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
 * Create Anchor provider AND verify the RPC's genesis hash matches the
 * expected cluster (WS5.6). Use this in admin scripts that must guard
 * against wrong-cluster misconfigurations (e.g. SOLANA_RPC_URL pointing at
 * mainnet when NETWORK=devnet).
 *
 * Throws if the genesis hash does not match the expected cluster.
 * No-op on localnet and fork networks (genesis hash varies per session).
 */
export async function createProviderWithClusterCheck(network?: NetworkName): Promise<AnchorProvider> {
  const net = network || detectNetwork();
  const provider = createProvider(net);
  await verifyCluster(provider.connection, net);
  return provider;
}

/**
 * Load keypair from file path. Accepts paths with `~` prefix.
 */
export function loadKeypair(filepath: string): Keypair {
  const expanded = expandHome(filepath);
  if (!fs.existsSync(expanded)) {
    throw new Error(`Keypair file not found: ${expanded}`);
  }

  const secretKey = JSON.parse(fs.readFileSync(expanded, 'utf-8'));
  return Keypair.fromSecretKey(new Uint8Array(secretKey));
}


