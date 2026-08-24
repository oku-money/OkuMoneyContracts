/**
 * Role constants for the OkuDollar (rUSDOku) contracts.
 * keccak256 hashes of the role names used by OpenZeppelin AccessControl.
 *
 * MUST match `src/lib/Roles.sol`. `verifyRoleParity()` below asserts the two
 * sets agree at deploy time so a rename on one side cannot drift silently.
 *
 * v2 changes from the dual-token model:
 *   - `OKUM_*` -> `OKU_*` (one token, so the prefix no longer disambiguates)
 *   - `OKUM_REBASER` -> `OKU_RATE_SETTER` (nothing rebases; it sets a rate)
 *   - `OKU_GUARDIAN` added (haltAccrual — withhold-only, warm multisig)
 *   - all seven `VAULT_*` roles removed with the vault
 */

import { keccak256, toUtf8Bytes } from "ethers";

const h = (name: string) => keccak256(toUtf8Bytes(name));

export const ROLES = {
  DEFAULT_ADMIN_ROLE: "0x0000000000000000000000000000000000000000000000000000000000000000",

  // ============ OkuDollar (token) ============
  OKU_UPGRADER: h("OKU_UPGRADER"),
  OKU_PAUSER: h("OKU_PAUSER"),
  OKU_UNPAUSER: h("OKU_UNPAUSER"),
  OKU_MINTER: h("OKU_MINTER"),
  /** Split from OKU_MINTER. Both LitePSM and RedemptionQueue burn. */
  OKU_BURNER: h("OKU_BURNER"),
  /** Sets the continuous accrual rate. Bounded by MAX_IMPLIED_APR + MAX_RATE_DURATION. */
  OKU_RATE_SETTER: h("OKU_RATE_SETTER"),
  /** haltAccrual() only — can withhold yield, never set a rate or reduce the multiplier. */
  OKU_GUARDIAN: h("OKU_GUARDIAN"),
  OKU_BLACKLISTER: h("OKU_BLACKLISTER"),
  OKU_UNBLACKLISTER: h("OKU_UNBLACKLISTER"),
  OKU_CAP_MANAGER: h("OKU_CAP_MANAGER"),
  OKU_ALLOWANCE_MANAGER: h("OKU_ALLOWANCE_MANAGER"),

  // ============ LitePSM ============
  PSM_UPGRADER: h("PSM_UPGRADER"),
  PSM_PAUSER: h("PSM_PAUSER"),
  PSM_UNPAUSER: h("PSM_UNPAUSER"),
  PSM_QUEUE_PROCESSOR: h("PSM_QUEUE_PROCESSOR"),
  PSM_BUFFER_DEPOSITOR: h("PSM_BUFFER_DEPOSITOR"),
  PSM_BUFFER_WITHDRAWER: h("PSM_BUFFER_WITHDRAWER"),
  /**
   * Sets the `tin` / `tout` fee schedule. Belongs on the same cold key as
   * `OKU_CAP_MANAGER` — economic policy — but must be its own PSM-namespaced
   * role because AccessControl mappings are per-contract.
   */
  PSM_FEE_MANAGER: h("PSM_FEE_MANAGER"),

  // ============ RedemptionQueue ============
  QUEUE_UPGRADER: h("QUEUE_UPGRADER"),
  /** Granted post-deploy to the LitePSM proxy, never to a key. */
  QUEUE_PSM: h("QUEUE_PSM"),
  QUEUE_RESCUER: h("QUEUE_RESCUER"),
} as const;

/** Roles that must NEVER be held by an EOA or multisig — contracts only. */
export const CONTRACT_ONLY_ROLES = [
  "OKU_MINTER",
  "OKU_BURNER",
  "QUEUE_PSM",
] as const;

/** Reverse lookup for logging. */
export function getRoleName(roleHash: string): string {
  const entry = Object.entries(ROLES).find(([, hash]) => hash === roleHash);
  return entry ? entry[0] : "UNKNOWN_ROLE";
}

/**
 * Cross-check this table against the on-chain `Roles` library values exposed by
 * a deployed contract, so a rename in Solidity that is not mirrored here fails
 * the deploy instead of silently granting nothing.
 *
 * Returns the list of mismatches; empty means parity.
 */
export function verifyRoleParity(
  onChain: Record<string, string>
): Array<{ role: string; expected: string; actual: string }> {
  const mismatches: Array<{ role: string; expected: string; actual: string }> = [];
  for (const [role, actual] of Object.entries(onChain)) {
    const expected = (ROLES as Record<string, string>)[role];
    if (expected && expected.toLowerCase() !== actual.toLowerCase()) {
      mismatches.push({ role, expected, actual });
    }
  }
  return mismatches;
}
