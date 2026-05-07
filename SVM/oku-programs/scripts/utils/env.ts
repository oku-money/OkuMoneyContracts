/**
 * Centralised environment loader. Importing this module has the side effect
 * of calling `dotenv.config()` once with deterministic search order; everywhere
 * else in the codebase should import from here rather than `'dotenv/config'`
 * directly. The duplicate-import-is-idempotent invariant of `dotenv` was
 * obscuring load order across `scripts/utils/network.ts` and
 * `scripts/config/networks.ts`.
 */

import * as path from 'path';
import * as dotenv from 'dotenv';

let loaded = false;

function loadOnce(): void {
  if (loaded) return;
  // Walk up from this file looking for the first .env. Repo layout is
  //   <repo>/SVM/oku-programs/scripts/utils/env.ts
  // and the .env we care about lives at <repo>/SVM/oku-programs/.env.
  const candidates = [
    path.resolve(__dirname, '..', '..', '.env'),
    path.resolve(process.cwd(), '.env'),
  ];
  for (const p of candidates) {
    const result = dotenv.config({ path: p });
    if (!result.error) break;
  }
  loaded = true;
}

loadOnce();

/**
 * Read a non-empty string env var, with optional default. Returns `undefined`
 * when neither is provided (rather than an empty string), matching the
 * semantics most call sites already assume.
 */
export function getEnv(name: string, fallback?: string): string | undefined {
  const v = process.env[name];
  if (v && v.trim().length > 0) return v;
  return fallback;
}

/**
 * Read an integer env var, with optional default. Throws on a present-but-
 * unparseable value so misconfiguration fails loudly.
 */
export function getEnvInt(name: string, fallback?: number): number | undefined {
  const v = getEnv(name);
  if (v === undefined) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    throw new Error(`Env var ${name} is not a valid integer: ${v}`);
  }
  return n;
}
