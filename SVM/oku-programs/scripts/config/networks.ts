/**
 * Network-specific configuration
 */

import 'dotenv/config';
import { PublicKey } from '@solana/web3.js';

export type NetworkName = 'localnet' | 'devnet' | 'devnet-fork' | 'mainnet-beta' | 'mainnet-fork';

// Alchemy API key from .env (for more reliable RPC)
const ALCHEMY_API_KEY = process.env.API_KEY || '';

/**
 * Build Alchemy Solana RPC URL
 */
function alchemyUrl(network: 'devnet' | 'mainnet'): string {
  if (!ALCHEMY_API_KEY) {
    // Fallback to public RPC
    return network === 'devnet' 
      ? 'https://api.devnet.solana.com'
      : 'https://api.mainnet-beta.solana.com';
  }
  return `https://solana-${network}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
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
    cluster: alchemyUrl('devnet'), // Use Alchemy if API_KEY is set, else public RPC
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
    cluster: alchemyUrl('mainnet'), // Use Alchemy if API_KEY is set, else public RPC
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
