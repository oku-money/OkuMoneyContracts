/**
 * Chain-specific configuration for scripts
 *
 * This module re-exports from the centralized config and provides
 * backward-compatible interfaces for existing scripts.
 */

import { getChainMetadata, getTokenAddress } from "../../config/config";

// ============================================================================
// Fork Testing Configuration
// ============================================================================

/**
 * Address to impersonate when running on local forks
 * This is the address corresponding to PRIVATE_KEY in .env
 */
export const FORK_IMPERSONATE_ADDRESS = "0x3CB68a6762041aA05E762814A8791CA9d98E79A0";

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

/**
 * EVM chain IDs follow EIP-155
 */
export const OP_SEPOLIA_CHAIN_ID = 11155420;
export const OPTIMISM_CHAIN_ID = 10;
export const ARBITRUM_CHAIN_ID = 42161;
export const BASE_CHAIN_ID = 8453;
export const ETHEREUM_CHAIN_ID = 1;

export interface ChainConfig {
  name: string;
  chainId: number;
  usdc: string;
  rpcUrl: string;
}

/**
 * Get chain configuration by network name
 * This wraps the centralized config for backward compatibility
 */
export function getChainConfig(network: string): ChainConfig {
  const metadata = getChainMetadata(network);
  const usdcAddress = getTokenAddress(network, "usdc");

  return {
    name: metadata.name,
    chainId: metadata.chainId,
    usdc: usdcAddress,
    rpcUrl: metadata.rpcUrl,
  };
}

/**
 * Get network name from environment or default to localhost
 */
export function getNetworkName(): string {
  return process.env.NETWORK || "localhost";
}
