/**
 * Pre/post-upgrade state for the SVM upgrade script, and the pre-deploy
 * account-layout gate.
 *
 * A BPF upgrade swaps code, not data, so account bytes can only change through
 * transactions that land while the upgrade is in flight — legitimate by
 * definition. What CAN go wrong is the new code reading the same bytes
 * differently; `assertConfigCompatible` checks that before anything is
 * uploaded. The snapshots then classify every field:
 *
 *   invariant  wiring no instruction can change (mints, vault, bump, the
 *              config PDA's mint/freeze/extension authorities, account size
 *              and discriminator). Any change fails the run.
 *   config     admin-settable (authorities, caps, pause, rate schedule). A
 *              change is reported as a warning: an admin tx landed meanwhile.
 *   volatile   moves with user traffic (allowances, supply, vault balance,
 *              display mirror). Shown, never diffed.
 *
 * Field names are the camelCase IDL names (`is_paused` -> `isPaused`).
 */

import { Connection, PublicKey } from '@solana/web3.js';
import { BN, BorshAccountsCoder, convertIdlToCamelCase } from '@anchor-lang/core';
import {
  TOKEN_2022_PROGRAM_ID,
  getAccount,
  getMint,
  getMetadataPointerState,
  getScaledUiAmountConfig,
  getTokenMetadata,
} from '@solana/spl-token';
import { computeMultiplier, scheduleFromConfig } from '@okumoney/yield-tooling';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { PSM_CONFIG_LEN } from '../lib/account-sizes';

export type FieldKind = 'invariant' | 'config' | 'volatile';
export interface Field {
  value: string;
  kind: FieldKind;
}
export type StateSnapshot = Record<string, Field>;

export interface FieldDiff {
  field: string;
  kind: FieldKind;
  before: string;
  after: string;
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '<none>';
  if (v instanceof BN) return v.toString();
  if (v instanceof PublicKey) return v.toBase58();
  if (typeof v === 'bigint') return v.toString();
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.from(v).toString('hex');
  if (Array.isArray(v)) return Buffer.from(v as number[]).toString('hex');
  return String(v);
}

const AUTHORITY_FIELDS = [
  'roleAdmin', 'pendingRoleAdmin', 'pauser', 'unpauser', 'freezer', 'unfreezer',
  'bufferDepositor', 'bufferWithdrawer', 'capManager', 'allowanceManager', 'rateManager',
  'directMinter', 'directBurner',
];
const SCHEDULE_FIELDS = [
  'okumBaseMultiplier', 'okumRatePerSecond', 'okumLastAccrualTime', 'okumRateEnd',
  'okumPendingRatePerSecond', 'okumPendingRateEnd',
];

/** Decode PsmConfig with camelCase field names (the raw IDL is snake_case). */
export function decodePsmConfig(idl: any, data: Buffer): any {
  return new BorshAccountsCoder(convertIdlToCamelCase(idl)).decode('psmConfig', data);
}

export function psmConfigDiscriminator(idl: any): Buffer {
  const acc = (idl.accounts ?? []).find((a: any) => a.name === 'PsmConfig');
  if (!acc) throw new Error('IDL has no PsmConfig account');
  return Buffer.from(acc.discriminator);
}

/**
 * Pre-deploy gate: the live PsmConfig must be what the NEW code expects —
 * owned by the program, exactly `PSM_CONFIG_LEN` bytes, the IDL's
 * discriminator — and decoding it with the new IDL must give the same value
 * for every field the deployed IDL (`baselineIdl`) knew about.
 */
