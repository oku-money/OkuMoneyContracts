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
  /**
   * USDC peg circuit-breaker (replaces the previous PoR-style `oracle`
   * config). Mirrors EVM `OracleRelay`. When `enabled=false` the deploy
   * script leaves the relay unwired (operator-side kill switch), but
   * `pythProgramOwner` is still required by `initialize` since the
   * runtime owner check needs a non-zero pubkey to validate against.
   *
   * Operators wire the relay post-deploy via `npm run admin:set-oracle-relay`.
   */
  oracleRelay: {
    enabled: boolean;
    /** Pyth USDC/USD feed account. Omitted on disabled deployments. */
    feed?: PublicKey;
    /** Accepted Pyth program owner pubkey. Required at init. */
    pythProgramOwner: PublicKey;
    /**
     * Default staleness threshold (seconds) the deploy script seeds onto
     * the relay. Bounded by `[60s, 7 days]`. 3600 (= 1h) matches the EVM
     * default and is safe for any production Pyth update cadence.
     */
    defaultStalenessSecs: number;
    /**
     * Default peg-band lower bound (1e9 precision). Bounded below by
     * `ORACLE_USDC_PRICE_FLOOR = 0.95e9`. 0.97e9 = ±3% matches EVM.
     */
    defaultMinPriceE9: bigint;
    /**
     * Default peg-band upper bound (1e9 precision). Bounded above by
     * `ORACLE_USDC_PRICE_CEILING = 1.05e9`.
     */
    defaultMaxPriceE9: bigint;
  };
  confirmationCommitment: 'processed' | 'confirmed' | 'finalized';
}

/// Legacy Pyth V2 program IDs (per
/// https://docs.pyth.network/price-feeds/contract-addresses/solana). The
/// modern Pyth Solana Receiver layout is not supported until a parallel
/// parser is added; see `helpers/oracle_relay.rs`.
const PYTH_V2_MAINNET_PROGRAM_ID = new PublicKey(
  'FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH'
);
const PYTH_V2_DEVNET_PROGRAM_ID = new PublicKey(
  'gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s'
);

/// Default peg-band edges (±3%, matches EVM).
const DEFAULT_MIN_PRICE_E9 = 970_000_000n;
const DEFAULT_MAX_PRICE_E9 = 1_030_000_000n;
/// Default staleness threshold (1 hour). Bounded by [60s, 7 days].
const DEFAULT_STALENESS_SECS = 3600;

export const NETWORK_CONFIGS: Record<NetworkName, NetworkConfig> = {
  localnet: {
    name: 'localnet',
    cluster: 'http://127.0.0.1:8899',
    usdc: {
      mint: PublicKey.default, // Will be created during deployment
      isNative: true,
    },
    oracleRelay: {
      enabled: false, // No Pyth on localnet
      pythProgramOwner: PYTH_V2_MAINNET_PROGRAM_ID,
      defaultStalenessSecs: DEFAULT_STALENESS_SECS,
      defaultMinPriceE9: DEFAULT_MIN_PRICE_E9,
      defaultMaxPriceE9: DEFAULT_MAX_PRICE_E9,
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
    oracleRelay: {
      enabled: true,
      // Pyth devnet USDC/USD feed
      feed: new PublicKey('5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7'),
      pythProgramOwner: PYTH_V2_DEVNET_PROGRAM_ID,
      defaultStalenessSecs: DEFAULT_STALENESS_SECS,
      defaultMinPriceE9: DEFAULT_MIN_PRICE_E9,
      defaultMaxPriceE9: DEFAULT_MAX_PRICE_E9,
    },
    confirmationCommitment: 'confirmed',
  },

  /**
   * Devnet fork via Surfpool — for local testing against forked devnet
   * state (e.g. live Pyth feeds via `tests/fork/`).
   *
   * Usage:
   *   surfpool start --rpc-url https://api.devnet.solana.com
   *   NETWORK=devnet-fork npm run test:fork
   */
  'devnet-fork': {
    name: 'devnet-fork',
    cluster: 'http://127.0.0.1:8899', // Surfpool local endpoint
    usdc: {
      // Create mock USDC on the fork for testing
      mint: PublicKey.default,
      isNative: true, // Create our own USDC for testing
    },
    oracleRelay: {
      enabled: true,
      // Pyth devnet USDC/USD feed (forked from devnet)
      feed: new PublicKey('5SSkXsEKQepHHAewytPVwdej4epN1nxgLVM84L4KXgy7'),
      pythProgramOwner: PYTH_V2_DEVNET_PROGRAM_ID,
      defaultStalenessSecs: DEFAULT_STALENESS_SECS,
      defaultMinPriceE9: DEFAULT_MIN_PRICE_E9,
      defaultMaxPriceE9: DEFAULT_MAX_PRICE_E9,
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
    oracleRelay: {
      enabled: true,
      // Pyth mainnet USDC/USD feed
      feed: new PublicKey('Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD'),
      pythProgramOwner: PYTH_V2_MAINNET_PROGRAM_ID,
      defaultStalenessSecs: DEFAULT_STALENESS_SECS,
      defaultMinPriceE9: DEFAULT_MIN_PRICE_E9,
      defaultMaxPriceE9: DEFAULT_MAX_PRICE_E9,
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
    oracleRelay: {
      enabled: true,
      // Pyth mainnet USDC/USD feed (forked from mainnet)
      feed: new PublicKey('Gnt27xtC473ZT2Mw5u8wZ68Z3gULkSTb5DuxJy7eJotD'),
      pythProgramOwner: PYTH_V2_MAINNET_PROGRAM_ID,
      defaultStalenessSecs: DEFAULT_STALENESS_SECS,
      defaultMinPriceE9: DEFAULT_MIN_PRICE_E9,
      defaultMaxPriceE9: DEFAULT_MAX_PRICE_E9,
    },
    confirmationCommitment: 'confirmed',
  },
};
