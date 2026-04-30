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
  oracle: {
    enabled: boolean;
    feed?: PublicKey; // Pyth USDC/USD feed
    /**
     * Pyth program owner pubkey accepted by the on-chain `check_oracle_reserves`.
     * Was previously hardcoded in `programs/lite-psm/src/helpers/oracle.rs`;
     * now caller-supplied via `initialize` so deployments can target any Pyth
     * program (legacy V2, Pyth Solana Receiver, etc.).
     *
     * Defaults: legacy Pyth V2 mainnet/devnet program IDs (per
     * https://docs.pyth.network/price-feeds/contract-addresses/solana).
     * For localnet, we still provide a placeholder since the oracle is disabled.
     */
    pythProgramOwner: PublicKey;
  };
  confirmationCommitment: 'processed' | 'confirmed' | 'finalized';
}

/// Legacy Pyth V2 program IDs (kept here for reference; previously hardcoded
/// in `programs/lite-psm/src/helpers/oracle.rs`).
const PYTH_V2_MAINNET_PROGRAM_ID = new PublicKey(
  'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH'
);
const PYTH_V2_DEVNET_PROGRAM_ID = new PublicKey(
  'gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s'
);

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
      // Placeholder — oracle is disabled, but the program init still requires
      // a non-zero pyth_program_owner. Use the legacy mainnet ID.
      pythProgramOwner: PYTH_V2_MAINNET_PROGRAM_ID,
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
      pythProgramOwner: PYTH_V2_DEVNET_PROGRAM_ID,
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
      pythProgramOwner: PYTH_V2_DEVNET_PROGRAM_ID,
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
      pythProgramOwner: PYTH_V2_MAINNET_PROGRAM_ID,
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
      pythProgramOwner: PYTH_V2_MAINNET_PROGRAM_ID,
    },
    confirmationCommitment: 'confirmed',
  },
};
