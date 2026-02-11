/**
 * Role constants for OkuMoney contracts
 * These are the keccak256 hashes of role names used in AccessControl
 */

import { keccak256, toUtf8Bytes } from "ethers";

export const ROLES = {
  // Default admin role (AccessControl)
  DEFAULT_ADMIN_ROLE: "0x0000000000000000000000000000000000000000000000000000000000000000",

  // OkuUSD roles
  MINTER_ROLE: keccak256(toUtf8Bytes("MINTER_ROLE")),
  REBASER_ROLE: keccak256(toUtf8Bytes("REBASER_ROLE")),
  ALLOWANCE_MANAGER_ROLE: keccak256(toUtf8Bytes("ALLOWANCE_MANAGER_ROLE")),
  PAUSER_ROLE: keccak256(toUtf8Bytes("PAUSER_ROLE")),
  UPGRADE_ROLE: keccak256(toUtf8Bytes("UPGRADE_ROLE")),

  // RedemptionQueue roles
  PSM_ROLE: keccak256(toUtf8Bytes("PSM_ROLE")),

  // LitePSM roles
  BUFFER_DEPOSITOR_ROLE: keccak256(toUtf8Bytes("BUFFER_DEPOSITOR_ROLE")),
  QUEUE_PROCESSOR_ROLE: keccak256(toUtf8Bytes("QUEUE_PROCESSOR_ROLE")),

  // OkuBridgeRouter roles
  ADAPTER_MANAGER_ROLE: keccak256(toUtf8Bytes("ADAPTER_MANAGER_ROLE")),
  BRIDGE_OPERATOR_ROLE: keccak256(toUtf8Bytes("BRIDGE_OPERATOR_ROLE")),

  // OkuBridge roles
  BRIDGE_SIGNER_MANAGER_ROLE: keccak256(toUtf8Bytes("BRIDGE_SIGNER_MANAGER_ROLE")),
  BRIDGE_PAUSER_ROLE: keccak256(toUtf8Bytes("BRIDGE_PAUSER_ROLE")),
  BRIDGE_UNPAUSER_ROLE: keccak256(toUtf8Bytes("BRIDGE_UNPAUSER_ROLE")),
  BRIDGE_FEE_MANAGER_ROLE: keccak256(toUtf8Bytes("BRIDGE_FEE_MANAGER_ROLE")),
  BRIDGE_NONCE_ADMIN_ROLE: keccak256(toUtf8Bytes("BRIDGE_NONCE_ADMIN_ROLE")),
  BRIDGE_CHAIN_MANAGER_ROLE: keccak256(toUtf8Bytes("BRIDGE_CHAIN_MANAGER_ROLE")),
  BRIDGE_LIMITS_MANAGER_ROLE: keccak256(toUtf8Bytes("BRIDGE_LIMITS_MANAGER_ROLE")),
  BRIDGE_REFUND_ADMIN_ROLE: keccak256(toUtf8Bytes("BRIDGE_REFUND_ADMIN_ROLE")),
};

/**
 * Helper to get role name from hash (for logging)
 */
export function getRoleName(roleHash: string): string {
  const entry = Object.entries(ROLES).find(([_, hash]) => hash === roleHash);
  return entry ? entry[0] : "UNKNOWN_ROLE";
}
