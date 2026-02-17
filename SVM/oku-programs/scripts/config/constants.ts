/**
 * Shared constants across all deployments
 */

import { PublicKey } from '@solana/web3.js';

// Supply limits
export const MAX_SUPPLY = 1_000_000_000 * 1_000_000; // 1B OkuUSD (6 decimals)
export const MINTER_ALLOWANCE = 100_000_000 * 1_000_000; // 100M initial allowance

// Bridge configuration
export const BRIDGE_FEE_BPS = 10; // 0.1% (10 basis points)
export const MIN_BRIDGE_AMOUNT = 1 * 1_000_000; // 1 OkuUSD
export const MAX_BRIDGE_AMOUNT = 10_000_000 * 1_000_000; // 10M OkuUSD

// Supported destination chains (EVM chain IDs)
export const SUPPORTED_CHAINS = [
  1, // Ethereum Mainnet
  10, // Optimism
  42161, // Arbitrum One
  8453, // Base
];

// Oracle configuration
export const ORACLE_STALENESS_THRESHOLD = 60; // 60 seconds

// Token decimals
export const USDC_DECIMALS = 6;
export const OKUSD_DECIMALS = 6;

// Initial interest rate (0% - can be updated by orchestrator)
export const INITIAL_INTEREST_RATE_BPS = 0;

// Program IDs (from target/deploy keypair files - run `anchor keys list` to verify)
const LITE_PSM_ID = new PublicKey('AhKZ4TT5W4mnvR3CsX1t9ymQmZx4535AN9SsrThu6C1T');
const WOKUSD_VAULT_ID = new PublicKey('BjjK75Vxj6zsC49qYfcVYFPLqyXXkcaFzacTXwohmfVC');
const OKU_BRIDGE_ROUTER_ID = new PublicKey('7DtqfP4fyShjAoM35QC9m3a9Ukh4tqcVgzTNLuyTkgE');

export const PROGRAM_IDS = {
  localnet: { litePsm: LITE_PSM_ID, wokusdVault: WOKUSD_VAULT_ID, okuBridgeRouter: OKU_BRIDGE_ROUTER_ID },
  devnet: { litePsm: LITE_PSM_ID, wokusdVault: WOKUSD_VAULT_ID, okuBridgeRouter: OKU_BRIDGE_ROUTER_ID },
  'mainnet-beta': { litePsm: LITE_PSM_ID, wokusdVault: WOKUSD_VAULT_ID, okuBridgeRouter: OKU_BRIDGE_ROUTER_ID },
};
