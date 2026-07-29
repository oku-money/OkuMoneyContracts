/**
 * Network-specific configuration
 */

import '../utils/env';
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

/**
 * Get the active RPC URL and source for logging
 */
export function getActiveRpcInfo(network: 'devnet' | 'mainnet'): { url: string; source: string } {
  if (SOLANA_RPC_URL) {
    return { url: SOLANA_RPC_URL, source: 'SOLANA_RPC_URL env' };
  }
  if (HELIUS_RPC) {
    return { url: HELIUS_RPC, source: 'HELIUS_RPC env' };
  }
  const publicUrl = network === 'devnet' 
    ? 'https://api.devnet.solana.com'
    : 'https://api.mainnet-beta.solana.com';
  return { url: publicUrl, source: 'public RPC (consider setting HELIUS_RPC for better reliability)' };
}

/**
 * Deployment configuration - tunable via environment variables
 */
export const DEPLOYMENT_CONFIG = {
  // Priority fee in micro-lamports per compute unit
  // Higher = better chance of landing during congestion, but costs more
  // 200,000 = ~$0.01 per transaction at current prices
  priorityFee: parseInt(process.env.PRIORITY_FEE || '200000'),
  
  // Max retries per program deployment
  maxRetries: parseInt(process.env.MAX_RETRIES || '5'),
  
  // Delay between retry attempts (ms) - should be < blockhash expiry (~60s)
  retryDelayMs: parseInt(process.env.RETRY_DELAY_MS || '30000'),
  
  // Delay between deploying different programs (ms)
  programDelayMs: parseInt(process.env.PROGRAM_DELAY_MS || '5000'),
  
  // Timeout per program deployment attempt (ms)
  deployTimeoutMs: parseInt(process.env.DEPLOY_TIMEOUT_MS || '600000'), // 10 minutes
};

export interface NetworkConfig {
  name: NetworkName;
  cluster: string;
  usdc: {
    mint: PublicKey;
    isNative: boolean; // True if we create it, false if using existing
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
    confirmationCommitment: 'confirmed',
  },

  devnet: {
    name: 'devnet',
    cluster: getRpcUrl('devnet'), // Public RPC by default (more reliable for deployments)
    usdc: {
      mint: PublicKey.default, // Created during deployment (mock USDC, deployer as mint authority)
      isNative: true,
    },
    confirmationCommitment: 'confirmed',
  },

  /**
   * Devnet fork via Surfpool — for local testing against forked devnet
   * state.
   *
   * Usage:
   *   surfpool start --rpc-url https://api.devnet.solana.com
   *   NETWORK=devnet-fork npm run test:onchain:fork
   */
  'devnet-fork': {
    name: 'devnet-fork',
    cluster: 'http://127.0.0.1:8899', // Surfpool local endpoint
    usdc: {
      // Create mock USDC on the fork for testing
      mint: PublicKey.default,
      isNative: true, // Create our own USDC for testing
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
    confirmationCommitment: 'confirmed',
  },
};
