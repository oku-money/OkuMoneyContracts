/**
 * Shared constants across all deployments
 */

import { PublicKey } from '@solana/web3.js';

// Supply limits
export const MAX_SUPPLY = 1_000_000_000 * 1_000_000; // 1B OkuUSD (6 decimals)
export const MINTER_ALLOWANCE = 100_000_000 * 1_000_000; // 100M initial allowance

// Bridge configuration
export const BRIDGE_FEE_BPS = 10; // 0.1% (10 basis points)
export const MIN_BRIDGE_AMOUNT = 1 * 1_000_000; // 1 OkuMoney
export const MAX_BRIDGE_AMOUNT = 10_000_000 * 1_000_000; // 10M OkuMoney

// ============================================================================
// Cross-Chain Bridge Constants (OkuMoney Protocol-Internal IDs)
// ============================================================================

/**
 * Solana chain IDs (Ankr convention - OkuMoney protocol-internal identifiers)
 * These are NOT universal standards; they appear in bridge messages,
 * BridgeConfig state, and supportedChains mappings.
 */
export const SOLANA_MAINNET_CHAIN_ID = 101;
export const SOLANA_TESTNET_CHAIN_ID = 102; // Not used by OkuMoney
export const SOLANA_DEVNET_CHAIN_ID = 103;

// Default chain ID for current environment (use devnet for testnet deployments)
export const SOLANA_CHAIN_ID = SOLANA_DEVNET_CHAIN_ID;

/**
 * EVM chain IDs (OkuMoney protocol-internal u16 identifiers)
 * NOTE: Real EVM chain IDs (EIP-155) can exceed u16 max (65535).
 * The Solana program uses u16 for chain IDs, so we map EVM chains to smaller IDs.
 * These are internal bridge identifiers, NOT the actual EVM chain IDs.
 */
export const OP_SEPOLIA_CHAIN_ID = 420; // Mapped from real EIP-155 ID 11155420
export const OPTIMISM_CHAIN_ID = 10;
export const ARBITRUM_CHAIN_ID = 421; // Mapped from real EIP-155 ID 42161
export const BASE_CHAIN_ID = 845; // Mapped from real EIP-155 ID 8453
export const ETHEREUM_CHAIN_ID = 1;

// Local testing chain IDs (Hardhat defaults)
// Hardhat uses 31337, but that exceeds u16 max so we use a smaller internal ID
export const HARDHAT_CHAIN_ID = 313; // Protocol-internal ID for Hardhat localhost (31337)

// Supported destination chains (EVM chain IDs)
// Production chains
export const SUPPORTED_CHAINS_MAINNET = [
  ETHEREUM_CHAIN_ID, // Ethereum Mainnet
  OPTIMISM_CHAIN_ID, // Optimism
  ARBITRUM_CHAIN_ID, // Arbitrum One
  BASE_CHAIN_ID, // Base
];

// Testnet chains (for devnet deployment)
export const SUPPORTED_CHAINS_TESTNET = [
  OP_SEPOLIA_CHAIN_ID, // OP Sepolia
];

// Default supported chains (use testnet for devnet deployments)
export const SUPPORTED_CHAINS = SUPPORTED_CHAINS_TESTNET;

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

// Fork program IDs (from target/deploy-fork keypair files)
// These are separate from devnet/mainnet to avoid PDA collisions with forked state
const FORK_LITE_PSM_ID = new PublicKey('GtjZJFmhrAxYDrK2JqK7H3My6u5m7qmkzXqd9p6NLWgS');
const FORK_OKU_DOLLAR_ID = new PublicKey('9CRADsxW3dN4xnmwLH7DHRfo4BM86B5NNXE7ku2pYGy9'); // aka wokusdVault
const FORK_OKU_BRIDGE_ROUTER_ID = new PublicKey('GEs9yWYSAJDwjibhQZc5eY8Wex7M9hFscThnL4RGafJu');

export const PROGRAM_IDS = {
  localnet: { litePsm: LITE_PSM_ID, wokusdVault: WOKUSD_VAULT_ID, okuBridgeRouter: OKU_BRIDGE_ROUTER_ID },
  devnet: { litePsm: LITE_PSM_ID, wokusdVault: WOKUSD_VAULT_ID, okuBridgeRouter: OKU_BRIDGE_ROUTER_ID },
  'devnet-fork': { litePsm: FORK_LITE_PSM_ID, wokusdVault: FORK_OKU_DOLLAR_ID, okuBridgeRouter: FORK_OKU_BRIDGE_ROUTER_ID },
  'mainnet-beta': { litePsm: LITE_PSM_ID, wokusdVault: WOKUSD_VAULT_ID, okuBridgeRouter: OKU_BRIDGE_ROUTER_ID },
  'mainnet-fork': { litePsm: FORK_LITE_PSM_ID, wokusdVault: FORK_OKU_DOLLAR_ID, okuBridgeRouter: FORK_OKU_BRIDGE_ROUTER_ID },
};
