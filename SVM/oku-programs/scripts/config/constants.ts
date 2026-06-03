/**
 * Shared constants across all deployments
 */

// Supply limits
export const MAX_SUPPLY = 1_000_000_000 * 1_000_000; // 1B OkuMoney (6 decimals)
export const MINTER_ALLOWANCE = 100_000_000 * 1_000_000; // 100M initial allowance

// Oracle configuration
export const ORACLE_STALENESS_THRESHOLD = 60; // 60 seconds

// Token decimals
export const USDC_DECIMALS = 6;
export const OKUSD_DECIMALS = 6;

// Initial interest rate (0% - can be updated by orchestrator)
export const INITIAL_INTEREST_RATE_BPS = 0;

// NOTE: Cross-chain bridge constants (chain IDs, EIP-155 mappings, supported
// chain whitelists) were removed in the noBridge refactor (phase B). v1
// cross-chain transfers are mediated by an off-chain orchestrator calling
// `mint_oku_m` / `redeem_oku_m` on each side; no on-chain chain-ID metadata
// is persisted.

// NOTE: Program IDs are NOT stored here. They are read at runtime from
// deployments/{network}.json via scripts/utils/addressBook.ts::loadDeployment().
// This is the single source of truth. Run `anchor keys list` or inspect
// target/deploy/*.json to find the canonical program IDs for each keypair.
