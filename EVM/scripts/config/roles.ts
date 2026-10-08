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
  // LitePSM must hold OKUM_BURNER to call `OkuMoney.burn(...)` on redeem.
  OKUM_BURNER: keccak256(toUtf8Bytes("OKUM_BURNER")),
  OKUM_RATE_MANAGER: keccak256(toUtf8Bytes("OKUM_RATE_MANAGER")),
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

  // ============ LitePSM Roles ============
  PSM_UPGRADER: keccak256(toUtf8Bytes("PSM_UPGRADER")),
  PSM_PAUSER: keccak256(toUtf8Bytes("PSM_PAUSER")),
  PSM_UNPAUSER: keccak256(toUtf8Bytes("PSM_UNPAUSER")),
  PSM_BUFFER_DEPOSITOR: keccak256(toUtf8Bytes("PSM_BUFFER_DEPOSITOR")),
  PSM_BUFFER_WITHDRAWER: keccak256(toUtf8Bytes("PSM_BUFFER_WITHDRAWER")),
};

/**
 * Helper to get role name from hash (for logging)
 */
export function getRoleName(roleHash: string): string {
  const entry = Object.entries(ROLES).find(([_, hash]) => hash === roleHash);
  return entry ? entry[0] : "UNKNOWN_ROLE";
}