export async function assertConfigCompatible(
  connection: Connection,
  programId: PublicKey,
  baselineIdl: any,
  newIdl: any
): Promise<void> {
  const [pda] = derivePsmConfigPDA(programId);
  const info = await connection.getAccountInfo(pda, 'confirmed');
  if (!info) throw new Error(`PsmConfig ${pda.toBase58()} does not exist (program not initialized?)`);
  if (!info.owner.equals(programId)) throw new Error(`PsmConfig owner is ${info.owner.toBase58()}, not the program`);
  if (info.data.length !== PSM_CONFIG_LEN) {
    throw new Error(`PsmConfig is ${info.data.length} bytes; the new code expects ${PSM_CONFIG_LEN}`);
  }
  const disc = psmConfigDiscriminator(newIdl);
  if (!info.data.subarray(0, 8).equals(disc)) throw new Error(`PsmConfig discriminator differs from the new IDL`);
  const before = decodePsmConfig(baselineIdl, info.data);
  const after = decodePsmConfig(newIdl, info.data);
  const changed = Object.keys(before).filter((k) => !/reserved/i.test(k) && str(before[k]) !== str(after[k]));
  if (changed.length) {
    throw new Error(`The new IDL decodes the live PsmConfig differently: ${changed.join(', ')}`);
  }
}

/** Snapshot of the PSM and the OkuM mint it controls. `idl` must be the NEW IDL. */
export async function readLitePsmState(
  connection: Connection,
  idl: any,
  programId: PublicKey
): Promise<StateSnapshot> {
  const s: StateSnapshot = {};
  const put = (k: string, v: unknown, kind: FieldKind) => (s[k] = { value: str(v), kind });

  const [pda, bump] = derivePsmConfigPDA(programId);
  const info = await connection.getAccountInfo(pda, 'confirmed');
  if (!info) throw new Error(`PsmConfig ${pda.toBase58()} not found`);
  put('config.owner', info.owner, 'invariant');
  put('config.len', info.data.length, 'invariant');
  put('config.discriminator', info.data.subarray(0, 8), 'invariant');

  const cfg: any = decodePsmConfig(idl, info.data);
  put('config.address', pda, 'invariant');
  put('bump', cfg.bump, 'invariant');
  put('bumpIsCanonical', cfg.bump === bump, 'invariant');
  put('usdcMint', cfg.usdcMint, 'invariant');
  put('okuMMint', cfg.okuMMint, 'invariant');
  put('vaultUsdc', cfg.vaultUsdc, 'invariant');
  put('reservedIsZero', Buffer.from(cfg.reserved).every((b: number) => b === 0), 'invariant');
  for (const f of AUTHORITY_FIELDS) put(f, cfg[f], 'config');
  put('isPaused', cfg.isPaused, 'config');
  put('maxSupply', cfg.maxSupply, 'config');
  for (const f of SCHEDULE_FIELDS) put(f, cfg[f], 'config');
  put('minterAllowance', cfg.minterAllowance, 'volatile');
  put('directMinterAllowance', cfg.directMinterAllowance, 'volatile');
  put('directBurnerAllowance', cfg.directBurnerAllowance, 'volatile');
  put('lastOverrideSlot', cfg.lastOverrideSlot, 'volatile');
  put('lastDisplaySyncTs', cfg.lastDisplaySyncTs, 'volatile');

  // OkuM mint: the config PDA must hold every authority on it.
  const mint = await getMint(connection, cfg.okuMMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  put('mint.decimals', mint.decimals, 'invariant');
  put('mint.mintAuthority', mint.mintAuthority, 'invariant');
  put('mint.freezeAuthority', mint.freezeAuthority, 'invariant');
  put('mint.supply', mint.supply, 'volatile');
  const scaled = getScaledUiAmountConfig(mint);
  put('mint.scaledUi.authority', scaled?.authority, 'invariant');
  put('mint.scaledUi.multiplier', scaled?.multiplier, 'volatile');
  put('mint.scaledUi.newMultiplier', scaled?.newMultiplier, 'volatile');
  put('mint.scaledUi.effectiveTimestamp', scaled?.newMultiplierEffectiveTimestamp, 'volatile');
  const pointer = getMetadataPointerState(mint);
  put('mint.metadataPointer.authority', pointer?.authority, 'invariant');
  put('mint.metadataPointer.address', pointer?.metadataAddress, 'invariant');
  const meta = await getTokenMetadata(connection, cfg.okuMMint, 'confirmed', TOKEN_2022_PROGRAM_ID);
  put('mint.metadata.updateAuthority', meta?.updateAuthority, 'invariant');
  put('mint.metadata.name', meta?.name, 'config');
  put('mint.metadata.symbol', meta?.symbol, 'config');
  put('mint.metadata.uri', meta?.uri, 'config');

  // USDC vault: owned by the config PDA, of the configured mint.
  const vaultInfo = await connection.getAccountInfo(cfg.vaultUsdc, 'confirmed');
  if (!vaultInfo) throw new Error(`vault ${cfg.vaultUsdc.toBase58()} not found`);
  const vault = await getAccount(connection, cfg.vaultUsdc, 'confirmed', vaultInfo.owner);
  put('vault.owner', vault.owner, 'invariant');
  put('vault.mint', vault.mint, 'invariant');
  put('vault.amount', vault.amount, 'volatile');

  return s;
}

/** Changed non-volatile fields. */
export function diffSnapshots(before: StateSnapshot, after: StateSnapshot): FieldDiff[] {
  const out: FieldDiff[] = [];
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const kind = before[k]?.kind ?? after[k]?.kind ?? 'invariant';
    if (kind === 'volatile') continue;
    const b = before[k]?.value ?? '<missing>';
    const a = after[k]?.value ?? '<missing>';
    if (a !== b) out.push({ field: k, kind, before: b, after: a });
  }
  return out;
}

