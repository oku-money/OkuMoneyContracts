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
  const [
    okuMoney,
    okuDollar,
    usdc,
    redemptionQueue,
    usdcDecimalMultiplier,
    paused,
  ] = await Promise.all([
    c.okuMoney(),
    c.okuDollar(),
    c.usdc(),
    c.redemptionQueue(),
    c.usdcDecimalMultiplier(),
    c.paused(),
  ]);

  return {
    okuMoney: String(okuMoney),
    okuDollar: String(okuDollar),
    usdc: String(usdc),
    redemptionQueue: String(redemptionQueue),
    usdcDecimalMultiplier: usdcDecimalMultiplier.toString(),
    paused: String(paused),
  };
}

// ============================================================================
// OkuDollar (vault)
// ============================================================================
//
// Invariants exercised on upgrade:
//   - Wired okuMoney preserved.
//   - Share accounting (totalUsdShares) preserved.
//   - Pause state preserved.
//
// The vault owns no rate schedule under the single-multiplier design; the
// schedule is snapshotted on OkuMoney instead (see readOkuMoneyState).
//
// We deliberately *do not* snapshot `usdMultiplier()` because it forwards to
// `okuMoney.okuMMultiplier()`, which is computed from (base, rate, elapsed) at read
// time — if rate > PRECISION it drifts between the pre- and post-snapshot reads even
// with zero storage change. The OkuMoney storage fields are the right things to pin.

export async function readOkuDollarState(c: Contract): Promise<StateSnapshot> {
  const [okuMoney, totalUsdShares, paused] = await Promise.all([
    c.okuMoney(),
    c.totalUsdShares(),
    c.paused(),
  ]);

  return {
    okuMoney: String(okuMoney),
    totalUsdShares: totalUsdShares.toString(),
    paused: String(paused),
  };
}

// ============================================================================
// OkuMoney
// ============================================================================
//
// Invariants exercised on upgrade:
//   - ERC20 identity (name, symbol, decimals) preserved.
//   - Supply cap (maxSupply) and current totalSupply preserved.
//   - Yield-schedule storage (okuMBaseMultiplier, okuMRatePerSecond,
//     okuMLastAccrualTime, okuMRateEnd, okuMPendingRatePerSecond) preserved.
//     This is the ONLY rate schedule in the system — OkuDollar derives from it
//     — so an upgrade that scrambled it would silently reprice both tokens on
//     every chain. Plain storage reads, stable across two reads absent a
//     setOkuMYieldRate call.
//   - okuMMultiplier is derived state and CAN drift between two reads under a
//     non-zero rate, so it is deliberately NOT snapshotted; the five schedule
//     fields above are the right things to pin.
//   - Pause state preserved.
//
// Role grants are not snapshotted: OZ AccessControl's `hasRole` requires a
// target address and there is no "list all role holders" call. Role
// configuration is orthogonal to an impl-only upgrade.

export async function readOkuMoneyState(c: Contract): Promise<StateSnapshot> {
  const [
    name,
    symbol,
    decimals,
    maxSupply,
    totalSupply,
    okuMBaseMultiplier,
    okuMRatePerSecond,
    okuMLastAccrualTime,
    okuMRateEnd,
    okuMPendingRatePerSecond,
    paused,
  ] = await Promise.all([
    c.name(),
    c.symbol(),
    c.decimals(),
    c.maxSupply(),
    c.totalSupply(),
    c.okuMBaseMultiplier(),
    c.okuMRatePerSecond(),
    c.okuMLastAccrualTime(),
    c.okuMRateEnd(),
    c.okuMPendingRatePerSecond(),
    c.paused(),
  ]);

  return {
    name: String(name),
    symbol: String(symbol),
    decimals: decimals.toString(),
    maxSupply: maxSupply.toString(),
    totalSupply: totalSupply.toString(),
    okuMBaseMultiplier: okuMBaseMultiplier.toString(),
    okuMRatePerSecond: okuMRatePerSecond.toString(),
    okuMLastAccrualTime: okuMLastAccrualTime.toString(),
    okuMRateEnd: okuMRateEnd.toString(),
    okuMPendingRatePerSecond: okuMPendingRatePerSecond.toString(),
    paused: String(paused),
  };
}

// ============================================================================
// RedemptionQueue
// ============================================================================
//
// Invariants exercised on upgrade:
//   - Wired addresses (okuMoney, usdc) preserved.
//   - usdcDecimalMultiplier preserved (resolved once at init from IERC20Metadata).
//   - Queue head/tail counters and totalQueuedOkuM preserved (an impl upgrade
//     must not advance or reset the queue cursor).
//
// RedemptionQueue does NOT inherit PausableUpgradeable — confirmed against
// src/psm/RedemptionQueue.sol. No paused() field is snapshotted.

export async function readRedemptionQueueState(c: Contract): Promise<StateSnapshot> {
  const [okuMoney, usdc, usdcDecimalMultiplier, queueHead, queueTail, totalQueuedOkuM] =
    await Promise.all([
      c.okuMoney(),
      c.usdc(),
      c.usdcDecimalMultiplier(),
      c.queueHead(),
      c.queueTail(),
      c.totalQueuedOkuM(),
    ]);

  return {
    okuMoney: String(okuMoney),
    usdc: String(usdc),
    usdcDecimalMultiplier: usdcDecimalMultiplier.toString(),
    queueHead: queueHead.toString(),
    queueTail: queueTail.toString(),
    totalQueuedOkuM: totalQueuedOkuM.toString(),
  };
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Map of contract name -> state reader. The upgrade script dispatches through
 * this table; missing entries raise a clear "no smoke check registered" error
 * rather than silently skipping the diff.
 */
export const STATE_READERS: Record<string, (c: Contract) => Promise<StateSnapshot>> = {
  OkuMoney: readOkuMoneyState,
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
