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
  VAULT_REBASER:          keccak256(toUtf8Bytes("VAULT_REBASER")),
  VAULT_RESERVE_MANAGER:  keccak256(toUtf8Bytes("VAULT_RESERVE_MANAGER")),
  VAULT_PAUSER:           keccak256(toUtf8Bytes("VAULT_PAUSER")),
  VAULT_UNPAUSER:         keccak256(toUtf8Bytes("VAULT_UNPAUSER")),
  /// Dedicated vault-admin role for parameter updates (e.g. min collateral ratio)
  /// — see Roles.sol for the rationale on carving this out from DEFAULT_ADMIN_ROLE.
  VAULT_ADMIN:            keccak256(toUtf8Bytes("VAULT_ADMIN")),

  // ============ LitePSM Roles ============
  PSM_UPGRADER: keccak256(toUtf8Bytes("PSM_UPGRADER")),
  PSM_PAUSER: keccak256(toUtf8Bytes("PSM_PAUSER")),
  PSM_UNPAUSER: keccak256(toUtf8Bytes("PSM_UNPAUSER")),
  PSM_QUEUE_PROCESSOR: keccak256(toUtf8Bytes("PSM_QUEUE_PROCESSOR")),
  PSM_BUFFER_DEPOSITOR: keccak256(toUtf8Bytes("PSM_BUFFER_DEPOSITOR")),
  PSM_BUFFER_WITHDRAWER: keccak256(toUtf8Bytes("PSM_BUFFER_WITHDRAWER")),
  PSM_ORACLE_MANAGER: keccak256(toUtf8Bytes("PSM_ORACLE_MANAGER")),

  // ============ RedemptionQueue Roles ============
  QUEUE_UPGRADER: keccak256(toUtf8Bytes("QUEUE_UPGRADER")),
  QUEUE_PSM: keccak256(toUtf8Bytes("QUEUE_PSM")),
  QUEUE_RESCUER: keccak256(toUtf8Bytes("QUEUE_RESCUER")),
  QUEUE_ORACLE_MANAGER: keccak256(toUtf8Bytes("QUEUE_ORACLE_MANAGER")),

  // ============ OracleRelay Roles ============
  RELAY_UPGRADER: keccak256(toUtf8Bytes("RELAY_UPGRADER")),
  RELAY_FEED_MANAGER: keccak256(toUtf8Bytes("RELAY_FEED_MANAGER")),
  RELAY_CONFIG_MANAGER: keccak256(toUtf8Bytes("RELAY_CONFIG_MANAGER")),
};

/**
 * Helper to get role name from hash (for logging)
 */
export function getRoleName(roleHash: string): string {
  const entry = Object.entries(ROLES).find(([_, hash]) => hash === roleHash);
  return entry ? entry[0] : "UNKNOWN_ROLE";
}
