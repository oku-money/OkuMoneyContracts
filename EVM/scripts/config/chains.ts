/**
 * Chain-specific configuration for Optimism and Arbitrum
 */

export interface ChainConfig {
  name: string;
  chainId: number;
  usdc: string;
  rpcUrl: string;
}

export const CHAINS: Record<string, ChainConfig> = {
  optimism: {
    name: "Optimism",
    chainId: 10,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Mainnet USDC (bridged)
    rpcUrl: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
  },
  arbitrum: {
    name: "Arbitrum",
    chainId: 42161,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Mainnet USDC (native)
    rpcUrl: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
  },
  localhost: {
    name: "Localhost (Fork)",
    chainId: 31337,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Use Optimism USDC for fork
    rpcUrl: "http://127.0.0.1:8545",
  },
};

/**
 * Get chain configuration by network name
 */
export function getChainConfig(network: string): ChainConfig {
  const config = CHAINS[network.toLowerCase()];
  if (!config) {
    throw new Error(
      `Unknown network: ${network}. Supported networks: ${Object.keys(CHAINS).join(", ")}`
    );
  }
  return config;
}

/**
 * Get network name from environment or default to localhost
 */
export function getNetworkName(): string {
  return process.env.NETWORK || "localhost";
}
