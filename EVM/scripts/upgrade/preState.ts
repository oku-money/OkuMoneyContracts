/**
 * Per-contract state snapshots for the upgrade script.
 *
 * An upgrade replaces code, not storage, so every stored value must read the
 * same before and after — EXCEPT values a legitimate transaction changed in
 * between. The two snapshots are therefore pinned to blocks (`blockTag`), and
 * each field declares which events may explain a change:
 *
 *   - "invariant"  wiring, identity, roles, config. A change fails the upgrade
 *                  unless one of `explainedBy` was emitted by the contract in
 *                  (preBlock, postBlock].
 *   - "volatile"   balances and supply: move with every user transaction. Shown
 *                  for the record, never diffed; covered by `INVARIANT_CHECKS`.
 *
 * Time-dependent views (`okuMMultiplier`, `usdMultiplier`, `totalSupply` of
 * OkuDollar, ...) are NOT snapshotted at all: they drift between two reads with
 * zero storage change. The post-upgrade checks assert them against the stored
 * schedule instead.
 *
 * Adding a target: a reader here, a row in `UPGRADE_TARGETS` (./index.ts), and
 * any cross-contract invariants in `INVARIANT_CHECKS`.
 */

import { Contract, ethers } from "ethers";
import { computeMultiplier } from "@okumoney/yield-tooling";
import { ROLES } from "../config/roles";

export type FieldKind = "invariant" | "volatile";

export interface Field {
  value: string;
  kind: FieldKind;
  /** Events (by name) that may legitimately change an invariant field. */
  explainedBy?: string[];
}

export type StateSnapshot = Record<string, Field>;

/** Addresses whose role holdings are pinned across the upgrade. */
export interface SnapshotContext {
  blockTag: number;
  /** label -> address. Usually: signer, LitePSM, OkuDollar, ledger grantees, MAINNET_* keys. */
  roleHolders: Record<string, string>;
  /** label -> address. Checked against `isBlacklisted` (none by default). */
  blacklistProbes?: Record<string, string>;
}

const ROLE_EVENTS = ["RoleGranted", "RoleRevoked", "RoleAdminChanged"];
const PAUSE_EVENTS = ["Paused", "Unpaused"];

const inv = (value: unknown, explainedBy?: string[]): Field => ({
  value: String(value),
  kind: "invariant",
  explainedBy,
});
const vol = (value: unknown): Field => ({ value: String(value), kind: "volatile" });

/** Roles relevant to each contract (AccessControl is per-contract). */
const CONTRACT_ROLES: Record<string, (keyof typeof ROLES)[]> = {
  OkuMoney: [
    "DEFAULT_ADMIN_ROLE", "OKUM_UPGRADER", "OKUM_PAUSER", "OKUM_UNPAUSER", "OKUM_MINTER",
    "OKUM_BURNER", "OKUM_REBASER", "OKUM_BLACKLISTER", "OKUM_UNBLACKLISTER",
    "OKUM_CAP_MANAGER", "OKUM_ALLOWANCE_MANAGER",
  ],
  OkuDollar: [
    "DEFAULT_ADMIN_ROLE", "VAULT_UPGRADER", "VAULT_PAUSER", "VAULT_UNPAUSER", "VAULT_RESCUER",
    "OKUM_BLACKLISTER", "OKUM_UNBLACKLISTER",
  ],
  LitePSM: [
    "DEFAULT_ADMIN_ROLE", "PSM_UPGRADER", "PSM_PAUSER", "PSM_UNPAUSER",
    "PSM_BUFFER_DEPOSITOR", "PSM_BUFFER_WITHDRAWER",
  ],
};

async function roleMatrix(
  name: string,
  c: Contract,
  ctx: SnapshotContext
): Promise<StateSnapshot> {
  const out: StateSnapshot = {};
  const opts = { blockTag: ctx.blockTag };
  for (const role of CONTRACT_ROLES[name] ?? []) {
    for (const [label, addr] of Object.entries(ctx.roleHolders)) {
      out[`role.${role}@${label}`] = inv(await c.hasRole(ROLES[role], addr, opts), ROLE_EVENTS);
    }
  }
  return out;
}

async function blacklist(c: Contract, ctx: SnapshotContext): Promise<StateSnapshot> {
  const out: StateSnapshot = {};
  for (const [label, addr] of Object.entries(ctx.blacklistProbes ?? {})) {
    out[`isBlacklisted@${label}`] = inv(
      await c.isBlacklisted(addr, { blockTag: ctx.blockTag }),
      ["Blacklisted", "Unblacklisted"]
    );
  }
  return out;
}

