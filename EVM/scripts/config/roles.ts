/**
 * Role constants for OkuMoney contracts
 * These are the keccak256 hashes of role names used in AccessControl
 *
 * NOTE: These must match the roles defined in src/lib/Roles.sol
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

  // ============ OkuBridge Roles (RESERVED) ============
  // OkuBridge contract was removed in the noBridge refactor; the role constants
  // remain so a future re-introduction is a pure deploy + grant operation.
  BRIDGE_SIGNER_MANAGER: keccak256(toUtf8Bytes("BRIDGE_SIGNER_MANAGER")),
  BRIDGE_PAUSER: keccak256(toUtf8Bytes("BRIDGE_PAUSER")),
  BRIDGE_UNPAUSER: keccak256(toUtf8Bytes("BRIDGE_UNPAUSER")),
  BRIDGE_FEE_MANAGER: keccak256(toUtf8Bytes("BRIDGE_FEE_MANAGER")),
  BRIDGE_NONCE_ADMIN: keccak256(toUtf8Bytes("BRIDGE_NONCE_ADMIN")),
  BRIDGE_CHAIN_MANAGER: keccak256(toUtf8Bytes("BRIDGE_CHAIN_MANAGER")),
  BRIDGE_LIMITS_MANAGER: keccak256(toUtf8Bytes("BRIDGE_LIMITS_MANAGER")),
  BRIDGE_UPGRADER: keccak256(toUtf8Bytes("BRIDGE_UPGRADER")),
  BRIDGE_REFUND_INITIATOR: keccak256(toUtf8Bytes("BRIDGE_REFUND_INITIATOR")),
  BRIDGE_REFUND_CONFIRMER: keccak256(toUtf8Bytes("BRIDGE_REFUND_CONFIRMER")),

  // ============ OkuBridgeRouter Roles (RESERVED) ============
  // OkuBridgeRouter was removed in the noBridge refactor; constants kept for
  // forward compatibility (see OkuBridge note above).
  ROUTER_UPGRADER: keccak256(toUtf8Bytes("ROUTER_UPGRADER")),
  ROUTER_PAUSER: keccak256(toUtf8Bytes("ROUTER_PAUSER")),
  ROUTER_UNPAUSER: keccak256(toUtf8Bytes("ROUTER_UNPAUSER")),
  ROUTER_ADAPTER_MANAGER: keccak256(toUtf8Bytes("ROUTER_ADAPTER_MANAGER")),
  ROUTER_BRIDGE_MANAGER: keccak256(toUtf8Bytes("ROUTER_BRIDGE_MANAGER")),
};

/**
 * Helper to get role name from hash (for logging)
 */
export function getRoleName(roleHash: string): string {
  const entry = Object.entries(ROLES).find(([_, hash]) => hash === roleHash);
  return entry ? entry[0] : "UNKNOWN_ROLE";
}
