/**
 * Centralized configuration for all chain addresses, metadata, and bridge mappings
 *
 * This is the single source of truth for:
 * - External contract addresses (USDC, WETH, etc.) across all chains
 * - Whale addresses for fork testing
 * - Protocol addresses (Uniswap, Aave)
 * - Chain metadata (chain IDs, names, RPC URLs, explorers)
 * - Bridge chain ID mappings
 */

// ============================================================================
// Chain Addresses
// ============================================================================

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
      usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // Native USDC (6 decimals)
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

  // BNB Smart Chain (BSC) Mainnet
  // NOTE: deploy script uses MockUSDC by default. The native Binance-Peg USDC
  // listed below has 18 decimals (NOT 6 like Ethereum/Base USDC). If we ever
  // flip SKIP_MOCK_USDC=true on BSC, LitePSM/RedemptionQueue decimal handling
  // must be verified — IERC20Metadata.decimals() will return 18 here, which
  // changes the multiplier resolved in RedemptionQueue.initialize().
  bsc: {
    tokens: {
      usdc: "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // Binance-Peg USDC (18 decimals)
      weth: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    },
    whales: {
      usdc: "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance hot wallet
    },
    protocols: {
      // PancakeSwap V3 (used in lieu of Uniswap V3 on BSC)
      uniswapV3Factory: "0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865",
      uniswapV3Router: "0x13f4EA83D0bd40E75C8222255bc855a974568Dd4",
      aaveV3Pool: "0x6807dc923806fE8Fd134338EABCA509979a7e0cB",
    },
  },

  // OP Sepolia (testnet) - uses MockUSDC via address book for deployments
  opSepolia: {
    tokens: {
      usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7", // Circle's official OP Sepolia USDC (faucet)
      weth: "0x4200000000000000000000000000000000000006",
    },
    // No whales — testnet; MockUSDC is deployed and used instead via address book
  },

  // Eth Sepolia (testnet)
  sepolia: {
    tokens: {
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Circle's official Sepolia USDC
      weth: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", // Sepolia WETH
    },
    // No whales — testnet; use MockUSDC for testing
  },

  // Base Sepolia (testnet)
  baseSepolia: {
    tokens: {
      usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e", // Circle's official Base Sepolia USDC (6 decimals)
      weth: "0x4200000000000000000000000000000000000006", // Canonical Base Sepolia WETH (mirrors mainnet predeploy)
    },
    // No whales — testnet; deploy script defaults to MockUSDC.
  },

  // BNB Smart Chain Testnet (Chapel)
  // NOTE: like mainnet BSC, the canonical Binance-Peg USDC carries 18 decimals (NOT 6).
  // Live deploys here default to MockUSDC; if SKIP_MOCK_USDC=true is ever flipped, the
  // 18-decimal path through LitePSM/RedemptionQueue must be re-verified.
  bscTestnet: {
    tokens: {
      usdc: "0x64544969ed7EBf5f083679233325356EbE738930", // Binance-Peg USDC (testnet, 18 decimals)
      weth: "0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd", // WBNB testnet
    },
    // No whales — testnet; deploy script defaults to MockUSDC.
  },

  // Localhost (fork) - defaults to Sepolia fork
  // Uses Sepolia addresses since we fork Sepolia by default
  localhost: {
    tokens: {
      usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238", // Sepolia USDC (Circle)
      weth: "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9", // Sepolia WETH
    },
    // No whales on Sepolia fork — deploy MockUSDC for testing
  },
};

/**
 * Get addresses for a specific chain.
 *
 * Lookup is case-sensitive because the CHAIN_ADDRESSES keys (and the parallel
 * CHAIN_METADATA keys) use camelCase for multi-word chains (`opSepolia`,
 * `baseSepolia`, `bscTestnet`) to match Hardhat's `network.name`. Callers must
 * pass the canonical name; we don't lower-case the input or the map keys.
 */
export function getChainAddresses(network: string): ChainAddresses {
  const addresses = CHAIN_ADDRESSES[network];
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

// ============================================================================
// Chain Metadata
// ============================================================================

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
  bsc: {
    name: "BNB Smart Chain",
    chainId: 56,
    rpcUrl: process.env.BSC_RPC_URL || "https://bsc-dataseed.binance.org",
    explorer: "https://bscscan.com",
  },
  opSepolia: {
    name: "OP Sepolia",
    chainId: 11155420,
    rpcUrl: process.env.OP_SEPOLIA_RPC_URL || "https://sepolia.optimism.io",
    explorer: "https://sepolia-optimistic.etherscan.io",
  },
  sepolia: {
    name: "Eth Sepolia",
    chainId: 11155111,
    rpcUrl: process.env.SEPOLIA_RPC_URL || "https://rpc.sepolia.org",
    explorer: "https://sepolia.etherscan.io",
  },
  baseSepolia: {
    name: "Base Sepolia",
    chainId: 84532,
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
    explorer: "https://sepolia.basescan.org",
  },
  bscTestnet: {
    name: "BNB Smart Chain Testnet",
    chainId: 97,
    rpcUrl: process.env.BSC_TESTNET_RPC_URL || "https://bsc-testnet-rpc.publicnode.com",
    explorer: "https://testnet.bscscan.com",
  },
  localhost: {
    name: "Localhost (Sepolia Fork)",
    chainId: 11155111, // Matches forked Sepolia chain ID
    rpcUrl: "http://127.0.0.1:8545",
    explorer: "https://sepolia.etherscan.io", // Use Sepolia explorer for reference
  },
};

