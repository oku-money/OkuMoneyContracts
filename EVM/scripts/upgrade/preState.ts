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
 *
 * ---------------------------------------------------------------------------
 * THE ONE RULE FOR CHOOSING WHAT TO SNAPSHOT
 * ---------------------------------------------------------------------------
 *
 * A field belongs here iff it is a pure function of STORED state with no
 * `block.timestamp` term. Anything time-dependent legitimately differs between
 * the pre- and post-upgrade reads even with zero storage change, and would make
 * the diff a coin flip.
 *
 * That rule is what makes the two tokens asymmetric below, and the asymmetry is
 * the most useful thing on this page:
 *
 *   OkuM  — `M_oku` is STEPWISE. `uiMultiplier()` is a stored value, so it IS
 *           snapshotted, and so are `newUIMultiplier()` (equal to it, always)
 *           and `effectiveAt()`. Nothing about OkuM's index moves with the clock.
 *
 *   USDOku — `M_usd` is CONTINUOUS. `usdOkuIndex()` is computed from
 *           (baseIndex, ratePerSecond, elapsed) at read time, so it is
 *           deliberately NOT snapshotted. The four storage fields it derives
 *           from are, which is both stricter and stable.
 *
 * Getting this backwards in either direction produces a script that either
 * fails at random (snapshotting a live index) or silently passes through a
 * corrupted one (skipping a stored one).
 */

import { Contract } from "ethers";

/** A flat dict of stringified field values, suitable for table printing & diffing. */
export type StateSnapshot = Record<string, string>;

/** `type(IScaledUIAmount).interfaceId` — ERC-8056 core. */
const IID_SCALED_UI_CORE = "0xa60bf13d";

/** 1e18 — the probe amount for the ERC-4626 conversion view. */
const ONE_TOKEN = 10n ** 18n;

// ============================================================================
// OkuM — the share token
// ============================================================================
//
// Invariants exercised on upgrade:
//   - ERC-20 identity (name, symbol, decimals) preserved.
//   - The value-layer anchor (asset, usdcDecimalMultiplier) preserved. Resolved
//     once at init and the single source of truth the module and queue
//     cross-assert against; if either moved, pricing would silently diverge.
//   - The multiplier triple (uiMultiplier, newUIMultiplier, effectiveAt) and the
//     accrual-halt flag and sync-window config preserved. All stored, all
//     timestamp-free.
//   - `convertToAssets(1e18)` preserved — the ERC-4626 value layer. Included as
//     well as `uiMultiplier` because it exercises the multiplier AND the decimal
//     multiplier AND the flooring together: the two are related by
//     `cta * dm <= uiMultiplier < (cta + 1) * dm`, and an upgrade that broke the
//     conversion arithmetic while leaving both inputs intact would slip past a
//     check on the inputs alone.
//   - The fail-closed wiring (stepFeeSource) and the guardian flag
//     (accrualHalted) preserved. A silently-cleared stepFeeSource turns every
//     subsequent write; a silently-cleared accrualHalted
//     un-does an active incident response.
//   - Sync-window configuration preserved.
//   - Supply cap and current supply preserved.
//   - Pause state preserved.
//   - ERC-165 advertisement of ERC-8056 preserved. If an upgrade dropped this,
//     every wallet doing capability detection would silently fall back to raw
//     balances with no indication why — a UX regression with no on-chain symptom.
//
// `isSyncLocked` / `syncLockedUntil` are deliberately absent: the former is a
// `block.timestamp` comparison and the latter is a decaying deadline, so both
// can legitimately change across the two reads.

export async function readOkuMState(c: Contract): Promise<StateSnapshot> {
  const [
    name,
    symbol,
    decimals,
    asset,
    usdcDecimalMultiplier,
    uiMultiplier,
    newUIMultiplier,
    effectiveAt,
    convertToAssets,
    accrualHalted,
    syncWindowDuration,
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
    c.uiMultiplier(),
    c.newUIMultiplier(),
    c.effectiveAt(),
    c.convertToAssets(ONE_TOKEN),
    c.accrualHalted(),
    c.syncWindowDuration(),
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
    uiMultiplier: uiMultiplier.toString(),
    newUIMultiplier: newUIMultiplier.toString(),
    effectiveAt: effectiveAt.toString(),
    "convertToAssets(1e18)": convertToAssets.toString(),
    accrualHalted: String(accrualHalted),
    syncWindowDuration: syncWindowDuration.toString(),
    maxSupply: maxSupply.toString(),
    totalSupply: totalSupply.toString(),
    paused: String(paused),
    supportsScaledUi: String(supportsScaledUi),
  };
}

