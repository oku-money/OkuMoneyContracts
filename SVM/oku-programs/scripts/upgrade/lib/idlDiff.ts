/**
 * IDL comparison between the deployed program (baseline) and the build about
 * to be uploaded.
 *
 * Two severities:
 *   layoutBreaks   existing accounts would deserialize differently under the
 *                  new code: a field moved, changed type or size, an account's
 *                  discriminator or total size changed, an account type was
 *                  removed. The upgrade is refused.
 *   clientChanges  instructions / args / accounts / errors changed: existing
 *                  state is fine but off-chain clients built from the old IDL
 *                  may break. Requires explicit acceptance.
 *
 * Layout is compared by BYTE OFFSET, not by field name: Borsh is positional, so
 * a reorder is a break even when every name still exists. The supported
 * evolution (state.rs) is to consume `reserved` from the front with the
 * account's size held constant; that passes, because every old field keeps its
 * offset and type and only the tail `reserved` array shrinks.
 */

type IdlType = any;

export interface FieldLayout {
  name: string;
  type: string;
  offset: number;
  size: number;
}

const PRIMITIVE: Record<string, number> = {
  bool: 1, u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4,
  u64: 8, i64: 8, f64: 8, u128: 16, i128: 16, pubkey: 32, publicKey: 32,
};

/** Byte size of a fixed-size IDL type, or null if variable (Vec, String, Option, ...). */
export function typeSize(t: IdlType, types: any[]): number | null {
  if (typeof t === 'string') return PRIMITIVE[t] ?? null;
  if (t?.array) {
    const [inner, len] = t.array;
    const s = typeSize(inner, types);
    return s === null || typeof len !== 'number' ? null : s * len;
  }
  if (t?.defined) {
    const name = typeof t.defined === 'string' ? t.defined : t.defined.name;
    const def = types.find((d) => d.name === name);
    if (!def || def.type?.kind !== 'struct') return null;
    let total = 0;
    for (const f of def.type.fields ?? []) {
      const s = typeSize(f.type, types);
      if (s === null) return null;
      total += s;
    }
    return total;
  }
  return null;
}

/** Positional layout of an account struct; null if any field is variable-size. */
export function accountLayout(idl: any, name: string): FieldLayout[] | null {
  const def = (idl.types ?? []).find((t: any) => t.name === name);
  if (!def || def.type?.kind !== 'struct') return null;
  let offset = 8; // discriminator
  const out: FieldLayout[] = [];
  for (const f of def.type.fields ?? []) {
    const size = typeSize(f.type, idl.types ?? []);
    if (size === null) return null;
    out.push({ name: f.name, type: JSON.stringify(f.type), offset, size });
    offset += size;
  }
  return out;
}

const isReserved = (f: FieldLayout) => /^(reserved|_reserved|padding)/i.test(f.name);

export interface IdlDiff {
  layoutBreaks: string[];
  clientChanges: string[];
}

/** Compare the deployed IDL with the new one; see the module header for the two severities. */
export function diffIdl(baseline: any, current: any): IdlDiff {
  const layoutBreaks: string[] = [];
  const clientChanges: string[] = [];

  // ---- accounts: discriminator + positional layout ----
  for (const acc of baseline.accounts ?? []) {
    const now = (current.accounts ?? []).find((a: any) => a.name === acc.name);
    if (!now) {
      layoutBreaks.push(`account ${acc.name} removed`);
      continue;
    }
    if (JSON.stringify(now.discriminator) !== JSON.stringify(acc.discriminator)) {
      layoutBreaks.push(`account ${acc.name}: discriminator changed`);
    }
    const before = accountLayout(baseline, acc.name);
    const after = accountLayout(current, acc.name);
    if (!before || !after) {
      // Variable-size: fall back to exact ordered field equality.
      const b = JSON.stringify((baseline.types ?? []).find((t: any) => t.name === acc.name));
      const a = JSON.stringify((current.types ?? []).find((t: any) => t.name === acc.name));
      if (a !== b) layoutBreaks.push(`account ${acc.name}: variable-size layout changed`);
      continue;
    }
    const sizeOf = (l: FieldLayout[]) => l.reduce((n, f) => n + f.size, 8);
    if (sizeOf(before) !== sizeOf(after)) {
      layoutBreaks.push(`account ${acc.name}: size ${sizeOf(before)} -> ${sizeOf(after)} (no realloc path)`);
    }
    for (const f of before) {
      if (isReserved(f)) continue;
      const g = after.find((x) => x.offset === f.offset && x.name === f.name);
      if (!g) {
        const moved = after.find((x) => x.name === f.name);
        layoutBreaks.push(
          moved
            ? `account ${acc.name}.${f.name}: offset ${f.offset} -> ${moved.offset}`
            : `account ${acc.name}.${f.name} (offset ${f.offset}) removed`
        );
      } else if (g.type !== f.type) {
        layoutBreaks.push(`account ${acc.name}.${f.name}: type ${f.type} -> ${g.type}`);
      }
    }
    // New fields must come out of the old reserved region.
    const reserved = before.find(isReserved);
    for (const g of after) {
      if (isReserved(g) || before.some((f) => f.name === g.name)) continue;
      const inReserved = reserved && g.offset >= reserved.offset && g.offset + g.size <= reserved.offset + reserved.size;
      if (!inReserved) layoutBreaks.push(`account ${acc.name}.${g.name}: new field outside the reserved region`);
      else clientChanges.push(`account ${acc.name}: new field ${g.name} (from reserved)`);
    }
  }
  for (const acc of current.accounts ?? []) {
    if (!(baseline.accounts ?? []).some((a: any) => a.name === acc.name)) {
      clientChanges.push(`account ${acc.name} added`);
    }
  }

  // ---- instructions ----
  const ixKey = (ix: any) =>
    JSON.stringify({ d: ix.discriminator, args: ix.args, accounts: (ix.accounts ?? []).map((a: any) => [a.name, !!a.writable, !!a.signer]) });
  for (const ix of baseline.instructions ?? []) {
    const now = (current.instructions ?? []).find((i: any) => i.name === ix.name);
    if (!now) clientChanges.push(`instruction ${ix.name} removed`);
    else if (ixKey(now) !== ixKey(ix)) clientChanges.push(`instruction ${ix.name}: accounts/args/discriminator changed`);
  }
  for (const ix of current.instructions ?? []) {
    if (!(baseline.instructions ?? []).some((i: any) => i.name === ix.name)) {
      clientChanges.push(`instruction ${ix.name} added`);
    }
  }

  // ---- errors (codes shift => clients mislabel) ----
  const errs = (idl: any) => new Map<number, string>((idl.errors ?? []).map((e: any) => [e.code, e.name]));
  const eb = errs(baseline);
  const ea = errs(current);
  for (const [code, name] of eb) {
    if (ea.get(code) !== name) clientChanges.push(`error ${code}: ${name} -> ${ea.get(code) ?? '<removed>'}`);
  }
  for (const [code, name] of ea) if (!eb.has(code)) clientChanges.push(`error ${code}: added ${name}`);

  return { layoutBreaks, clientChanges };
}
