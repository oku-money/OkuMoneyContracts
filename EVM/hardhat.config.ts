import { HardhatUserConfig, subtask } from "hardhat/config";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import { silenceWarnings } from "@openzeppelin/upgrades-core";
import "hardhat-deploy";
import "hardhat-deploy-ethers";
import "@typechain/hardhat";
import * as path from "path";
import { sync as globSync } from "glob";
import { rpcUrl, forkBlock, RpcChain } from "./scripts/config/rpc";

// Load environment variables
import * as dotenv from "dotenv";
dotenv.config();

// Extend hardhat compilation to include test-only mocks under ./test/mocks.
// Mocks live outside `paths.sources` so they don't ship in production artifacts,
// but hardhat tests still reference them by name via getContractFactory().
subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS).setAction(
  async (_, __, runSuper) => {
    const paths: string[] = await runSuper();
    const mockPaths = globSync(path.resolve(__dirname, "test/mocks/*.sol"));
    return [...paths, ...mockPaths];
  }
);

// Suppress "Potentially unsafe deployment" warnings for unsafeAllow options
silenceWarnings();

// Dev wallet address for local fork testing (impersonated with funded ETH)
const DEV_WALLET_ADDRESS = "0x3CB68a6762041aA05E762814A8791CA9d98E79A0";

// ============================================================================
// Local Fork Network Selection
// ============================================================================
// `hh node` and the in-process `hardhat` network fork from one chain at a time.
// Pick which one via FORK_NETWORK (default: sepolia). Both `hardhat` and
// `localhost` derive their chainId from the same source so the chainId on the
// running node matches what the localhost client expects (mismatch = signer
// errors from hardhat-ethers).
//
// Examples:
//   FORK_NETWORK=sepolia hh node      # default; same as today
//   FORK_NETWORK=base hh node         # fork Base mainnet
//   FORK_NETWORK=bsc hh node          # fork BSC mainnet
//   FORK_URL=https://... hh node      # full override (FORK_NETWORK ignored)
//
// Then in another terminal:
//   NETWORK=base npx hardhat run scripts/deploy/index.ts --network localhost

const FORK_TARGETS: Record<RpcChain, { chainId: number }> = {
  sepolia:     { chainId: 11155111 },
  mainnet:     { chainId: 1 },
  optimism:    { chainId: 10 },
  opSepolia:   { chainId: 11155420 },
  arbitrum:    { chainId: 42161 },
  arbSepolia:  { chainId: 421614 },
  base:        { chainId: 8453 },
  baseSepolia: { chainId: 84532 },
  bsc:         { chainId: 56 },
  bscTestnet:  { chainId: 97 },
};

const requestedFork = (process.env.FORK_NETWORK || "sepolia").trim();
const FORK_NETWORK: RpcChain = requestedFork in FORK_TARGETS ? (requestedFork as RpcChain) : "sepolia";
if (FORK_NETWORK !== requestedFork) {
  console.warn(`[hardhat.config] Unknown FORK_NETWORK="${requestedFork}", falling back to sepolia. Known: ${Object.keys(FORK_TARGETS).join(", ")}`);
}
const _forkTarget = FORK_TARGETS[FORK_NETWORK];

const DEFAULT_FORK_URL = rpcUrl(FORK_NETWORK, "fork");
const DEFAULT_FORK_CHAIN_ID = process.env.HARDHAT_CHAIN_ID
  ? parseInt(process.env.HARDHAT_CHAIN_ID)
  : _forkTarget.chainId;

