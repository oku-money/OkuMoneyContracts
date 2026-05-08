/**
 * Shared constants across all deployments
 */

// Supply limits
export const MAX_SUPPLY = 1_000_000_000 * 1_000_000; // 1B OkuMoney (6 decimals)
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
export const SOLANA_TESTNET_CHAIN_ID = 102;
export const SOLANA_DEVNET_CHAIN_ID = 103;
// Localnet doesn't have an official Ankr ID; we reserve 199 for local clusters
// so a stray cross-chain message addressed to localnet can never collide with
// devnet/testnet/mainnet by accident.
export const SOLANA_LOCALNET_CHAIN_ID = 199;

/**
 * Resolve the protocol-internal Solana chain ID for a given runtime network.
 *
 * This is the value baked into `BridgeConfig.source_chain_id` at deploy time
 * via `initialize_bridge`. **It MUST match the cluster the program is being
 * deployed to**: the EVM side packs its `destChainId` against this value, so
 * a deploy that hardcodes the wrong ID silently breaks every cross-chain
 * mint targeting the program. (Phase 8 hotfix: a previous revision exported
 * a hardcoded `SOLANA_CHAIN_ID = SOLANA_DEVNET_CHAIN_ID` alias and a mainnet
 * deploy that used it would have set source_chain_id = 103 on the live
 * program. The alias has been removed; callers must use this resolver.)
 */
export type SolanaNetworkName =
  | 'localnet'
  | 'devnet'
  | 'devnet-fork'
  | 'mainnet-beta'
  | 'mainnet-fork';

export function sourceChainIdForNetwork(network: SolanaNetworkName): number {
  switch (network) {
    case 'mainnet-beta':
    case 'mainnet-fork':
      return SOLANA_MAINNET_CHAIN_ID;
    case 'devnet':
    case 'devnet-fork':
      return SOLANA_DEVNET_CHAIN_ID;
    case 'localnet':
      return SOLANA_LOCALNET_CHAIN_ID;
  }
}

/**
 * EVM chain IDs (OkuMoney protocol-internal u16 identifiers)
 * NOTE: Real EVM chain IDs (EIP-155) can exceed u16 max (65535).
 * The Solana program uses u16 for chain IDs, so we map EVM chains to smaller IDs.
 * These are internal bridge identifiers, NOT the actual EVM chain IDs.
 */
export const SEPOLIA_CHAIN_ID = 111; // Mapped from real EIP-155 ID 11155111 (too large for u16)
export const OP_SEPOLIA_CHAIN_ID = 420; // Mapped from real EIP-155 ID 11155420
export const OPTIMISM_CHAIN_ID = 10;
export const ARBITRUM_CHAIN_ID = 421; // Mapped from real EIP-155 ID 42161
export const BASE_CHAIN_ID = 845; // Mapped from real EIP-155 ID 8453
export const ETHEREUM_CHAIN_ID = 1;

// Local testing: Hardhat fork of Sepolia
// We use 111 (SEPOLIA_CHAIN_ID) since that's the network we're forking
export const HARDHAT_CHAIN_ID = SEPOLIA_CHAIN_ID;

// EIP-155 chain IDs (actual on-chain values)
export const EIP155_SEPOLIA = 11155111;
export const EIP155_OP_SEPOLIA = 11155420;
export const EIP155_OPTIMISM = 10;
export const EIP155_ARBITRUM = 42161;
export const EIP155_BASE = 8453;
export const EIP155_ETHEREUM = 1;

/**
 * Map EIP-155 chain ID to internal protocol u16 ID
 * Used when receiving bridge requests from EVM (which emits EIP-155 IDs)
 */
export function eip155ToInternalChainId(eip155ChainId: number): number {
  const mapping: Record<number, number> = {
    [EIP155_ETHEREUM]: ETHEREUM_CHAIN_ID,
    [EIP155_OPTIMISM]: OPTIMISM_CHAIN_ID,
    [EIP155_ARBITRUM]: ARBITRUM_CHAIN_ID,
    [EIP155_BASE]: BASE_CHAIN_ID,
    [EIP155_SEPOLIA]: SEPOLIA_CHAIN_ID,
    [EIP155_OP_SEPOLIA]: OP_SEPOLIA_CHAIN_ID,
  };
  const internalId = mapping[eip155ChainId];
  if (internalId === undefined) {
    throw new Error(`Unknown EIP-155 chain ID: ${eip155ChainId}`);
  }
  return internalId;
}

/**
 * Map internal protocol u16 ID to EIP-155 chain ID
 * Used when sending bridge requests to EVM
 */
export function internalToEip155ChainId(internalChainId: number): number {
  const mapping: Record<number, number> = {
    [ETHEREUM_CHAIN_ID]: EIP155_ETHEREUM,
    [OPTIMISM_CHAIN_ID]: EIP155_OPTIMISM,
    [ARBITRUM_CHAIN_ID]: EIP155_ARBITRUM,
    [BASE_CHAIN_ID]: EIP155_BASE,
    [SEPOLIA_CHAIN_ID]: EIP155_SEPOLIA,
    [OP_SEPOLIA_CHAIN_ID]: EIP155_OP_SEPOLIA,
  };
  const eip155Id = mapping[internalChainId];
  if (eip155Id === undefined) {
    throw new Error(`Unknown internal chain ID: ${internalChainId}`);
  }
  return eip155Id;
}

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
  SEPOLIA_CHAIN_ID, // Eth Sepolia (default for local fork testing)
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

// NOTE: Program IDs are NOT stored here. They are read at runtime from
// deployments/{network}.json via scripts/utils/addressBook.ts::loadDeployment().
// This is the single source of truth. Run `anchor keys list` or inspect
// target/deploy/*.json to find the canonical program IDs for each keypair.
