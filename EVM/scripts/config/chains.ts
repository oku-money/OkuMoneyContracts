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
 * Dev wallet address for local fork testing
 * This wallet is impersonated and funded with ETH when running on forks
 */
export const DEV_WALLET_ADDRESS = "0x3CB68a6762041aA05E762814A8791CA9d98E79A0";

// Re-export for backwards compatibility
export const FORK_IMPERSONATE_ADDRESS = DEV_WALLET_ADDRESS;

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
export const SEPOLIA_CHAIN_ID = 11155111;
export const OP_SEPOLIA_CHAIN_ID = 11155420;
export const OPTIMISM_CHAIN_ID = 10;
export const ARBITRUM_CHAIN_ID = 42161;
export const BASE_CHAIN_ID = 8453;
export const ETHEREUM_CHAIN_ID = 1;

// Default fork chain ID (Eth Sepolia)
export const DEFAULT_FORK_CHAIN_ID = SEPOLIA_CHAIN_ID;

/**
 * Bridge Chain ID Mapping (EIP-155 -> Protocol-Internal u16)
 * 
 * The SVM bridge uses u16 for chain IDs (max 65535).
 * Some EVM chain IDs exceed this, so we map them to smaller internal IDs.
 * Both EVM and SVM sides must agree on these mappings.
 */
export const BRIDGE_CHAIN_ID_MAP: Record<number, number> = {
  // Mainnet chains (fit in u16, no mapping needed)
  [ETHEREUM_CHAIN_ID]: 1,
  [OPTIMISM_CHAIN_ID]: 10,
  [ARBITRUM_CHAIN_ID]: 421, // 42161 -> 421
  [BASE_CHAIN_ID]: 845, // 8453 -> 845
  
  // Testnet chains (need mapping, exceed u16)
  [SEPOLIA_CHAIN_ID]: 111, // 11155111 -> 111
  [OP_SEPOLIA_CHAIN_ID]: 420, // 11155420 -> 420
};

/**
 * Reverse mapping: Protocol-Internal u16 -> EIP-155 chain ID
 */
export const BRIDGE_CHAIN_ID_REVERSE_MAP: Record<number, number> = Object.fromEntries(
  Object.entries(BRIDGE_CHAIN_ID_MAP).map(([k, v]) => [v, Number(k)])
);

/**
 * Get the bridge-internal chain ID for a given EIP-155 chain ID
 */
export function getBridgeChainId(evmChainId: number): number {
  const bridgeId = BRIDGE_CHAIN_ID_MAP[evmChainId];
  if (bridgeId === undefined) {
    throw new Error(`No bridge chain ID mapping for EVM chain ID: ${evmChainId}`);
  }
  return bridgeId;
}

/**
 * Get the EIP-155 chain ID from a bridge-internal chain ID
 */
export function getEvmChainIdFromBridge(bridgeChainId: number): number {
  const evmId = BRIDGE_CHAIN_ID_REVERSE_MAP[bridgeChainId];
  if (evmId === undefined) {
    throw new Error(`No EVM chain ID mapping for bridge chain ID: ${bridgeChainId}`);
  }
  return evmId;
}

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
 * Get network name from environment or Hardhat's network.name
 * 
 * Priority:
 * 1. NETWORK env var (allows overriding for forks, e.g., NETWORK=sepolia on localhost fork)
 * 2. Hardhat's network.name
 * 3. "localhost" as fallback
 */
export function getNetworkName(): string {
  // NETWORK env var takes priority - essential for fork testing
  // e.g., when running on localhost but forking sepolia, use NETWORK=sepolia
  if (process.env.NETWORK) {
    return process.env.NETWORK;
  }
  
  // Try to get from Hardhat's network object
  try {
    const hre = require("hardhat");
    return hre.network.name;
  } catch {
    return "localhost";
  }
}
