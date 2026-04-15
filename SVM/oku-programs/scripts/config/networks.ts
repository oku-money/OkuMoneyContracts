/**
 * Network-specific configuration
 */

import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';

export type NetworkName = 'localnet' | 'devnet' | 'devnet-fork' | 'mainnet-beta' | 'mainnet-fork';

// RPC URLs from .env
const HELIUS_RPC = process.env.HELIUS_RPC || '';
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || '';

/**
 * Get RPC URL for network
 * Priority: SOLANA_RPC_URL > HELIUS_RPC > public RPC
 * 
 * Helius has better rate limits than public RPC and is recommended
 * for program deployments which require many transactions.
 */
function getRpcUrl(network: 'devnet' | 'mainnet'): string {
  // Explicit override takes priority
  if (SOLANA_RPC_URL) {
    return SOLANA_RPC_URL;
  }
  
  // Use Helius if available (better rate limits for deployments)
  if (HELIUS_RPC) {
    return HELIUS_RPC;
  }
  
  // Fallback to public RPC
  return network === 'devnet' 
    ? 'https://api.devnet.solana.com'
    : 'https://api.mainnet-beta.solana.com';
}

export interface NetworkConfig {
  name: NetworkName;
  cluster: string;
  usdc: {
    mint: PublicKey;
    isNative: boolean; // True if we create it, false if using existing
  };
  oracle: {
    enabled: boolean;
    feed?: PublicKey; // Pyth USDC/USD feed
  };
  confirmationCommitment: 'processed' | 'confirmed' | 'finalized';
}

export const NETWORK_CONFIGS: Record<NetworkName, NetworkConfig> = {
  localnet: {
    name: 'localnet',
    cluster: 'http://127.0.0.1:8899',
    usdc: {
      mint: PublicKey.default, // Will be created during deployment
      isNative: true,
    },
    oracle: {
      enabled: false, // No Pyth on localnet
    },
    confirmationCommitment: 'confirmed',
  },

  devnet: {
    name: 'devnet',
    cluster: getRpcUrl('devnet'), // Public RPC by default (more reliable for deployments)
    usdc: {
      mint: PublicKey.default, // Created during deployment (mock USDC, deployer as mint authority)
      isNative: true,
    },
    oracle: {
      enabled: true,
      // Pyth devnet USDC/USD feed
      feed: new PublicKey('5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7'),
    },
    confirmationCommitment: 'confirmed',
  },

  /**
   * Devnet fork via Surfpool - for local testing of bridge scripts
   * before executing on live devnet. Uses Surfpool's forking capability
   * to create a local replica of devnet state.
   *
   * Usage:
   *   surfpool start --rpc-url https://api.devnet.solana.com
   *   NETWORK=devnet-fork tsx scripts/bridge/bridge-burn-to-evm.ts
   */
  'devnet-fork': {
    name: 'devnet-fork',
    cluster: 'http://127.0.0.1:8899', // Surfpool local endpoint
    usdc: {
      // Create mock USDC on the fork for testing
      mint: PublicKey.default,
      isNative: true, // Create our own USDC for testing
    },
    oracle: {
      enabled: true,
      // Pyth devnet USDC/USD feed (forked from devnet)
      feed: new PublicKey('5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7'),
    },
    confirmationCommitment: 'confirmed',
  },

  'mainnet-beta': {
    name: 'mainnet-beta',
    cluster: getRpcUrl('mainnet'), // Public RPC by default (more reliable for deployments)
    usdc: {
      // Mainnet USDC from Circle
      mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      isNative: false,
    },
    oracle: {
      enabled: true,
      // Pyth mainnet USDC/USD feed
      feed: new PublicKey('Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD'),
    },
    confirmationCommitment: 'finalized',
  },

  /**
   * Mainnet fork via Surfpool - for local testing against mainnet state.
   *
   * Usage:
   *   surfpool start --rpc-url https://api.mainnet-beta.solana.com
   *   npm run deploy:mainnet-fork
   */
  'mainnet-fork': {
    name: 'mainnet-fork',
    cluster: 'http://127.0.0.1:8899', // Surfpool local endpoint
    usdc: {
      // Forked from mainnet
      mint: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
      isNative: false,
    },
    oracle: {
      enabled: true,
      // Pyth mainnet USDC/USD feed (forked from mainnet)
      feed: new PublicKey('Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD'),
    },
    confirmationCommitment: 'confirmed',
  },
};
