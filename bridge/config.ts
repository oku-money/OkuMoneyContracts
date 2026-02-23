/**
 * Bridge configuration
 *
 * Chain IDs:
 * - All mainnet EVM chains fit in u16 (max 65535) and work directly.
 * - Live testnets (Sepolia variants) overflow u16 — use a local Hardhat fork
 *   (chain ID 31337) for testing, or upgrade the SVM program to u32 later.
 * - Solana uses a custom bridge chain ID of 1151.
 *
 * For EVM → SVM testing:
 *   1. Run `npx hardhat node --fork <OP_RPC>` (chain ID 31337)
 *   2. Ensure SVM BridgeConfig.supported_chains includes 31337
 *   3. Set EVM_RPC=http://127.0.0.1:8545 and SOLANA_RPC=https://api.devnet.solana.com
 */

// ============ Chain IDs ============

/** Custom bridge ID used by the SVM program for Solana */
export const SOLANA_BRIDGE_CHAIN_ID = 1151;

/** Mainnet EVM chain IDs (all fit in u16, safe for SVM bridge) */
export const EVM_CHAIN_IDS = {
  ethereum: 1,
  optimism: 10,
  base: 8453,
  arbitrum: 42161,
  hardhat: 31337,
} as const;

// ============ RPC URLs ============

export function getEvmRpc(): string {
  const rpc = process.env.EVM_RPC;
  if (!rpc) throw new Error("Missing EVM_RPC environment variable");
  return rpc;
}

export function getSolanaRpc(): string {
  return process.env.SOLANA_RPC || "https://api.devnet.solana.com";
}

// ============ Contract Addresses ============

export function getOkuBridgeAddress(): string {
  const addr = process.env.OKUBRIDGE_ADDRESS;
  if (!addr) throw new Error("Missing OKUBRIDGE_ADDRESS environment variable");
  return addr;
}

export function getOkuUsdAddress(): string {
  const addr = process.env.OKUUSD_ADDRESS;
  if (!addr) throw new Error("Missing OKUUSD_ADDRESS environment variable");
  return addr;
}

export function getLitePsmProgramId(): string {
  const id = process.env.LITE_PSM_PROGRAM_ID;
  if (!id) throw new Error("Missing LITE_PSM_PROGRAM_ID environment variable");
  return id;
}

export function getOkusdMint(): string {
  const mint = process.env.OKUSD_MINT;
  if (!mint) throw new Error("Missing OKUSD_MINT environment variable");
  return mint;
}

// ============ Keys ============

export function getEvmPrivateKey(): string {
  const key = process.env.EVM_PRIVATE_KEY;
  if (!key) throw new Error("Missing EVM_PRIVATE_KEY environment variable");
  return key;
}

export function getEvmOrchestratorPrivateKey(): string {
  const key = process.env.EVM_ORCHESTRATOR_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY;
  if (!key) {
    throw new Error(
      "Missing EVM_ORCHESTRATOR_PRIVATE_KEY (or EVM_PRIVATE_KEY) environment variable"
    );
  }
  return key;
}

export function getSolanaWalletKeypairPath(): string {
  const p = process.env.SOLANA_WALLET_KEYPAIR;
  if (!p) throw new Error("Missing SOLANA_WALLET_KEYPAIR environment variable");
  return p;
}

export function getSolanaOrchestratorKeypairPath(): string {
  const p =
    process.env.SOLANA_ORCHESTRATOR_KEYPAIR ||
    process.env.SOLANA_WALLET_KEYPAIR ||
    `${process.env.HOME}/.config/solana/id.json`;
  return p;
}

// ============ Pending file paths ============

import path from "path";

export const PENDING_DIR = path.join(__dirname, "pending");

export const EVM_TO_SVM_PENDING = path.join(PENDING_DIR, "evm-to-svm.json");
export const SVM_TO_EVM_PENDING = path.join(PENDING_DIR, "svm-to-evm.json");

// ============ EIP-712 Types (reused across scripts) ============

export const BRIDGE_REQUEST_TYPES: Record<string, { name: string; type: string }[]> = {
  BridgeRequest: [
    { name: "sourceChainId", type: "uint256" },
    { name: "destChainId", type: "uint256" },
    { name: "sender", type: "address" },
    { name: "recipient", type: "address" },
    { name: "shares", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint256" },
  ],
};

// ============ OkuBridge ABI (minimal) ============

export const OKUBRIDGE_ABI = [
  "function bridgeBurn(uint256 destChainId, address recipient, uint256 shares) external returns (bytes32 requestId)",
  "function bridgeMint((uint256 sourceChainId, uint256 destChainId, address sender, address recipient, uint256 shares, uint256 nonce, uint256 deadline) request, bytes signature) external",
  "function supportedChains(uint256 chainId) external view returns (bool)",
  "function outboundNonce(uint256 chainId) external view returns (uint256)",
  "function processedRequests(bytes32 requestId) external view returns (bool)",
  "function authorizedSigner() external view returns (address)",
  "event BridgeBurn(bytes32 indexed requestId, address indexed sender, address indexed recipient, uint256 sourceChainId, uint256 destChainId, uint256 shares, uint256 nonce)",
  "event BridgeMint(bytes32 indexed requestId, address indexed recipient, uint256 sourceChainId, uint256 shares)",
] as const;

export const OKUUSD_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function balanceOf(address account) external view returns (uint256)",
  "function sharesOf(address account) external view returns (uint256)",
  "function sharesToTokens(uint256 shares) external view returns (uint256)",
  "function tokensToShares(uint256 amount) external view returns (uint256)",
  "function rewardMultiplier() external view returns (uint256)",
] as const;
