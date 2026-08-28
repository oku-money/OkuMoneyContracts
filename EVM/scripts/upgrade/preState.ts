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
// ============================================================================
// State readers - one per upgradeable proxy
//
// These snapshot the invariant-bearing state either side of an upgrade so a
// layout or logic regression shows up as a diff rather than as a silent
// production incident. Keep them cheap and side-effect free.
// ============================================================================

// OkuM
//
// `uiMultiplier()` is stepwise, so unlike a continuously-accruing index it does
// NOT drift between two reads - a diff here is a real change, not timing noise.
// `effectiveAt` and `epoch` are included because together they identify which
// mark the deployment is on, which is what cross-chain reconciliation compares.
export async function readOkuMState(c: Contract): Promise<StateSnapshot> {
  return {
    uiMultiplier: (await (c as any).uiMultiplier()).toString(),
    newUIMultiplier: (await (c as any).newUIMultiplier()).toString(),
    effectiveAt: (await (c as any).effectiveAt()).toString(),
    syncEpoch: (await (c as any).syncEpoch()).toString(),
    accrualHalted: String(await (c as any).accrualHalted()),
    totalSupply: (await (c as any).totalSupply()).toString(),
    maxSupply: (await (c as any).maxSupply()).toString(),
    asset: String(await (c as any).asset()),
    usdcDecimalMultiplier: (await (c as any).usdcDecimalMultiplier()).toString(),
    convertToAssets1e18: (await (c as any).convertToAssets(10n ** 18n)).toString(),
    paused: String(await (c as any).paused()),
  };
}

// USDOku
//
// `usdOkuIndex()` DOES accrue continuously while a rate segment is live, so it
// can legitimately differ between the pre and post snapshots. The rate config
// fields around it are the ones that must not move.
export async function readUSDOkuState(c: Contract): Promise<StateSnapshot> {
  return {
    usdOkuIndex: (await (c as any).usdOkuIndex()).toString(),
    usdBaseIndex: (await (c as any).usdBaseIndex()).toString(),
    usdRatePerSecond: (await (c as any).usdRatePerSecond()).toString(),
    usdLastAccrualTime: (await (c as any).usdLastAccrualTime()).toString(),
    usdRateEnd: (await (c as any).usdRateEnd()).toString(),
    accrualHalted: String(await (c as any).accrualHalted()),
    totalShares: (await (c as any).totalShares()).toString(),
    totalSupply: (await (c as any).totalSupply()).toString(),
    wrapper: String(await (c as any).wrapper()),
    paused: String(await (c as any).paused()),
  };
}

// USDOkuWrapper
//
// `backingCoversLiability` is the core solvency invariant. If an upgrade flips
// it from true to false, stop and investigate before doing anything else.
export async function readUSDOkuWrapperState(c: Contract): Promise<StateSnapshot> {
  return {
    okuM: String(await (c as any).okuM()),
    usdOku: String(await (c as any).usdOku()),
    wrapEnabled: String(await (c as any).wrapEnabled()),
    declaredLiability: (await (c as any).declaredLiability()).toString(),
    realizedBacking: (await (c as any).realizedBacking()).toString(),
    backingCoversLiability: String(await (c as any).backingCoversLiability()),
    backingRatioBps: (await (c as any).backingRatioBps()).toString(),
  };
}

// SubscriptionModule
//
// `nextRequestId` is the one field that MUST be preserved across an upgrade -
// resetting it would collide new requests with historical ones. Escrow totals
// must equal what they were, or user funds have moved.
export async function readSubscriptionModuleState(c: Contract): Promise<StateSnapshot> {
  return {
    okuM: String(await (c as any).okuM()),
    usdc: String(await (c as any).usdc()),
    treasury: String(await (c as any).treasury()),
    tinBps: (await (c as any).tinBps()).toString(),
    toutBps: (await (c as any).toutBps()).toString(),
    totalEscrowedUsdc: (await (c as any).totalEscrowedUsdc()).toString(),
    totalEscrowedOkuM: (await (c as any).totalEscrowedOkuM()).toString(),
    paused: String(await (c as any).paused()),
  };
}

export const STATE_READERS: Record<string, (c: Contract) => Promise<StateSnapshot>> = {
  OkuM: readOkuMState,
  USDOku: readUSDOkuState,
  USDOkuWrapper: readUSDOkuWrapperState,
  SubscriptionModule: readSubscriptionModuleState,
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
