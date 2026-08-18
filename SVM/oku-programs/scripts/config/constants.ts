/**
 * Shared constants across all deployments
 */

// Supply limits
export const MAX_SUPPLY = 1_000_000_000 * 1_000_000; // 1B OkuM (6 decimals)
// Matches EVM's MINTER_ALLOWANCE (1B), set equal to max_supply. The
// orchestrator can reset it via set-minter-allowance after deploy.
export const MINTER_ALLOWANCE = 1_000_000_000 * 1_000_000; // 1B (matches EVM)

// Token decimals
export const USDC_DECIMALS = 6;
export const OKU_M_DECIMALS = 6;

// Cross-chain transfers are mediated by an off-chain orchestrator calling
// `mint_oku_m` / `redeem_oku_m` on each side; there are no on-chain chain-ID
// constants, EIP-155 mappings, or chain whitelists.

// ===== Direct Mint (fiat on-ramp) =====

/**
 * Default master EOA for devnet/testnet direct-minter role.
 * Must differ from the deployer wallet (which is also role_admin) because
 * the on-chain separation-of-duties guard rejects setting any non-RoleAdmin
 * role to the same pubkey as role_admin.
 */
export const DEFAULT_DIRECT_MINTER = '5Miw5ZQ4vT8MBSFcp8vtwearNpZiXZVa43WrRZDpXbzT';

/** Direct-minter allowance (1M OkuM, 6 decimals). */
export const DIRECT_MINTER_ALLOWANCE = 1_000_000 * 1_000_000; // 1,000,000 OkuM

/**
 * Direct-burner allowance (1M OkuM, 6 decimals).
 * Mirrors `DIRECT_MINTER_ALLOWANCE` -- same cap, same rationale: bounds the
 * blast radius of the permissioned `direct_burner` role between resets by
 * `allowance_manager`.
 */
export const DIRECT_BURNER_ALLOWANCE = 1_000_000 * 1_000_000; // 1,000,000 OkuM

// NOTE: Program IDs are NOT stored here. They are read at runtime from
// deployments/{network}.json via scripts/utils/addressBook.ts::loadDeployment().
// This is the single source of truth. Run `anchor keys list` or inspect
// target/deploy/*.json to find the canonical program IDs for each keypair.
