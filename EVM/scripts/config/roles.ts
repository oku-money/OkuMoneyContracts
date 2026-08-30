/**
 * Role constants for the Oku Money suite.
 *
 * MUST mirror `src/lib/Roles.sol` exactly. A drifting hash here does not fail
 * loudly - it silently grants nothing - so the deploy script asserts every role it
 * uses against the on-chain constant before broadcasting.
 */

import { keccak256, toUtf8Bytes } from "ethers";

export const ROLES = {
  // Default admin role (AccessControl)
  DEFAULT_ADMIN_ROLE: "0x0000000000000000000000000000000000000000000000000000000000000000",

  // ============ OkuM ============
  OKUM_UPGRADER: keccak256(toUtf8Bytes("OKUM_UPGRADER")),
  OKUM_PAUSER: keccak256(toUtf8Bytes("OKUM_PAUSER")),
  OKUM_UNPAUSER: keccak256(toUtf8Bytes("OKUM_UNPAUSER")),
  OKUM_MINTER: keccak256(toUtf8Bytes("OKUM_MINTER")),
  // Split from OKUM_MINTER so the burn surface can be locked down independently.
  OKUM_BURNER: keccak256(toUtf8Bytes("OKUM_BURNER")),
  // Declares OkuM rate segments. Sets the price every permissionless conversion
  // executes at, on every chain - the highest-value key in the system.
  OKUM_RATE_SETTER: keccak256(toUtf8Bytes("OKUM_RATE_SETTER")),
  OKUM_BLACKLISTER: keccak256(toUtf8Bytes("OKUM_BLACKLISTER")),
  OKUM_UNBLACKLISTER: keccak256(toUtf8Bytes("OKUM_UNBLACKLISTER")),
  OKUM_CAP_MANAGER: keccak256(toUtf8Bytes("OKUM_CAP_MANAGER")),
  OKUM_ALLOWANCE_MANAGER: keccak256(toUtf8Bytes("OKUM_ALLOWANCE_MANAGER")),

  // ============ USDOku (vault) ============
  VAULT_UPGRADER: keccak256(toUtf8Bytes("VAULT_UPGRADER")),
  // Declares USDOku's forward-looking rate. Cannot outrun the OkuM backing:
  // setUsdOkuRate enforces pre-funding against vault reserves.
  VAULT_RATE_SETTER: keccak256(toUtf8Bytes("VAULT_RATE_SETTER")),
  VAULT_RESERVE_MANAGER: keccak256(toUtf8Bytes("VAULT_RESERVE_MANAGER")),
  VAULT_PAUSER: keccak256(toUtf8Bytes("VAULT_PAUSER")),
  VAULT_UNPAUSER: keccak256(toUtf8Bytes("VAULT_UNPAUSER")),

  // ============ LitePSM ============
  PSM_UPGRADER: keccak256(toUtf8Bytes("PSM_UPGRADER")),
  PSM_PAUSER: keccak256(toUtf8Bytes("PSM_PAUSER")),
  PSM_UNPAUSER: keccak256(toUtf8Bytes("PSM_UNPAUSER")),
  PSM_BUFFER_DEPOSITOR: keccak256(toUtf8Bytes("PSM_BUFFER_DEPOSITOR")),
  PSM_BUFFER_WITHDRAWER: keccak256(toUtf8Bytes("PSM_BUFFER_WITHDRAWER")),
  // The KMS back-end's routine lever: toggles permissionless mint and redeem
  // without the ceremony of a full pause.
  PSM_GATEKEEPER: keccak256(toUtf8Bytes("PSM_GATEKEEPER")),
};

/**
 * Helper to get role name from hash (for logging)
 */
export function getRoleName(roleHash: string): string {
  const entry = Object.entries(ROLES).find(([_, hash]) => hash === roleHash);
  return entry ? entry[0] : "UNKNOWN_ROLE";
}