// `typechain` is contributed by `@typechain/hardhat` via module augmentation,
// but the toolbox/standalone version mismatch occasionally drops the augmentation.
// Cast to `any` on assignment keeps tsc happy without weakening per-key types.
const config: HardhatUserConfig & { typechain?: any } = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "cancun",
      // Keep the source-text metadata hash out of creation bytecode, so CREATE2
      // addresses depend on code semantics rather than on comment text. Must
      // match `bytecode_hash` in `foundry.toml` — see the rationale there.
      metadata: {
        bytecodeHash: "none",
      },
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
      // Fork target controlled by FORK_NETWORK env var (see top of file).
      // Defaults to Eth Sepolia. Override with FORK_URL for an arbitrary RPC.
      chainId: DEFAULT_FORK_CHAIN_ID,
      forking: {
        url: DEFAULT_FORK_URL,
        blockNumber: forkBlock(FORK_NETWORK),
        enabled: true,
      },
      allowUnlimitedContractSize: false,
      gas: "auto",
      gasPrice: "auto",
      // Pin base fee to 0 in the local hardhat-network. Without this, Hardhat
      // 2.20+ enforces EIP-1559 base-fee growth between blocks; fork tests that
      // signed transactions with `gasPrice: auto` against an older base-fee
      // snapshot will revert with "maxFeePerGas too low for next block".
      initialBaseFeePerGas: 0,
      // Fund the test mnemonic accounts (NOT the dev wallet — that is impersonated
      // separately by deploy scripts and uses its real on-chain balance from the fork).
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
        count: 20,
        accountsBalance: "10000000000000000000000", // 10000 ETH
      },
    },

    // localhost connects to a running `npx hardhat node`. We deliberately do
    // NOT pin a `chainId` here: that would force the deploy terminal to
    // re-export FORK_NETWORK to match whatever the `hh node` terminal used,
    // and any drift trips Hardhat's HH101 chain-id mismatch check.
    //
    // Instead the running node is the source of truth for chainId. Scripts
    // that care (e.g. scripts/deploy/index.ts) cross-check the live node's
    // chainId against the `NETWORK`-targeted chain at runtime, so a wrong
    // fork still fails fast — just with a clearer error than HH101.
    //
    // No hardcoded gasPrice either: we want the fork to use the real chain's
    // baseFee (EIP-1559) so gas-cost estimates faithfully reflect a live deploy.
    localhost: {
      url: "http://127.0.0.1:8545",
      gas: "auto",
    },

    // Testnets
    sepolia: {
      // Prefer Alchemy if API key is set (more reliable than public RPC)
      url: rpcUrl("sepolia"),
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
      url: rpcUrl("opSepolia"),
      chainId: 11155420,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api-sepolia-optimistic.etherscan.io",
          apiKey: process.env.OPTIMISTIC_ETHERSCAN_API_KEY || "",
        },
      },
    },

    baseSepolia: {
      url: rpcUrl("baseSepolia"),
      chainId: 84532,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api-sepolia.basescan.org",
          apiKey: process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
        },
      },
    },

    arbSepolia: {
      url: rpcUrl("arbSepolia"),
      chainId: 421614,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api-sepolia.arbiscan.io",
          apiKey: process.env.ARBISCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
        },
      },
    },

    bscTestnet: {
      url: rpcUrl("bscTestnet"),
      chainId: 97,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api-testnet.bscscan.com",
          apiKey: process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
        },
      },
    },

    // Mainnets
    mainnet: {
      url: rpcUrl("mainnet"),
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
      url: rpcUrl("arbitrum"),
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
      url: rpcUrl("base"),
      chainId: 8453,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api.basescan.org",
          apiKey: process.env.BASESCAN_API_KEY || "",
        },
      },
    },

    bsc: {
      url: rpcUrl("bsc"),
      chainId: 56,
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      verify: {
        etherscan: {
          apiUrl: "https://api.bscscan.com",
          apiKey: process.env.BSCSCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
        },
      },
    },

    optimism: {
      url: rpcUrl("optimism"),
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

  // Etherscan verification (V2 API - single key for all Etherscan networks)
  // For non-Etherscan explorers (Arbiscan, Basescan, etc.), use customChains
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },

  // Mocha test configuration
  mocha: {
    timeout: 200000, // 200 seconds for fork tests
  },
};

// Export dev wallet address for scripts to use
export { DEV_WALLET_ADDRESS, DEFAULT_FORK_CHAIN_ID };

export default config;
