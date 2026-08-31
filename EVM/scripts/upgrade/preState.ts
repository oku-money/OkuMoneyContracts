/**
 * Per-contract state readers for the generic upgrade script.
 *
 * Each reader returns a flat `Record<string, string>` of human-readable values
 * for fields whose post-upgrade values should be **identical** to their pre-upgrade
 * values (storage layout / configuration invariants). The upgrade script captures
 * a snapshot before calling upgradeProxy and compares against a fresh snapshot
 * after; any mismatch aborts the script with a non-zero exit code.
 *
 * Adding a new target:
 *   1. Add an entry to the UPGRADE_TARGETS table in ./index.ts.
 *   2. Add a `read<Name>State(contract)` function below.
 *   3. Re-export the function in the STATE_READERS map at the bottom.
 *
 * The readers are intentionally lightweight — only `view` calls, no state writes.
 * They never reach into private storage; all data comes from public getters that
 * already exist on the production contracts.
 */

import { Contract } from "ethers";

/** A flat dict of stringified field values, suitable for table printing & diffing. */
export type StateSnapshot = Record<string, string>;

// ============================================================================
// LitePSM
// ============================================================================
//
// Invariants exercised on upgrade:
//   - Wired addresses (okuM, usdc) preserved.
//   - usdcDecimalMultiplier preserved (resolved once at init from IERC20Metadata).
//   - Window state (mintEnabled, redeemEnabled) and pause state preserved.
//
// NOTE: there is no `redemptionQueue` or `usdOku` field on LitePSM — the PSM
// only ever wires okuM + usdc. USDOku is reached in two steps by callers
// (mintOkuM then wrap), never referenced from LitePSM itself.

export async function readLitePSMState(c: Contract): Promise<StateSnapshot> {
  const [okuM, usdc, usdcDecimalMultiplier, mintEnabled, redeemEnabled, paused] =
    await Promise.all([
      c.okuM(),
      c.usdc(),
      c.usdcDecimalMultiplier(),
      c.mintEnabled(),
      c.redeemEnabled(),
      c.paused(),
    ]);

  return {
    okuM: String(okuM),
    usdc: String(usdc),
    usdcDecimalMultiplier: usdcDecimalMultiplier.toString(),
    mintEnabled: String(mintEnabled),
    redeemEnabled: String(redeemEnabled),
    paused: String(paused),
  };
}

// ============================================================================
// USDOku (vault)
// ============================================================================
//
// Invariants exercised on upgrade:
//   - Wired okuM preserved.
//   - Share ledger total (totalShares) and rate-window bound (rateEnd) preserved.
//   - Pause and accrual-halt state preserved.
//
// We deliberately *do not* snapshot `usdOkuIndex()` (or `totalSupply()`, which is
// derived from it) because it is computed from (base, rate, elapsed) at read time
// — if rate > PRECISION it will drift between the pre- and post-snapshot reads
// even with zero storage change. `totalShares` is the underlying storage field
// that upgrade must not touch; the index computation is the same before and after
// as long as the segment fields (opaque behind `activeSegment()`/`pendingSegment()`
// on OkuM's ERC-8056 layer, not exposed as flat getters here) are untouched.

export async function readUSDOkuState(c: Contract): Promise<StateSnapshot> {
  const [okuM, totalShares, rateEnd, accrualHalted, paused] = await Promise.all([
    c.okuM(),
    c.totalShares(),
    c.rateEnd(),
    c.accrualHalted(),
    c.paused(),
  ]);

  return {
    okuM: String(okuM),
    totalShares: totalShares.toString(),
    rateEnd: rateEnd.toString(),
    accrualHalted: String(accrualHalted),
    paused: String(paused),
  };
}

// ============================================================================
// OkuM
// ============================================================================
//
// Invariants exercised on upgrade:
//   - ERC20 identity (name, symbol, decimals) preserved.
//   - Supply cap (maxSupply) and current totalSupply preserved.
//   - uiMultiplier — this is rebase-style derived state. Like
//     USDOku.usdOkuIndex(), it CAN drift between two reads when a non-zero
//     rate is being applied. We deliberately do NOT snapshot it; the underlying
//     storage fields are pinned indirectly via totalSupply + maxSupply.
//   - Pause state preserved.
//
// We do not snapshot DEFAULT_ADMIN_ROLE / OKUM_MINTER role grants here because
// OZ AccessControl's `hasRole` requires a target address — there's no
// "list all role holders" call. The deploy script's role configuration is
// orthogonal to an impl-only upgrade and would not be touched by it.

export async function readOkuMState(c: Contract): Promise<StateSnapshot> {
  const [name, symbol, decimals, maxSupply, totalSupply, paused] = await Promise.all([
    c.name(),
    c.symbol(),
    c.decimals(),
    c.maxSupply(),
    c.totalSupply(),
    c.paused(),
  ]);

  return {
    name: String(name),
    symbol: String(symbol),
    decimals: decimals.toString(),
    maxSupply: maxSupply.toString(),
    totalSupply: totalSupply.toString(),
    paused: String(paused),
  };
}

// ============================================================================
// Removed contracts
// ============================================================================
//
// State readers for RedemptionQueue, OkuBridge, and OkuBridgeRouter were removed
// — none exist in this design (see TRACKER.md and EVM/README.md "Deleted from
// the predecessor design"). If a live deployment still has one of those proxies
// on-chain and an upgrade is required, restore the reader from git history
// referencing the master-branch implementation.

// ============================================================================
// Registry
// ============================================================================

/**
 * Map of contract name -> state reader. The upgrade script dispatches through
 * this table; missing entries raise a clear "no smoke check registered" error
 * rather than silently skipping the diff.
 */
export const STATE_READERS: Record<string, (c: Contract) => Promise<StateSnapshot>> = {
  OkuM: readOkuMState,
  USDOku: readUSDOkuState,
  LitePSM: readLitePSMState,
};

/**
 * Compute the field-by-field diff between two snapshots.
 * Returns an array of `{ field, before, after }` for every key whose values differ.
 */
export function diffSnapshots(
  before: StateSnapshot,
  after: StateSnapshot
): Array<{ field: string; before: string; after: string }> {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs: Array<{ field: string; before: string; after: string }> = [];
  for (const field of fields) {
    const b = before[field] ?? "<missing>";
    const a = after[field] ?? "<missing>";
    if (b !== a) diffs.push({ field, before: b, after: a });
  }
  return diffs;
}
