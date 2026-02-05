/**
 * Chain-specific configuration for scripts
 *
 * This module re-exports from the centralized config and provides
 * backward-compatible interfaces for existing scripts.
 */

import { getChainMetadata, getTokenAddress, ChainMetadata } from "../../config/config";

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
