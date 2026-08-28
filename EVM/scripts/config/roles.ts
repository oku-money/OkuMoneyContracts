/**
 * Role constants for the reviewed-conversion contract suite.
 * These are the keccak256 hashes of role names used in OpenZeppelin AccessControl.
 *
 * NOTE: These MUST match `src/lib/Roles.sol` exactly. `verifyRoleParity` below is
 * called by the deploy and grant scripts to fail loudly on drift.
 *
 * AccessControl mappings are PER CONTRACT, so a role hash shared across contracts
 * (e.g. OKU_MINTER on both OkuM and USDOku) still requires a separate grant on each.
 */

import { keccak256, toUtf8Bytes } from "ethers";

const role = (name: string) => keccak256(toUtf8Bytes(name));

export const ROLES = {
  // Default admin role (AccessControl). Also gates USDOku.setWrapper.
  DEFAULT_ADMIN_ROLE: "0x0000000000000000000000000000000000000000000000000000000000000000",

  // ============ OkuM ============
  OKU_UPGRADER: role("OKU_UPGRADER"),
  OKU_PAUSER: role("OKU_PAUSER"),
  OKU_UNPAUSER: role("OKU_UNPAUSER"),
  /** Contract-only: SubscriptionModule on OkuM, USDOkuWrapper on USDOku. */
  OKU_MINTER: role("OKU_MINTER"),
  /** Contract-only. See OKU_MINTER. */
  OKU_BURNER: role("OKU_BURNER"),
  /** Shared hash across OkuM and USDOku; must be granted on each separately. */
  OKU_BLACKLISTER: role("OKU_BLACKLISTER"),
  OKU_UNBLACKLISTER: role("OKU_UNBLACKLISTER"),
  OKU_CAP_MANAGER: role("OKU_CAP_MANAGER"),
  OKU_ALLOWANCE_MANAGER: role("OKU_ALLOWANCE_MANAGER"),
  /** Orchestrator: setOkuMultiplier (OkuM) + setUsdOkuRate (USDOku). */
  OKU_RATE_SETTER: role("OKU_RATE_SETTER"),
  /** Warm: haltAccrual / haltUsdOkuAccrual. Cannot resume. */
  OKU_GUARDIAN: role("OKU_GUARDIAN"),
  /** Cold: resumeAccrual / resumeUsdOkuAccrual. Deliberately not OKU_GUARDIAN. */
  OKU_ACCRUAL_RESUMER: role("OKU_ACCRUAL_RESUMER"),

  // ============ USDOku ============
  USD_UPGRADER: role("USD_UPGRADER"),
  USD_PAUSER: role("USD_PAUSER"),
  USD_UNPAUSER: role("USD_UNPAUSER"),

  // ============ USDOkuWrapper ============
  WRAPPER_UPGRADER: role("WRAPPER_UPGRADER"),
  /** Cold: setWrapEnabled (sunset) + withdrawSurplus (pre-funding recovery). */
  WRAPPER_ADMIN: role("WRAPPER_ADMIN"),

  // ============ SubscriptionModule ============
  SUB_UPGRADER: role("SUB_UPGRADER"),
  SUB_PAUSER: role("SUB_PAUSER"),
  SUB_UNPAUSER: role("SUB_UNPAUSER"),
  /** Orchestrator: fulfill / reject. Deliberately split from OKU_RATE_SETTER. */
  REQUEST_FULFILLER: role("REQUEST_FULFILLER"),
  SUB_FEE_MANAGER: role("SUB_FEE_MANAGER"),
  SUB_TREASURY_MANAGER: role("SUB_TREASURY_MANAGER"),
  SUB_SWEEPER: role("SUB_SWEEPER"),
} as const;

export type RoleName = keyof typeof ROLES;

/** Roles that must only ever be held by contracts, never by an EOA. */
export const CONTRACT_ONLY_ROLES: RoleName[] = ["OKU_MINTER", "OKU_BURNER"];

/** Which roles each proxy actually defines, for grant scripts and verification. */
export const ROLES_BY_CONTRACT: Record<string, RoleName[]> = {
  OkuM: [
    "DEFAULT_ADMIN_ROLE",
    "OKU_UPGRADER",
    "OKU_PAUSER",
    "OKU_UNPAUSER",
    "OKU_MINTER",
    "OKU_BURNER",
    "OKU_BLACKLISTER",
    "OKU_UNBLACKLISTER",
    "OKU_CAP_MANAGER",
    "OKU_ALLOWANCE_MANAGER",
    "OKU_RATE_SETTER",
    "OKU_GUARDIAN",
    "OKU_ACCRUAL_RESUMER",
  ],
  USDOku: [
    "DEFAULT_ADMIN_ROLE",
    "USD_UPGRADER",
    "USD_PAUSER",
    "USD_UNPAUSER",
    "OKU_RATE_SETTER",
    "OKU_GUARDIAN",
    "OKU_ACCRUAL_RESUMER",
    "OKU_BLACKLISTER",
    "OKU_UNBLACKLISTER",
    "OKU_MINTER",
    "OKU_BURNER",
  ],
  USDOkuWrapper: ["DEFAULT_ADMIN_ROLE", "WRAPPER_UPGRADER", "WRAPPER_ADMIN"],
  SubscriptionModule: [
    "DEFAULT_ADMIN_ROLE",
    "SUB_UPGRADER",
    "SUB_PAUSER",
    "SUB_UNPAUSER",
    "REQUEST_FULFILLER",
    "SUB_FEE_MANAGER",
    "SUB_TREASURY_MANAGER",
    "SUB_SWEEPER",
  ],
};

/** Per-proxy UUPS upgrader role. */
export const UPGRADER_ROLE_BY_CONTRACT: Record<string, RoleName> = {
  OkuM: "OKU_UPGRADER",
  USDOku: "USD_UPGRADER",
  USDOkuWrapper: "WRAPPER_UPGRADER",
  SubscriptionModule: "SUB_UPGRADER",
};

/**
 * Helper to get role name from hash (for logging).
 */
export function getRoleName(roleHash: string): string {
  const entry = Object.entries(ROLES).find(([, hash]) => hash === roleHash);
  return entry ? entry[0] : "UNKNOWN_ROLE";
}
