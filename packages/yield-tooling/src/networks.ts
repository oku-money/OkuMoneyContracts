/**
 * Which chain names denote production networks.
 *
 * Lives in the shared package because both stacks gate on it and a hand-copied
 * set in either one silently loses whatever the other adds — `optimism` and
 * `arbitrum` were missing from three of five copies, so `NETWORK=optimism`
 * passed straight through those gates.
 *
 * Must stay in sync with the mainnet entries in `EVM/scripts/config/chains.ts`
 * and `EVM/hardhat.config.ts`'s fork targets.
 */
export const EVM_MAINNET_NETWORKS: ReadonlySet<string> = new Set([
  "base",
  "bsc",
  "mainnet",
  "ethereum",
  "optimism",
  "arbitrum",
]);

/** Solana clusters that carry real value. */
export const SVM_MAINNET_NETWORKS: ReadonlySet<string> = new Set([
  "mainnet-beta",
  "mainnet-fork",
]);

export function isEvmMainnet(name: string): boolean {
  return EVM_MAINNET_NETWORKS.has(name);
}

export function isSvmMainnet(name: string): boolean {
  return SVM_MAINNET_NETWORKS.has(name);
}
