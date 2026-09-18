/**
 * Single source of truth for WHICH chains participate in a given epoch's
 * schedule broadcast and global-value (V̄) sample.
 *
 * ## Why this file exists
 *
 * Before this file, three call sites each independently defaulted to "every
 * key in `CHAIN_METADATA`":
 *
 *   - `broadcastSchedule.ts::targets()`      — who receives the derived rate
 *   - `sampleGlobalValueUsd()`               — who is summed into V̄
 *   - `deriveRollEpoch()`'s call to the above with no explicit chain list
 *
 * `CHAIN_METADATA` contains all 11 known EVM chains, including `mainnet`,
 * `base`, and `bsc` mainnet — chains this protocol is not live on for the
 * internal-testing MVP (and `base`/`bsc` DO have stale pre-streaming
 * deployments in the address book; see `addresses.legacy.json`). Because the
 * three call sites scoped independently, there was no guarantee V̄'s
 * denominator and the broadcast's recipient set were ever the same set —
 * exactly the class of cross-chain inconsistency the streaming-yield
 * refactor exists to eliminate structurally.
 *
 * This module is that shared scope. Every consumer must import
 * `participatingChains()` rather than reading `CHAIN_METADATA` directly for
 * this purpose.
 */

import { CHAIN_METADATA } from "./chains";

/** SVM's key alongside the EVM `CHAIN_METADATA` keys in any {epochId}-scoped chain list. */
export const SVM_CHAIN_KEY = "solana";

/** Chains actually intended to run the streaming-yield schedule for the
 *  internal-testing MVP. EVM testnets + SVM devnet — NOT the two mainnets
 *  that carry a stale pre-streaming deployment. */
export const DEFAULT_EPOCH_CHAINS: readonly string[] = [
  "sepolia",
  "baseSepolia",
  "arbSepolia",
  "bscTestnet",
  SVM_CHAIN_KEY,
];

/** Chains this file will refuse to include unless `YES_MAINNET=true` /
 *  `--yes-mainnet` is also given — mirrors `mainnetGuard.ts`'s convention,
 *  applied here to chain SCOPING rather than a single submitted tx. */
const MAINNET_CHAINS = new Set(["mainnet", "optimism", "arbitrum", "base", "bsc"]);

export interface ParticipatingChainsOpts {
  /** Explicit override, e.g. from `CHAINS=sepolia,baseSepolia` env var.
   *  Falls back to {@link DEFAULT_EPOCH_CHAINS} when omitted. */
  requested?: string[];
  /** Set when the caller has separately confirmed a mainnet broadcast
   *  (`isYesMainnet()`). Required to let a mainnet chain name pass through
   *  even if explicitly requested — this is a second, independent gate from
   *  `mainnetGuard.ts`'s per-transaction check, guarding the SCOPE decision
   *  itself rather than any one submission. */
  yesMainnet?: boolean;
}

/**
 * Resolve the canonical set of chains for THIS epoch operation — the one
 * list every consumer (sampler, deriver, broadcaster) must agree on.
 *
 * Validates every requested name against `CHAIN_METADATA` (or the SVM key)
 * and refuses unknown chains outright, rather than silently dropping them —
 * a typo in `CHAINS=` must fail loudly, not quietly shrink the epoch.
 */
export function participatingChains(opts: ParticipatingChainsOpts = {}): string[] {
  const requested = opts.requested ?? [...DEFAULT_EPOCH_CHAINS];
  const known = new Set([...Object.keys(CHAIN_METADATA), SVM_CHAIN_KEY]);

  const unknown = requested.filter((c) => !known.has(c));
  if (unknown.length > 0) {
    throw new Error(
      `participatingChains: unknown chain(s) ${unknown.join(", ")}. Known: ${[...known].join(", ")}`
    );
  }

  const mainnetRequested = requested.filter((c) => MAINNET_CHAINS.has(c));
  if (mainnetRequested.length > 0 && !opts.yesMainnet) {
    throw new Error(
      `participatingChains: refusing to include mainnet chain(s) ` +
        `${mainnetRequested.join(", ")} without yesMainnet=true. This guards ` +
        `the epoch SCOPE (who is in V̄ and who receives the broadcast), not ` +
        `just individual transactions — see mainnetGuard.ts for the per-tx check.`
    );
  }

  return requested;
}

/** Parse the `CHAINS=a,b,c` env-var convention shared by
 *  `sampleGlobalValue.ts` / `checkMultiplierDrift.ts`. Returns `undefined`
 *  (meaning "use the default") if unset. */
export function parseChainsEnv(raw: string | undefined): string[] | undefined {
  const trimmed = raw?.split(",").map((s) => s.trim()).filter(Boolean);
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}
