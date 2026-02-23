/**
 * Role constants for OkuMoney contracts
 * These are the keccak256 hashes of role names used in AccessControl
 */

import { keccak256, toUtf8Bytes } from "ethers";

export const ROLES = {
  // Default admin role (AccessControl)
  DEFAULT_ADMIN_ROLE: "0x0000000000000000000000000000000000000000000000000000000000000000",

  // OkuUSD roles
  MINTER: keccak256(toUtf8Bytes("MINTER")),
  REBASER: keccak256(toUtf8Bytes("REBASER")),
  ALLOWANCE_MANAGER: keccak256(toUtf8Bytes("ALLOWANCE_MANAGER")),
  OKUUSD_PAUSER: keccak256(toUtf8Bytes("OKUUSD_PAUSER")),
  UPGRADER: keccak256(toUtf8Bytes("UPGRADER")),

  // RedemptionQueue roles
  PSM: keccak256(toUtf8Bytes("PSM")),

  // LitePSM roles
  BUFFER_DEPOSITOR: keccak256(toUtf8Bytes("BUFFER_DEPOSITOR")),
  QUEUE_PROCESSOR: keccak256(toUtf8Bytes("QUEUE_PROCESSOR")),

  // OkuBridgeRouter roles
  ADAPTER_MANAGER: keccak256(toUtf8Bytes("ADAPTER_MANAGER")),
  BRIDGE_OPERATOR: keccak256(toUtf8Bytes("BRIDGE_OPERATOR")),

  // OkuBridge roles
  BRIDGE_SIGNER_MANAGER: keccak256(toUtf8Bytes("BRIDGE_SIGNER_MANAGER")),
  BRIDGE_PAUSER: keccak256(toUtf8Bytes("BRIDGE_PAUSER")),
  BRIDGE_UNPAUSER: keccak256(toUtf8Bytes("BRIDGE_UNPAUSER")),
  BRIDGE_FEE_MANAGER: keccak256(toUtf8Bytes("BRIDGE_FEE_MANAGER")),
  BRIDGE_NONCE_ADMIN: keccak256(toUtf8Bytes("BRIDGE_NONCE_ADMIN")),
  BRIDGE_CHAIN_MANAGER: keccak256(toUtf8Bytes("BRIDGE_CHAIN_MANAGER")),
  BRIDGE_LIMITS_MANAGER: keccak256(toUtf8Bytes("BRIDGE_LIMITS_MANAGER")),
  BRIDGE_REFUND_ADMIN: keccak256(toUtf8Bytes("BRIDGE_REFUND_ADMIN")),
};

/**
 * Helper to get role name from hash (for logging)
 */
export function getRoleName(roleHash: string): string {
  const entry = Object.entries(ROLES).find(([_, hash]) => hash === roleHash);
  return entry ? entry[0] : "UNKNOWN_ROLE";
}
