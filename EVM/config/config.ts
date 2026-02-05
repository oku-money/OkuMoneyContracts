/**
 * Centralized configuration for canonical addresses across all chains
 *
 * This is the single source of truth for all external contract addresses.
 * All scripts and tests should import from this file instead of hardcoding addresses.
 */

export interface ChainAddresses {
  tokens: {
    usdc: string;
    weth: string;
    dai?: string;
    usdt?: string;
  };
  whales?: {
    usdc?: string;
    weth?: string;
    dai?: string;
  };
  protocols?: {
    uniswapV3Factory?: string;
    uniswapV3Router?: string;
    aaveV3Pool?: string;
  };
}

/**
 * Canonical addresses for each supported chain
 */
export const CHAIN_ADDRESSES: Record<string, ChainAddresses> = {
  // Ethereum Mainnet
  mainnet: {
    tokens: {
      usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    },
    whales: {
      usdc: "0x37305B1cD40574E4C5Ce33f8e8306Be057fD7341", // ~$250M USDC
      weth: "0x8EB8a3b98659Cce290402893d0123abb75E3ab28", // Avalanche Bridge
      dai: "0x5d3a536E4D6DbD6114cc1Ead35777bAB948E3643", // Compound cDAI
    },
    protocols: {
      uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      uniswapV3Router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      aaveV3Pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
    },
  },

  // Optimism Mainnet
  optimism: {
    tokens: {
      usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Bridged USDC (official)
      weth: "0x4200000000000000000000000000000000000006",
      dai: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      usdt: "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58",
    },
    whales: {
      usdc: "0xf89d7b9c864f589bbF53a82105107622B35EaA40", // ~$40M USDC
      weth: "0x85149247691df622eaF1a8Bd0CaFd40BC45154a9", // Op Bridge
    },
    protocols: {
      uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      uniswapV3Router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      aaveV3Pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    },
  },

  // Arbitrum One
  arbitrum: {
    tokens: {
      usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", // Native USDC
      weth: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
      dai: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1",
      usdt: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
    },
    whales: {
      usdc: "0x47c031236e19d024b42f8AE6780E44A573170703", // ~$100M USDC
      weth: "0x30B8C1c41d7652D57fC2DdAe0A27d6a4E906B13F", // Arb Bridge
    },
    protocols: {
      uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      uniswapV3Router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      aaveV3Pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    },
  },

  // Base
  base: {
    tokens: {
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Native USDC
      weth: "0x4200000000000000000000000000000000000006",
      dai: "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb",
    },
    whales: {
      usdc: "0xcdac0d6c6c59727a65f871236188350531885c43", // ~$20M USDC
      weth: "0x49048044D57e1C92A77f79988d21Fa8fAF74E97e", // Base Bridge
    },
    protocols: {
      uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
      uniswapV3Router: "0x2626664c2603336E57B271c5C0b26F421741e481",
      aaveV3Pool: "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5",
    },
  },

  // Localhost (fork) - defaults to Optimism for consistency with tests
  localhost: {
    tokens: {
      usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", // Optimism USDC
      weth: "0x4200000000000000000000000000000000000006", // Optimism WETH
      dai: "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", // Optimism DAI
    },
    whales: {
      usdc: "0xf89d7b9c864f589bbF53a82105107622B35EaA40", // Optimism whale
      weth: "0x85149247691df622eaF1a8Bd0CaFd40BC45154a9",
    },
    protocols: {
      uniswapV3Factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
      uniswapV3Router: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
      aaveV3Pool: "0x794a61358D6845594F94dc1DB02A252b5b4814aD",
    },
  },
};

/**
 * Get addresses for a specific chain
 */
export function getChainAddresses(network: string): ChainAddresses {
  const addresses = CHAIN_ADDRESSES[network.toLowerCase()];
  if (!addresses) {
    throw new Error(
      `No addresses found for network: ${network}. Supported networks: ${Object.keys(CHAIN_ADDRESSES).join(", ")}`
    );
  }
  return addresses;
}

/**
 * Get a specific token address for a chain
 */
export function getTokenAddress(network: string, token: keyof ChainAddresses["tokens"]): string {
  const addresses = getChainAddresses(network);
  const tokenAddress = addresses.tokens[token];
  if (!tokenAddress) {
    throw new Error(`Token ${token} not configured for network ${network}`);
  }
  return tokenAddress;
}

/**
 * Get a whale address for testing (returns undefined if not available)
 */
export function getWhaleAddress(
  network: string,
  token: keyof NonNullable<ChainAddresses["whales"]>
): string | undefined {
  const addresses = getChainAddresses(network);
  return addresses.whales?.[token];
}

/**
 * Chain metadata (chain IDs, names, RPC URLs)
 */
export interface ChainMetadata {
  name: string;
  chainId: number;
  rpcUrl: string;
  explorer: string;
}

export const CHAIN_METADATA: Record<string, ChainMetadata> = {
  mainnet: {
    name: "Ethereum Mainnet",
    chainId: 1,
    rpcUrl: process.env.MAINNET_RPC_URL || "https://eth.llamarpc.com",
    explorer: "https://etherscan.io",
  },
  optimism: {
    name: "Optimism",
    chainId: 10,
    rpcUrl: process.env.OPTIMISM_RPC_URL || "https://mainnet.optimism.io",
    explorer: "https://optimistic.etherscan.io",
  },
  arbitrum: {
    name: "Arbitrum One",
    chainId: 42161,
    rpcUrl: process.env.ARBITRUM_RPC_URL || "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
  },
  base: {
    name: "Base",
    chainId: 8453,
    rpcUrl: process.env.BASE_RPC_URL || "https://mainnet.base.org",
    explorer: "https://basescan.org",
  },
  localhost: {
    name: "Localhost (Fork)",
    chainId: 31337,
    rpcUrl: "http://127.0.0.1:8545",
    explorer: "N/A",
  },
};

/**
 * Get chain metadata by network name
 */
export function getChainMetadata(network: string): ChainMetadata {
  const metadata = CHAIN_METADATA[network.toLowerCase()];
  if (!metadata) {
    throw new Error(
      `No metadata found for network: ${network}. Supported networks: ${Object.keys(CHAIN_METADATA).join(", ")}`
    );
  }
  return metadata;
}

/**
 * Wormhole chain ID mappings (for NTT bridge)
 */
export const WORMHOLE_CHAIN_IDS: Record<number, number> = {
  1: 2,      // Ethereum -> Wormhole 2
  10: 24,    // Optimism -> Wormhole 24
  42161: 23, // Arbitrum -> Wormhole 23
  8453: 30,  // Base -> Wormhole 30
  56: 4,     // BSC -> Wormhole 4
};

/**
 * Get Wormhole chain ID from EVM chain ID
 */
export function getWormholeChainId(evmChainId: number): number {
  const wormholeId = WORMHOLE_CHAIN_IDS[evmChainId];
  if (!wormholeId) {
    throw new Error(`No Wormhole chain ID mapping for EVM chain ID: ${evmChainId}`);
  }
  return wormholeId;
}