const erc20 = new ethers.Interface([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
]);

// ============================================================================
// OkuMoney — holds the ONLY rate schedule; OkuDollar derives from it.
// ============================================================================

export async function readOkuMoneyState(c: Contract, ctx: SnapshotContext): Promise<StateSnapshot> {
  const o = { blockTag: ctx.blockTag };
  const SCHEDULE = ["OkuMYieldRateUpdated", "NextOkuMYieldRateSet", "OkuMMultiplierUpdated"];
  const psm = ctx.roleHolders.LitePSM;
  const snap: StateSnapshot = {
    name: inv(await c.name(o)),
    symbol: inv(await c.symbol(o)),
    decimals: inv(await c.decimals(o)),
    maxSupply: inv(await c.maxSupply(o), ["MaxSupplyUpdated"]),
    paused: inv(await c.paused(o), PAUSE_EVENTS),
    okuMBaseMultiplier: inv(await c.okuMBaseMultiplier(o), SCHEDULE),
    okuMRatePerSecond: inv(await c.okuMRatePerSecond(o), SCHEDULE),
    okuMLastAccrualTime: inv(await c.okuMLastAccrualTime(o), SCHEDULE),
    okuMRateEnd: inv(await c.okuMRateEnd(o), SCHEDULE),
    okuMPendingRatePerSecond: inv(await c.okuMPendingRatePerSecond(o), SCHEDULE),
    okuMPendingRateEnd: inv(await c.okuMPendingRateEnd(o), SCHEDULE),
    // Written only by setOkuMMultiplier, which emits OkuMMultiplierUpdated.
    lastYieldDistributionBlock: inv(await c.lastYieldDistributionBlock(o), ["OkuMMultiplierUpdated"]),
    totalSupply: vol(await c.totalSupply(o)),
  };
  if (psm) {
    // Decremented by every PSM mint; reset by configureMinterAllowance.
    snap["minterAllowance@LitePSM"] = vol(await c.minterAllowance(psm, o));
  }
  return { ...snap, ...(await roleMatrix("OkuMoney", c, ctx)), ...(await blacklist(c, ctx)) };
}

// ============================================================================
// OkuDollar (vault)
// ============================================================================

export async function readOkuDollarState(c: Contract, ctx: SnapshotContext): Promise<StateSnapshot> {
  const o = { blockTag: ctx.blockTag };
  const snap: StateSnapshot = {
    name: inv(await c.name(o)),
    symbol: inv(await c.symbol(o)),
    decimals: inv(await c.decimals(o)),
    okuMoney: inv(await c.okuMoney(o)),
    asset: inv(await c.asset(o)),
    paused: inv(await c.paused(o), PAUSE_EVENTS),
    totalUsdShares: vol(await c.totalUsdShares(o)),
    totalOkuMReserves: vol(await c.totalOkuMReserves(o)),
  };
  return { ...snap, ...(await roleMatrix("OkuDollar", c, ctx)), ...(await blacklist(c, ctx)) };
}

// ============================================================================
// LitePSM
// ============================================================================

export async function readLitePSMState(c: Contract, ctx: SnapshotContext): Promise<StateSnapshot> {
  const o = { blockTag: ctx.blockTag };
  const usdc = String(await c.usdc(o));
  const provider = c.runner?.provider;
  if (!provider) throw new Error("LitePSM state reader needs a provider-backed contract");
  const usdcToken = new ethers.Contract(usdc, erc20, provider);
  const snap: StateSnapshot = {
    okuMoney: inv(await c.okuMoney(o)),
    okuDollar: inv(await c.okuDollar(o)),
    usdc: inv(usdc),
    usdcDecimalMultiplier: inv(await c.usdcDecimalMultiplier(o)),
    paused: inv(await c.paused(o), PAUSE_EVENTS),
    usdcBuffer: vol(await usdcToken.balanceOf(await c.getAddress(), o)),
  };
  return { ...snap, ...(await roleMatrix("LitePSM", c, ctx)) };
}

export const STATE_READERS: Record<
  string,
  (c: Contract, ctx: SnapshotContext) => Promise<StateSnapshot>
> = {
  OkuMoney: readOkuMoneyState,
  OkuDollar: readOkuDollarState,
  LitePSM: readLitePSMState,
};

// ============================================================================
// Diffing
// ============================================================================

export interface FieldDiff {
  field: string;
  before: string;
  after: string;
  /** Event that explains the change, if any (then it is not a failure). */
  explainedBy?: string;
}

