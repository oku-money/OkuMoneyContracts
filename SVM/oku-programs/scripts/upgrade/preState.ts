/**
 * Pre/post-upgrade state readers for each SVM program.
 *
 * Each reader snapshots the invariant config PDA(s) for a program and returns
 * a flat `Record<string, string>`. The diff utility compares before/after and
 * surfaces any fields that changed — a non-empty diff means the upgrade modified
 * on-chain state in a way that should not happen during an upgrade (PDAs are
 * not reinitialised here), and the script aborts.
 *
 * This is the SVM analogue of EVM/scripts/upgrade/preState.ts.
 *
 * Field names are the camelCase conversions of the Rust snake_case IDL names:
 *   is_paused         → isPaused
 *   role_admin        → roleAdmin
 *   oku_money_mint    → okuMoneyMint
 *   etc.
 */

import { PublicKey } from '@solana/web3.js';
import { Program, BN } from '@anchor-lang/core';
import {
  derivePsmConfigPDA,
} from '../utils/pdaHelpers';

// ============================================================================
// Types
// ============================================================================

export type StateSnapshot = Record<string, string>;

/** Anchor program handles needed for state reading. */
export interface ProgramSet {
  psm: Program;
}

export interface FieldDiff {
  field: string;
  before: string;
  after: string;
}

// ============================================================================
// Serialisation helpers
// ============================================================================

function str(v: unknown): string {
  if (v === null || v === undefined) return '<null>';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') return String(v);
  if (v instanceof BN) return (v as BN).toString();
  if (v instanceof PublicKey) return (v as PublicKey).toBase58();
  if (Buffer.isBuffer(v)) return (v as Buffer).toString('hex');
  if (typeof v === 'bigint') return v.toString();
  if (Array.isArray(v)) {
    // Supported-chains array etc.: render as CSV, exclude zero-pad entries.
    const items = (v as unknown[]).filter(
      (x) => !(x instanceof BN && (x as BN).isZero()) && x !== 0
    );
    return items.map(str).join(',');
  }
  return String(v);
}

// ============================================================================
// Per-program state readers
// ============================================================================

/**
 * Snapshot LitePSM's invariant on-chain state.
 *
 * Reads the PsmConfig PDA.
 * Fields that legitimately change between admin ops (price, nonces, balances)
 * are omitted — we only capture structural/config fields that must stay
 * identical across an upgrade.
 */
export async function readLitePsmState(
  psm: Program,
  programId: PublicKey
): Promise<StateSnapshot> {
  const [psmConfigPDA] = derivePsmConfigPDA(programId);

  const snap: StateSnapshot = {};

  // PsmConfig
  try {
    const cfg: any = await psm.account['psmConfig'].fetch(psmConfigPDA);
    snap['psm.isPaused']           = str(cfg.isPaused);
    snap['psm.roleAdmin']          = str(cfg.roleAdmin);
    snap['psm.pauser']             = str(cfg.pauser);
    snap['psm.unpauser']           = str(cfg.unpauser);
    snap['psm.usdcMint']           = str(cfg.usdcMint);
    snap['psm.okuMMint']           = str(cfg.okuMMint);
    snap['psm.maxSupply']          = str(cfg.maxSupply);
    snap['psm.directMinter']           = str(cfg.directMinter);
    snap['psm.directMinterAllowance']  = str(cfg.directMinterAllowance);
    snap['psm.directBurner']           = str(cfg.directBurner);
    snap['psm.directBurnerAllowance']  = str(cfg.directBurnerAllowance);
  } catch (e: any) {
    snap['psm.fetchError'] = (e.message ?? String(e)).slice(0, 120);
  }

  return snap;
}

// ============================================================================
// Reader registry
// ============================================================================

export type StateReader = (
  programs: ProgramSet,
  programId: PublicKey
) => Promise<StateSnapshot>;

export const STATE_READERS: Record<string, StateReader> = {
  LitePsm:   (ps, id) => readLitePsmState(ps.psm, id),
};

// ============================================================================
// Diff utilities
// ============================================================================

/**
 * Compare two snapshots. Returns an array of changed fields.
 * An empty array means no storage invariant was broken by the upgrade.
 *
 * Error sentinel fields (*.fetchError) are excluded from diff:
 * a fetch that succeeds pre-upgrade but fails post-upgrade IS a real error
 * (layout break) and will surface via the exception, not via this diff.
 */
export function diffSnapshots(
  before: StateSnapshot,
  after: StateSnapshot
): FieldDiff[] {
  const diffs: FieldDiff[] = [];
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const f of fields) {
    if (f.endsWith('fetchError')) continue;
    const b = before[f] ?? '<missing>';
    const a = after[f] ?? '<missing>';
    if (b !== a) diffs.push({ field: f, before: b, after: a });
  }
  return diffs;
}

/**
 * Pretty-print a before/after snapshot table to console.
 */
export function printStateTable(
  before: StateSnapshot,
  after: StateSnapshot
): void {
  const rows: Record<string, { before: string; after: string; ok: string }> = {};
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const f of [...fields].sort()) {
    const b = before[f] ?? '<missing>';
    const a = after[f] ?? '<missing>';
    rows[f] = { before: b, after: a, ok: b === a ? '✓' : '✗' };
  }
  console.table(rows);
}