// ============================================================================
// USDOku — the rebasing dollar token
// ============================================================================
//
// Invariants exercised on upgrade:
//   - ERC-20 identity preserved.
//   - The full `M_usd` trajectory (baseIndex, ratePerSecond, lastAccrualTime,
//     rateEnd) preserved. These four are the stored anchor; `usdOkuIndex()` is
//     derived from them plus elapsed time and is therefore NOT snapshotted.
//   - `totalShares` preserved. THE invariant ledger quantity — `totalSupply()`
//     is derived from it, so pinning shares is what actually protects holders.
//     `totalSupply()` is not snapshotted for the same reason `usdOkuIndex()` is
//     not: it carries the time term.
//   - `solvencySource` preserved. A silently-cleared value makes every
//     subsequent `setUsdOkuRate` revert SolvencyGapExceeded once any liability
//     exists.
//   - Pause state preserved.
//   - ERC-165 NON-advertisement of ERC-8056 preserved, and this direction is
//     load-bearing: USDOku's `balanceOf` already returns dollars, so an upgrade
//     that started claiming 0xa60bf13d would make every 8056-aware wallet apply
//     a UI multiplier to an already-scaled balance and display the value squared.
//     The diff catches false -> true as readily as true -> false.

export async function readUSDOkuState(c: Contract): Promise<StateSnapshot> {
  const [
    name,
    symbol,
    decimals,
    baseIndex,
    ratePerSecond,
    lastAccrualTime,
    rateEnd,
    totalShares,
    solvencySource,
    paused,
    supportsScaledUi,
  ] = await Promise.all([
    c.name(),
    c.symbol(),
    c.decimals(),
    c.baseIndex(),
    c.ratePerSecond(),
    c.lastAccrualTime(),
    c.rateEnd(),
    c.totalShares(),
    c.solvencySource(),
    c.paused(),
    c.supportsInterface(IID_SCALED_UI_CORE),
  ]);

  return {
    name: String(name),
    symbol: String(symbol),
    decimals: decimals.toString(),
    baseIndex: baseIndex.toString(),
    ratePerSecond: ratePerSecond.toString(),
    lastAccrualTime: lastAccrualTime.toString(),
    rateEnd: rateEnd.toString(),
    totalShares: totalShares.toString(),
    solvencySource: String(solvencySource),
    paused: String(paused),
    // Must read "false". See the note above for why the false direction matters.
    supportsScaledUi: String(supportsScaledUi),
  };
}

// ============================================================================
// USDOkuWrapper
// ============================================================================
//
// Invariants exercised on upgrade:
//   - Wired token addresses (okuM, usdOku) preserved. If either moved, the
//     wrapper would convert against the wrong multiplier.
//   - `wrapEnabled` preserved — an upgrade that silently re-opened wrap would
//     undo a sunset, and one that closed it would halt subscription into the
//     dollar leg with no announcement.
//   - Pause state preserved.
//
// `declaredLiability`, `realizedBacking`, `solvencyGapBps` and
// `backingRatioBps` are ALL time-dependent, because liability derives from
// USDOku's continuously-accruing index. They are therefore recorded here for the
// operator's eye but not compared: an upgrade taking a few seconds moves the gap
// by a sub-basis-point amount that would fail an equality check every time.
//
// Instead of dropping them (which would leave the most important number in the
// system unobserved across an upgrade), `solvencyGapBps` is snapshotted with a
// COARSE key: the sign and order of magnitude, which is stable across seconds
// and still catches a genuine corruption.

