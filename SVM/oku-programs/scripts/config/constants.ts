/**
 * Shared constants across all deployments
 */

// Supply limits
export const MAX_SUPPLY = 1_000_000_000 * 1_000_000; // 1B OkuMoney (6 decimals)
// WS5.7: aligned up to EVM's MINTER_ALLOWANCE (1B) from the prior 100M.
// EVM uses 1B to match max_supply; SVM was conservatively set to 100M.
// Production: orchestrator can reset via set-minter-allowance after deploy.
export const MINTER_ALLOWANCE = 1_000_000_000 * 1_000_000; // 1B (matches EVM)

// Oracle configuration
// WS5.7: aligned to EVM's ORACLE_MIN_STALENESS lower bound (60s is also EVM's min,
// but EVM deploy default is 3600s — align SVM to 3600s so the systems behave
// consistently on cross-chain deployments.
export const ORACLE_STALENESS_THRESHOLD = 3600; // 3600 seconds (1 hour), matches EVM default

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

// ===== Direct Mint (fiat on-ramp) =====

/**
 * Default master EOA for devnet/testnet direct-minter role.
 * Must differ from the deployer wallet (which is also role_admin) because
 * the on-chain separation-of-duties guard rejects setting any non-RoleAdmin
 * role to the same pubkey as role_admin.
 */
export const DEFAULT_DIRECT_MINTER = '5Miw5ZQ4vT8MBSFcp8vtwearNpZiXZVa43WrRZDpXbzT';

/** Direct-minter allowance (1M OkuMoney, 6 decimals). */
export const DIRECT_MINTER_ALLOWANCE = 1_000_000 * 1_000_000; // 1,000,000 OkuMoney

// NOTE: Program IDs are NOT stored here. They are read at runtime from
// deployments/{network}.json via scripts/utils/addressBook.ts::loadDeployment().
// This is the single source of truth. Run `anchor keys list` or inspect
// target/deploy/*.json to find the canonical program IDs for each keypair.
