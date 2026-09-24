/**
 * Single source of truth for WHICH chains participate in a given epoch's
 * schedule broadcast and global-value (V̄) sample.
 *
 * `CHAIN_METADATA` contains all 11 known EVM chains, including `mainnet`,
 * `base`, and `bsc` mainnet — chains this protocol is not live on for the
 * internal-testing MVP (and `base`/`bsc` DO have stale pre-streaming
 * deployments in the address book; see `addresses.pre-streaming.json`).
 * Scoping the broadcast recipient set and V̄'s denominator independently would
 * let them diverge, which is exactly the cross-chain inconsistency the
 * streaming-yield design eliminates structurally.
 *
 * Every consumer — `broadcastSchedule.ts::targets()`, `sampleGlobalValueUsd()`,
 * `deriveRollEpoch()` — must import `participatingChains()` rather than
 * reading `CHAIN_METADATA` directly for this purpose.
 */

import { CHAIN_METADATA } from "./chains";
import { MAINNET_NETWORKS } from "../utils/mainnetGuard";

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

/** Chains this file refuses to include unless `YES_MAINNET=true` /
 *  `--yes-mainnet` is also given — the same gate as `mainnetGuard.ts`, applied
 *  to chain SCOPING rather than a single submitted tx. Uses the canonical set
 *  so the two gates cannot disagree about what "mainnet" means. */
const MAINNET_CHAINS = MAINNET_NETWORKS;

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