export async function readUSDOkuWrapperState(c: Contract): Promise<StateSnapshot> {
  const [okuM, usdOku, wrapEnabled, paused, gapBps] = await Promise.all([
    c.okuM(),
    c.usdOku(),
    c.wrapEnabled(),
    c.paused(),
    c.solvencyGapBps(),
  ]);

  const gap = BigInt(gapBps);
  const gapBand =
    gap === 0n ? "zero" : gap < 0n ? "over-backed" : gap <= 100n ? "within-bound" : "BREACHED";

  return {
    okuM: String(okuM),
    usdOku: String(usdOku),
    wrapEnabled: String(wrapEnabled),
    paused: String(paused),
    solvencyGapBand: gapBand,
  };
}

// ============================================================================
// SubscriptionModule (formerly LitePSM)
// ============================================================================
//
// Invariants exercised on upgrade:
//   - Wired addresses (okuM, usdc, redemptionQueue) preserved.
//   - usdcDecimalMultiplier preserved (resolved once at init from IERC20Metadata
//     and cross-asserted against the token).
//   - The fee schedule (tin, tout) preserved. Not merely a config value now: it
//     IS the step-coverage budget, so an upgrade that reset it to zero would
//     silently make every future multiplier step impossible.
//   - Pause state preserved.

export async function readSubscriptionModuleState(c: Contract): Promise<StateSnapshot> {
  const [okuM, usdc, redemptionQueue, usdcDecimalMultiplier, tin, tout, paused] =
    await Promise.all([
      c.okuM(),
      c.usdc(),
      c.redemptionQueue(),
      c.usdcDecimalMultiplier(),
      c.tin(),
      c.tout(),
      c.paused(),
    ]);

  return {
    okuM: String(okuM),
    usdc: String(usdc),
    redemptionQueue: String(redemptionQueue),
    usdcDecimalMultiplier: usdcDecimalMultiplier.toString(),
    tin: tin.toString(),
    tout: tout.toString(),
    paused: String(paused),
  };
}

// ============================================================================
// RedemptionQueue
// ============================================================================
//
// Invariants exercised on upgrade:
//   - Wired addresses (okuM, usdc) preserved.
//   - usdcDecimalMultiplier preserved (cross-asserted against the token at init).
//   - Queue head/tail counters and totalQueuedRaw preserved: an impl upgrade
//     must not advance or reset the cursor, nor lose track of escrow.
//
// RedemptionQueue does NOT inherit PausableUpgradeable — pausing here would lock
// users into the queue, so pause lives one layer up on the module. No `paused()`
// field is snapshotted.
//
// `totalQueuedUsdc()` is deliberately absent: it values the escrow at the live
// `M_oku`, which is stable across an upgrade, but it is a derived figure whose
// inputs (`totalQueuedRaw` and the multiplier) are both already pinned — here
// and in the OkuM reader respectively.

export async function readRedemptionQueueState(c: Contract): Promise<StateSnapshot> {
  const [okuM, usdc, usdcDecimalMultiplier, queueHead, queueTail, totalQueuedRaw] =
    await Promise.all([
      c.okuM(),
      c.usdc(),
      c.usdcDecimalMultiplier(),
      c.queueHead(),
      c.queueTail(),
      c.totalQueuedRaw(),
    ]);

  return {
    okuM: String(okuM),
    usdc: String(usdc),
    usdcDecimalMultiplier: usdcDecimalMultiplier.toString(),
    queueHead: queueHead.toString(),
    queueTail: queueTail.toString(),
    totalQueuedRaw: totalQueuedRaw.toString(),
  };
}

// ============================================================================
// Registry
// ============================================================================

/**
 * Map of contract name -> state reader. The upgrade script dispatches through
 * this table; missing entries raise a clear "no state reader registered" error
 * rather than silently skipping the diff.
 */
export const STATE_READERS: Record<string, (c: Contract) => Promise<StateSnapshot>> = {
  OkuM: readOkuMState,
  USDOku: readUSDOkuState,
  USDOkuWrapper: readUSDOkuWrapperState,
  SubscriptionModule: readSubscriptionModuleState,
  RedemptionQueue: readRedemptionQueueState,
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
