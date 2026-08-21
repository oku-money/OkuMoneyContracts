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
//   - Wired addresses (okuMoney, okuDollar, usdc, redemptionQueue) preserved.
//   - usdcDecimalMultiplier preserved (resolved once at init from IERC20Metadata).
//   - Pause state preserved.

export async function readLitePSMState(c: Contract): Promise<StateSnapshot> {
  const [okuDollar, usdc, redemptionQueue, usdcDecimalMultiplier, paused] =
    await Promise.all([
      c.okuDollar(),
      c.usdc(),
      c.redemptionQueue(),
      c.usdcDecimalMultiplier(),
      c.paused(),
    ]);

  return {
    okuDollar: String(okuDollar),
    usdc: String(usdc),
    redemptionQueue: String(redemptionQueue),
    usdcDecimalMultiplier: usdcDecimalMultiplier.toString(),
    paused: String(paused),
  };
}

// ============================================================================
// OkuDollar (rUSDOku) — the token
// ============================================================================
//
// Invariants exercised on upgrade:
//   - ERC-20 identity (name, symbol, decimals) preserved.
//   - The value-layer anchor (asset, usdcDecimalMultiplier) preserved. These are
//     resolved once at init and are the single source of truth the PSM and queue
//     cross-assert against; if either moved, pricing would silently diverge.
//   - The full multiplier trajectory (baseMultiplier, ratePerSecond,
//     lastAccrualTime, rateEnd) preserved.
//   - Supply cap and current supply preserved.
//   - Pause state preserved.
//   - ERC-165 advertisement of ERC-8056 preserved. If an upgrade dropped this,
//     every wallet doing capability detection would silently fall back to raw
//     balances with no indication why — a UX regression with no on-chain symptom.
//
// We deliberately do NOT snapshot `uiMultiplier()` itself: it is computed from
// (baseMultiplier, ratePerSecond, elapsed) at read time, so with a live rate it
// legitimately differs between the pre- and post-upgrade reads even with zero
// storage change. Pinning the four storage fields is both stricter and stable.
//
// `newUIMultiplier()` IS snapshotted: it is a pure function of stored state with
// no `block.timestamp` term, so it must be bit-identical across an impl swap.

const IID_SCALED_UI_CORE = "0xa60bf13d";

export async function readOkuDollarState(c: Contract): Promise<StateSnapshot> {
  const [
    name,
    symbol,
    decimals,
    asset,
    usdcDecimalMultiplier,
    baseMultiplier,
    ratePerSecond,
    lastAccrualTime,
    rateEnd,
    newUIMultiplier,
    maxSupply,
    totalSupply,
    paused,
    supportsScaledUi,
  ] = await Promise.all([
    c.name(),
    c.symbol(),
    c.decimals(),
    c.asset(),
    c.usdcDecimalMultiplier(),
    c.baseMultiplier(),
    c.ratePerSecond(),
    c.lastAccrualTime(),
    c.rateEnd(),
    c.newUIMultiplier(),
    c.maxSupply(),
    c.totalSupply(),
    c.paused(),
    c.supportsInterface(IID_SCALED_UI_CORE),
  ]);

  return {
    name: String(name),
    symbol: String(symbol),
    decimals: decimals.toString(),
    asset: String(asset),
    usdcDecimalMultiplier: usdcDecimalMultiplier.toString(),
    baseMultiplier: baseMultiplier.toString(),
    ratePerSecond: ratePerSecond.toString(),
    lastAccrualTime: lastAccrualTime.toString(),
    rateEnd: rateEnd.toString(),
    newUIMultiplier: newUIMultiplier.toString(),
    maxSupply: maxSupply.toString(),
    totalSupply: totalSupply.toString(),
    paused: String(paused),
    supportsScaledUi: String(supportsScaledUi),
  };
}

// ============================================================================
// RedemptionQueue
// ============================================================================
//
// Invariants exercised on upgrade:
//   - Wired addresses (okuDollar, usdc) preserved.
//   - usdcDecimalMultiplier preserved (cross-asserted against the token at init).
//   - Queue head/tail counters and totalQueuedRaw preserved (an impl upgrade must
//     not advance or reset the queue cursor, nor lose track of escrow).
//
// RedemptionQueue does NOT inherit PausableUpgradeable — confirmed against
// src/psm/RedemptionQueue.sol. No paused() field is snapshotted.

export async function readRedemptionQueueState(c: Contract): Promise<StateSnapshot> {
  const [okuDollar, usdc, usdcDecimalMultiplier, queueHead, queueTail, totalQueuedRaw] =
    await Promise.all([
      c.okuDollar(),
      c.usdc(),
      c.usdcDecimalMultiplier(),
      c.queueHead(),
      c.queueTail(),
      c.totalQueuedRaw(),
    ]);

  return {
    okuDollar: String(okuDollar),
    usdc: String(usdc),
    usdcDecimalMultiplier: usdcDecimalMultiplier.toString(),
    queueHead: queueHead.toString(),
    queueTail: queueTail.toString(),
    totalQueuedRaw: totalQueuedRaw.toString(),
  };
}

// ============================================================================
// OkuBridge / OkuBridgeRouter
// ============================================================================
// Registry
// ============================================================================

/**
 * Map of contract name -> state reader. The upgrade script dispatches through
 * this table; missing entries raise a clear "no smoke check registered" error
 * rather than silently skipping the diff.
 */
export const STATE_READERS: Record<string, (c: Contract) => Promise<StateSnapshot>> = {
  OkuDollar: readOkuDollarState,
  RedemptionQueue: readRedemptionQueueState,
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
