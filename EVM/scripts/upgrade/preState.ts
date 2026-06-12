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
//   - OracleRelay wire (oracleRelay) preserved — the relay itself is a separate
//     proxy with its own state; only the consumer's pointer is captured here.
//   - usdcDecimalMultiplier preserved (resolved once at init from IERC20Metadata).
//   - Pause state preserved.

export async function readLitePSMState(c: Contract): Promise<StateSnapshot> {
  const [
    okuMoney,
    okuDollar,
    usdc,
    redemptionQueue,
    oracleRelay,
    usdcDecimalMultiplier,
    paused,
  ] = await Promise.all([
    c.okuMoney(),
    c.okuDollar(),
    c.usdc(),
    c.redemptionQueue(),
    c.oracleRelay(),
    c.usdcDecimalMultiplier(),
    c.paused(),
  ]);

  return {
    okuMoney: String(okuMoney),
    okuDollar: String(okuDollar),
    usdc: String(usdc),
    redemptionQueue: String(redemptionQueue),
    oracleRelay: String(oracleRelay),
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
//   - Rate-and-share storage (usdBaseMultiplier, usdRatePerSecond, usdLastAccrualTime,
//     usdRateEnd, usdPendingRatePerSecond, totalUsdShares, minCollateralRatio) preserved.
//   - Pause state preserved.
//
// We deliberately *do not* snapshot `usdMultiplier()` because it is computed from
// (base, rate, elapsed) at read time — if rate > PRECISION it will drift between
// the pre- and post-snapshot reads even with zero storage change. The underlying
// storage fields above are the right things to pin.

export async function readOkuDollarState(c: Contract): Promise<StateSnapshot> {
  const [
    okuMoney,
    usdBaseMultiplier,
    usdRatePerSecond,
    usdLastAccrualTime,
    usdRateEnd,
    usdPendingRatePerSecond,
    totalUsdShares,
    minCollateralRatio,
    paused,
  ] = await Promise.all([
    c.okuMoney(),
    c.usdBaseMultiplier(),
    c.usdRatePerSecond(),
    c.usdLastAccrualTime(),
    c.usdRateEnd(),
    c.usdPendingRatePerSecond(),
    c.totalUsdShares(),
    c.minCollateralRatio(),
    c.paused(),
  ]);

  return {
    okuMoney: String(okuMoney),
    usdBaseMultiplier: usdBaseMultiplier.toString(),
    usdRatePerSecond: usdRatePerSecond.toString(),
    usdLastAccrualTime: usdLastAccrualTime.toString(),
    usdRateEnd: usdRateEnd.toString(),
    usdPendingRatePerSecond: usdPendingRatePerSecond.toString(),
    totalUsdShares: totalUsdShares.toString(),
    minCollateralRatio: minCollateralRatio.toString(),
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
//   - okuMMultiplier — this is rebase-style derived state. Like
//     OkuDollar.usdMultiplier(), it CAN drift between two reads when a non-zero
//     rate is being applied. We deliberately do NOT snapshot it; the underlying
//     storage fields are pinned indirectly via totalSupply + maxSupply.
//   - Pause state preserved.
//
// We do not snapshot DEFAULT_ADMIN_ROLE / OKUM_MINTER role grants here because
// OZ AccessControl's `hasRole` requires a target address — there's no
// "list all role holders" call. The deploy script's role configuration is
// orthogonal to an impl-only upgrade and would not be touched by it.

export async function readOkuMoneyState(c: Contract): Promise<StateSnapshot> {
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
// OkuBridge / OkuBridgeRouter
// ============================================================================
//
// State readers for OkuBridge and OkuBridgeRouter were removed in the noBridge
// refactor. If a live deployment still has those proxies on-chain and an
// upgrade is required, re-add the readers (and the corresponding STATE_READERS
// entries) referencing the master-branch implementations.

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
