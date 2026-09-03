/**
 * Role constants for OkuMoney contracts.
 * These are the keccak256 hashes of role names used in OpenZeppelin AccessControl.
 *
 * NOTE: These must match the roles defined in `src/lib/Roles.sol`.
 */

import { keccak256, toUtf8Bytes } from "ethers";

export const ROLES = {
  // Default admin role (AccessControl)
  DEFAULT_ADMIN_ROLE: "0x0000000000000000000000000000000000000000000000000000000000000000",

  // ============ OkuMoney Roles ============
  OKUM_UPGRADER: keccak256(toUtf8Bytes("OKUM_UPGRADER")),
  OKUM_PAUSER: keccak256(toUtf8Bytes("OKUM_PAUSER")),
  OKUM_UNPAUSER: keccak256(toUtf8Bytes("OKUM_UNPAUSER")),
  OKUM_MINTER: keccak256(toUtf8Bytes("OKUM_MINTER")),
  // Cycle 4 (EVM-15): OKUM_BURNER was split out of OKUM_MINTER. Both LitePSM
  // and RedemptionQueue must hold OKUM_BURNER to call `OkuMoney.burn(...)`.
  OKUM_BURNER: keccak256(toUtf8Bytes("OKUM_BURNER")),
  OKUM_REBASER: keccak256(toUtf8Bytes("OKUM_REBASER")),
  OKUM_BLACKLISTER: keccak256(toUtf8Bytes("OKUM_BLACKLISTER")),
  OKUM_UNBLACKLISTER: keccak256(toUtf8Bytes("OKUM_UNBLACKLISTER")),
  OKUM_CAP_MANAGER: keccak256(toUtf8Bytes("OKUM_CAP_MANAGER")),
  OKUM_ALLOWANCE_MANAGER: keccak256(toUtf8Bytes("OKUM_ALLOWANCE_MANAGER")),

  // ============ OkuDollar (Vault) Roles ============
  VAULT_UPGRADER:         keccak256(toUtf8Bytes("VAULT_UPGRADER")),
  VAULT_PAUSER:           keccak256(toUtf8Bytes("VAULT_PAUSER")),
  VAULT_UNPAUSER:         keccak256(toUtf8Bytes("VAULT_UNPAUSER")),
  /// Withdraws OkuM donated directly to the vault. Donations accrue to nobody under
  /// the single-multiplier design (conversions use the multiplier, not
  /// totalAssets/totalSupply), so without this they would be locked forever.
  VAULT_RESCUER:          keccak256(toUtf8Bytes("VAULT_RESCUER")),
  // REMOVED (single-multiplier refactor): VAULT_REBASER — OkuDollar has no rate of
  // its own; accrual is set on OkuMoney via OKUM_REBASER. VAULT_RESERVE_MANAGER and
  // VAULT_ADMIN — collateralization is 1.0 by construction, so there is no surplus
  // to manage and no min-ratio to configure.

  // ============ LitePSM Roles ============
  PSM_UPGRADER: keccak256(toUtf8Bytes("PSM_UPGRADER")),
  PSM_PAUSER: keccak256(toUtf8Bytes("PSM_PAUSER")),
  PSM_UNPAUSER: keccak256(toUtf8Bytes("PSM_UNPAUSER")),
  PSM_QUEUE_PROCESSOR: keccak256(toUtf8Bytes("PSM_QUEUE_PROCESSOR")),
  PSM_BUFFER_DEPOSITOR: keccak256(toUtf8Bytes("PSM_BUFFER_DEPOSITOR")),
  PSM_BUFFER_WITHDRAWER: keccak256(toUtf8Bytes("PSM_BUFFER_WITHDRAWER")),

  // ============ RedemptionQueue Roles ============
  QUEUE_UPGRADER: keccak256(toUtf8Bytes("QUEUE_UPGRADER")),
  QUEUE_PSM: keccak256(toUtf8Bytes("QUEUE_PSM")),
  QUEUE_RESCUER: keccak256(toUtf8Bytes("QUEUE_RESCUER")),
};

/**
 * Helper to get role name from hash (for logging)
 */
export function getRoleName(roleHash: string): string {
  const entry = Object.entries(ROLES).find(([_, hash]) => hash === roleHash);
  return entry ? entry[0] : "UNKNOWN_ROLE";
}