/**
 * Get chain metadata by network name.
 *
 * Case-sensitive — same rationale as {@link getChainAddresses}.
 */
export function getChainMetadata(network: string): ChainMetadata {
  const metadata = CHAIN_METADATA[network];
  if (!metadata) {
    throw new Error(
      `No metadata found for network: ${network}. Supported networks: ${Object.keys(CHAIN_METADATA).join(", ")}`
    );
  }
  return metadata;
}

/**
 * Reverse-lookup: find the canonical network name for a given chainId.
 *
 * Skips the "localhost" entry (which is itself just an alias for Sepolia fork)
 * so callers always resolve to the real chain (sepolia, base, bsc, etc.).
 * Returns undefined if no match.
 *
 * Used by deploy/test scripts to auto-detect the targeted chain from a running
 * `hh node` when NETWORK= env var isn't explicitly set.
 */
export function getNetworkNameByChainId(chainId: number): string | undefined {
  for (const [name, metadata] of Object.entries(CHAIN_METADATA)) {
    if (name === "localhost") continue;
    if (metadata.chainId === chainId) return name;
  }
  return undefined;
}

// ============================================================================
// Wormhole Chain IDs (for NTT bridge)
// ============================================================================

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
export const BASE_SEPOLIA_CHAIN_ID = 84532;
export const BSC_TESTNET_CHAIN_ID = 97;
export const OPTIMISM_CHAIN_ID = 10;
export const ARBITRUM_CHAIN_ID = 42161;
export const BASE_CHAIN_ID = 8453;
export const BSC_CHAIN_ID = 56;
export const ETHEREUM_CHAIN_ID = 1;

/**
 * EVM testnet chain IDs (used to choose Solana Devnet vs Mainnet
 * as the bridge counterpart at deploy time).
 */
export const EVM_TESTNET_CHAIN_IDS: number[] = [
  SEPOLIA_CHAIN_ID,
  OP_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  BSC_TESTNET_CHAIN_ID,
];

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
  [BSC_CHAIN_ID]: 56, // 56 fits in u16 directly
  [ARBITRUM_CHAIN_ID]: 421, // 42161 -> 421
  [BASE_CHAIN_ID]: 845, // 8453 -> 845

  // Testnet chains. Some EIP-155 IDs already fit in u16 (BSC testnet = 97); the
  // rest are folded into a 3-digit prefix that stays unique against every other
  // entry in this map. Keeping them distinct from their mainnet counterparts
  // (e.g. 845 vs 846) prevents bridge-side handlers from cross-routing.
  [SEPOLIA_CHAIN_ID]: 111,       // 11155111 -> 111
  [OP_SEPOLIA_CHAIN_ID]: 420,    // 11155420 -> 420
  [BASE_SEPOLIA_CHAIN_ID]: 846,  // 84532    -> 846 (Base mainnet uses 845)
  [BSC_TESTNET_CHAIN_ID]: 97,    // 97       -> 97  (already fits in u16)
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
 * Get the EVM chain ID from a bridge-internal chain ID
 */
export function getEvmChainIdFromBridge(bridgeChainId: number): number {
  const evmId = BRIDGE_CHAIN_ID_REVERSE_MAP[bridgeChainId];
  if (evmId === undefined) {
    throw new Error(`No EVM chain ID mapping for bridge chain ID: ${bridgeChainId}`);
  }
  return evmId;
}

/**
 * Pick the Solana bridge counterpart (Devnet vs Mainnet) for a given EVM chain.
 *
 * Testnets (Sepolia, OP Sepolia) bridge to Solana Devnet; everything else
 * (Base, BSC, Optimism, Arbitrum, Ethereum mainnets) bridges to Solana Mainnet.
 * The deploy script reads this to seed `OkuBridge.supportedChains` at init time.
 */
export function getSolanaCounterpartChainId(evmChainId: number): number {
  return EVM_TESTNET_CHAIN_IDS.includes(evmChainId)
    ? SOLANA_DEVNET_CHAIN_ID
    : SOLANA_MAINNET_CHAIN_ID;
}

// ============================================================================
// Backward Compatibility
// ============================================================================

export interface ChainConfig {
  name: string;
  chainId: number;
  usdc: string;
  rpcUrl: string;
}

/**
 * Get chain configuration by network name
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