/**
 * Post-upgrade invariants: the stored schedule still evaluates to a canonical
 * multiplier >= 1e18 at the cluster's time, and the config PDA still holds the
 * mint, freeze and ScaledUiAmount authorities and owns the USDC vault.
 */
export function checkInvariants(s: StateSnapshot, nowTs: bigint): string[] {
  const bad: string[] = [];
  const cfg: any = {};
  for (const f of SCHEDULE_FIELDS) cfg[f] = s[f]?.value;
  let canonical: bigint;
  try {
    canonical = computeMultiplier(scheduleFromConfig(cfg), nowTs);
  } catch (e: any) {
    return [`stored schedule does not evaluate: ${e?.message ?? e}`];
  }
  if (canonical < 10n ** 18n) bad.push(`canonical multiplier ${canonical} < 1e18`);
  // The config PDA must control the mint and own the vault.
  const pda = s['config.address']?.value;
  for (const k of ['mint.mintAuthority', 'mint.freezeAuthority', 'mint.scaledUi.authority', 'vault.owner']) {
    if (s[k]?.value !== pda) bad.push(`${k} is ${s[k]?.value}, not the config PDA ${pda}`);
  }
  return bad;
}

export function printStateTable(before: StateSnapshot, after: StateSnapshot): void {
  const rows: Record<string, { kind: string; before: string; after: string; ok: string }> = {};
  for (const k of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = before[k]?.value ?? '<missing>';
    const a = after[k]?.value ?? '<missing>';
    const kind = before[k]?.kind ?? after[k]?.kind ?? '';
    rows[k] = { kind, before: b.slice(0, 48), after: a.slice(0, 48), ok: a === b ? '✓' : kind === 'volatile' ? '~' : '✗' };
  }
  console.table(rows);
}

export function flatten(s: StateSnapshot): Record<string, string> {
  return Object.fromEntries(Object.entries(s).map(([k, f]) => [k, f.value]));
}

export function unflatten(flat: Record<string, string>, shape: StateSnapshot): StateSnapshot {
  return Object.fromEntries(
    Object.entries(flat).map(([k, v]) => [k, { value: v, kind: shape[k]?.kind ?? 'invariant' }])
  );
}
