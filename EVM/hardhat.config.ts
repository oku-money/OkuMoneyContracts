import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import { silenceWarnings } from "@openzeppelin/upgrades-core";
import "hardhat-deploy";
import "hardhat-deploy-ethers";
import "@typechain/hardhat";

// Load environment variables
import * as dotenv from "dotenv";
dotenv.config();

// Suppress "Potentially unsafe deployment" warnings for unsafeAllow options
silenceWarnings();

// ============================================================================
// Dynamic RPC URL construction using Alchemy API key
// ============================================================================

const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || "";

// Helper to construct Alchemy RPC URLs
function alchemyUrl(network: string): string {
  if (!ALCHEMY_API_KEY) {
    // Fallback to public RPCs if no Alchemy key
    const publicRpcs: Record<string, string> = {
      "eth-mainnet": "https://eth.llamarpc.com",
      "eth-sepolia": "https://rpc.sepolia.org",
      "opt-mainnet": "https://mainnet.optimism.io",
      "opt-sepolia": "https://sepolia.optimism.io",
      "arb-mainnet": "https://arb1.arbitrum.io/rpc",
      "base-mainnet": "https://mainnet.base.org",
    };
    return publicRpcs[network] || "";
  }
  return `https://${network}.g.alchemy.com/v2/${ALCHEMY_API_KEY}`;
}

// Impersonation address for local fork testing
const FORK_IMPERSONATE_ADDRESS = "0x3CB68a6762041aA05E762814A8791CA9d98E79A0";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
    },
  },

  paths: {
    sources: "./src",
    tests: "./test/hardhat",
    cache: "./cache_hardhat",
    artifacts: "./artifacts",
    deploy: "./deploy",
    deployments: "./deployments",
  },

  networks: {
    hardhat: {
      chainId: 31337,
      // Fork OP Sepolia for testnet simulation, or Optimism for mainnet simulation
      forking: {
        url: process.env.FORK_URL || alchemyUrl("opt-sepolia"),
        blockNumber: process.env.FORK_BLOCK_NUMBER ? parseInt(process.env.FORK_BLOCK_NUMBER) : undefined,
        enabled: true,
      },
      allowUnlimitedContractSize: false,
      gas: "auto",
      gasPrice: "auto",
      // Impersonate your wallet for local testing
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 20,
        accountsBalance: "10000000000000000000000", // 10000 ETH
      },
    },

    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    // Testnets
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || alchemyUrl("eth-sepolia"),
      chainId: 11155111,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api-sepolia.etherscan.io",
          apiKey: process.env.ETHERSCAN_API_KEY || "",
        },
      },
    },

    opSepolia: {
      url: process.env.OP_SEPOLIA_RPC_URL || alchemyUrl("opt-sepolia"),
      chainId: 11155420,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api-sepolia-optimistic.etherscan.io",
          apiKey: process.env.OPTIMISTIC_ETHERSCAN_API_KEY || "",
        },
      },
    },

    // Mainnets
    mainnet: {
      url: process.env.MAINNET_RPC_URL || alchemyUrl("eth-mainnet"),
      chainId: 1,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api.etherscan.io",
          apiKey: process.env.ETHERSCAN_API_KEY || "",
        },
      },
    },

    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || alchemyUrl("arb-mainnet"),
      chainId: 42161,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api.arbiscan.io",
          apiKey: process.env.ARBISCAN_API_KEY || "",
        },
      },
    },

    base: {
      url: process.env.BASE_RPC_URL || alchemyUrl("base-mainnet"),
      chainId: 8453,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api.basescan.org",
          apiKey: process.env.BASESCAN_API_KEY || "",
        },
      },
    },

    optimism: {
      url: process.env.OPTIMISM_RPC_URL || alchemyUrl("opt-mainnet"),
      chainId: 10,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api-optimistic.etherscan.io",
          apiKey: process.env.OPTIMISTIC_ETHERSCAN_API_KEY || "",
        },
      },
    },
  },

  // TypeChain configuration
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
    alwaysGenerateOverloads: false,
    dontOverrideCompile: false,
  },

  // Hardhat Deploy configuration
  namedAccounts: {
    deployer: {
      default: 0, // First account
    },
    admin: {
      default: 1, // Second account (for admin role)
    },
    operator: {
      default: 2, // Third account (for operator role)
    },
    user: {
      default: 3, // Test user
    },
  },

  // Gas reporter configuration
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    outputFile: process.env.REPORT_GAS_FILE || undefined,
    noColors: !!process.env.REPORT_GAS_FILE,
    coinmarketcap: process.env.COINMARKETCAP_API_KEY || undefined,
  },

  // Etherscan verification
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      arbitrumOne: process.env.ARBISCAN_API_KEY || "",
      base: process.env.BASESCAN_API_KEY || "",
      optimisticEthereum: process.env.OPTIMISTIC_ETHERSCAN_API_KEY || "",
      optimismSepolia: process.env.OPTIMISTIC_ETHERSCAN_API_KEY || "",
    },
  },

  // Mocha test configuration
  mocha: {
    timeout: 200000, // 200 seconds for fork tests
  },
};

// Export impersonation address for scripts to use
export { FORK_IMPERSONATE_ADDRESS };

export default config;