/**
 * Diff the invariant fields of two snapshots. `emitted` is the set of event
 * names the contract emitted in (preBlock, postBlock]; a changed field whose
 * `explainedBy` intersects it is reported but marked explained.
 */
export function diffSnapshots(
  before: StateSnapshot,
  after: StateSnapshot,
  emitted: Set<string> = new Set()
): FieldDiff[] {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: FieldDiff[] = [];
  for (const field of fields) {
    const b = before[field];
    const a = after[field];
    if ((b?.kind ?? a?.kind) === "volatile") continue;
    const bv = b?.value ?? "<missing>";
    const av = a?.value ?? "<missing>";
    if (bv === av) continue;
    const reason = (b?.explainedBy ?? a?.explainedBy ?? []).find((e) => emitted.has(e));
    diffs.push({ field, before: bv, after: av, explainedBy: reason });
  }
  return diffs;
}

/** Plain `{field: value}` view, for records and proposal files. */
export function flatten(s: StateSnapshot): Record<string, string> {
  return Object.fromEntries(Object.entries(s).map(([k, f]) => [k, f.value]));
}

/** Inverse of {@link flatten}, re-attaching kinds from a fresh read's shape. */
export function unflatten(flat: Record<string, string>, shape: StateSnapshot): StateSnapshot {
  const out: StateSnapshot = {};
  for (const [k, v] of Object.entries(flat)) {
    out[k] = { value: v, kind: shape[k]?.kind ?? "invariant", explainedBy: shape[k]?.explainedBy };
  }
  return out;
}

// ============================================================================
// Post-upgrade invariants (evaluated at one block)
// ============================================================================

export interface InvariantContext {
  blockTag: number;
  timestamp: bigint;
  contracts: { OkuMoney?: Contract; OkuDollar?: Contract; LitePSM?: Contract };
}

/** Returns a list of violated invariants (empty = all hold). */
export async function checkInvariants(ctx: InvariantContext): Promise<string[]> {
  const o = { blockTag: ctx.blockTag };
  const bad: string[] = [];
  const { OkuMoney: m, OkuDollar: d, LitePSM: p } = ctx.contracts;

  if (m) {
    // The live multiplier must equal the closed form over the stored schedule —
    // catches an upgrade that changed the math or scrambled a schedule slot.
    const onChain: bigint = await m.okuMMultiplier(o);
    const expected = computeMultiplier(
      {
        baseMultiplier: await m.okuMBaseMultiplier(o),
        ratePerSecond: await m.okuMRatePerSecond(o),
        lastAccrualTime: await m.okuMLastAccrualTime(o),
        rateEnd: await m.okuMRateEnd(o),
        pendingRatePerSecond: await m.okuMPendingRatePerSecond(o),
        pendingRateEnd: await m.okuMPendingRateEnd(o),
      },
      ctx.timestamp
    );
    if (onChain !== expected) {
      bad.push(`OkuMoney.okuMMultiplier() = ${onChain}, schedule implies ${expected}`);
    }
    if ((await m.uiMultiplier(o)) !== onChain) bad.push("OkuMoney.uiMultiplier() != okuMMultiplier()");
  }
  if (d && m) {
    if ((await d.usdMultiplier(o)) !== (await m.okuMMultiplier(o))) {
      bad.push("OkuDollar.usdMultiplier() != OkuMoney.okuMMultiplier()");
    }
    if ((await d.totalOkuMReserves(o)) < (await d.totalUsdShares(o))) {
      bad.push("OkuDollar reserves < totalUsdShares (vault undercollateralised)");
    }
  }
  if (d) {
    if (String(await d.asset(o)).toLowerCase() !== String(await d.okuMoney(o)).toLowerCase()) {
      bad.push("OkuDollar.asset() != OkuDollar.okuMoney()");
    }
  }
  if (p && m) {
    const psm = await p.getAddress();
    if (!(await m.hasRole(ROLES.OKUM_MINTER, psm, o))) bad.push("LitePSM lost OKUM_MINTER");
    if (!(await m.hasRole(ROLES.OKUM_BURNER, psm, o))) bad.push("LitePSM lost OKUM_BURNER");
    if (String(await p.okuMoney(o)).toLowerCase() !== (await m.getAddress()).toLowerCase()) {
      bad.push("LitePSM.okuMoney() is not the OkuMoney proxy");
    }
  }
  if (p && d) {
    if (String(await p.okuDollar(o)).toLowerCase() !== (await d.getAddress()).toLowerCase()) {
      bad.push("LitePSM.okuDollar() is not the OkuDollar proxy");
    }
  }
  return bad;
}
