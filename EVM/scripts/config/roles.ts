/**
 * Role constants for the OkuMoney (OkuM / USDOku) contracts.
 * keccak256 hashes of the role names used by OpenZeppelin AccessControl.
 *
 * MUST match `src/lib/Roles.sol`. `verifyRoleParity()` below asserts the two
 * sets agree at deploy time so a rename on one side cannot drift silently.
 *
 * AccessControl mappings are PER CONTRACT. The `OKU_*` set is used by BOTH
 * tokens — the same 32-byte constant, granted separately on OkuM and on USDOku.
 * A grant on one is not a grant on the other, and the deploy script wires them
 * independently for exactly that reason.
 *
 * Rename history (kept because a role identifier outlives the contract name it
 * was introduced for, and every deployed-grant audit trail is keyed on the
 * hash rather than the label):
 *
 *   v0.2 -> v0.3, single-token model:
 *     - `OKUM_*` -> `OKU_*`, `OKUM_REBASER` -> `OKU_RATE_SETTER`
 *     - `OKU_GUARDIAN` added; all seven `VAULT_*` roles removed with the vault
 *
 *   v0.3 -> v0.4, two-token model (this refactor):
 *     - `OkuDollar` -> `OkuM`, `LitePSM` -> `SubscriptionModule`; NO role
 *       constant changed. The `PSM_*` prefix is deliberately retained even
 *       though the contract is now `SubscriptionModule` — renaming the
 *       constants would rotate every hash and invalidate the grant history for
 *       zero semantic gain.
 *     - `USDOku` (rebasing dollar token) and `USDOkuWrapper` introduced. USDOku
 *       reuses the `OKU_*` constants; the wrapper gets its own `WRAPPER_*` set.
 *     - `OKU_RATE_SETTER` now covers TWO distinct writes: `setOkuMultiplier` on
 *       OkuM (stepwise realized mark) and `setUsdOkuRate` on USDOku (continuous
 *       declared rate). Same key class, different mechanisms and different
 *       bounds — see the per-role notes below.
 */

import { keccak256, toUtf8Bytes } from "ethers";

const h = (name: string) => keccak256(toUtf8Bytes(name));

export const ROLES = {
  DEFAULT_ADMIN_ROLE: "0x0000000000000000000000000000000000000000000000000000000000000000",

  // ============ Tokens: OkuM AND USDOku (granted per contract) ============
  OKU_UPGRADER: h("OKU_UPGRADER"),
  OKU_PAUSER: h("OKU_PAUSER"),
  OKU_UNPAUSER: h("OKU_UNPAUSER"),
  /** On OkuM: the SubscriptionModule proxy. On USDOku: the USDOkuWrapper proxy. */
  OKU_MINTER: h("OKU_MINTER"),
  /**
   * Split from OKU_MINTER so the burn surface can be locked down independently.
   * On OkuM: SubscriptionModule (instant redeem) and RedemptionQueue (queued
   * redeem). On USDOku: USDOkuWrapper (unwrap). All burn only their own balance.
   */
  OKU_BURNER: h("OKU_BURNER"),
  /**
   * The multiplier/rate authority on both tokens.
   *   OkuM   — `setOkuMultiplier(newMultiplier)`: stepwise, bounded by
   *            MAX_STEP_BPS, step coverage (`tin + tout >= stepBps`),
   *            monotonicity and MAX_MULTIPLIER.
   *   USDOku — `setUsdOkuRate(ratePerSecond, endTimestamp)`: continuous,
   *            bounded by MAX_IMPLIED_APR, MAX_RATE_DURATION, monotonicity,
   *            MAX_MULTIPLIER and the projected-solvency check.
   */
  OKU_RATE_SETTER: h("OKU_RATE_SETTER"),
  /**
   * Withhold-only, on both tokens: `haltAccrual()` on OkuM (sets a flag that
   * blocks further steps until cold calls `resumeAccrual`) and
   * `haltUsdOkuAccrual()` on USDOku (freezes the index in place). Cannot set a
   * rate and cannot reduce anything already accrued — that monotone-safety is
   * why it sits on the warm multisig.
   */
  OKU_GUARDIAN: h("OKU_GUARDIAN"),
  OKU_BLACKLISTER: h("OKU_BLACKLISTER"),
  OKU_UNBLACKLISTER: h("OKU_UNBLACKLISTER"),
  /**
   * Cold economic/safety policy. On OkuM this also gates
   * `setSyncWindowDuration`, `setStepFeeSource`, `resetStepHighWaterMark` and
   * `resumeAccrual`; on USDOku it gates `setSolvencySource`.
   */
  OKU_CAP_MANAGER: h("OKU_CAP_MANAGER"),
  /** OkuM only — USDOku has no minter-allowance system (the wrapper is the only minter). */
  OKU_ALLOWANCE_MANAGER: h("OKU_ALLOWANCE_MANAGER"),

  // ============ SubscriptionModule (formerly LitePSM) ============
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
   *
   * Load-bearing in the two-token model: `tin + tout` is the step-coverage
   * budget. At zero fees NO multiplier step is possible at all, and the
   * combined value can never drop below OkuM's `stepHighWaterMark`
   * (`FeesBelowStepFloor`).
   */
  PSM_FEE_MANAGER: h("PSM_FEE_MANAGER"),

  // ============ RedemptionQueue ============
  QUEUE_UPGRADER: h("QUEUE_UPGRADER"),
  /** Granted post-deploy to the SubscriptionModule proxy, never to a key. */
  QUEUE_PSM: h("QUEUE_PSM"),
  QUEUE_RESCUER: h("QUEUE_RESCUER"),

  // ============ USDOkuWrapper ============
  WRAPPER_UPGRADER: h("WRAPPER_UPGRADER"),
  WRAPPER_PAUSER: h("WRAPPER_PAUSER"),
  WRAPPER_UNPAUSER: h("WRAPPER_UNPAUSER"),
  /**
   * Sunset control: can disable `wrap` (step 1 of the USDOku sunset). There is
   * deliberately no equivalent for `unwrap` — no code path exists for it, so no
   * key can close the exit.
   */
  WRAPPER_ADMIN: h("WRAPPER_ADMIN"),
  /**
   * Withdraws genuinely excess OkuM backing (`surplus()`) once realized
   * `M_oku` marks overtake declared USDOku liability — the recovery path for
   * issuer capital that funded a solvency gap. Bounded so a withdrawal may
   * only remove backing above full parity, never spend down to
   * `MAX_SOLVENCY_GAP_BPS`. Separate constant from `WRAPPER_ADMIN` even though
   * both are cold in practice: moving capital out is a materially different
   * capability than gating the sunset switch.
   */
  WRAPPER_RESERVE_MANAGER: h("WRAPPER_RESERVE_MANAGER"),
} as const;

/**
 * Roles that must NEVER be held by an EOA or multisig — contracts only.
 *
 * Unchanged by the two-token refactor, because the constants are shared: the
 * same `OKU_MINTER` entry covers "SubscriptionModule on OkuM" and
 * "USDOkuWrapper on USDOku". The holder is per-contract; the prohibition is not.
 */
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
