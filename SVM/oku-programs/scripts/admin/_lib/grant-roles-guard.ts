/**
 * Pre-flight checks for `grant-roles.ts`, kept in their own module so a test can import
 * them without running the script (which reads argv and signs at import time).
 *
 * Cyfrin audit finding #15: `grant-roles.ts` used to default `--delegate` to the devnet
 * direct-minter key and had no mainnet refusal, so the shipped `admin:grant-roles:mainnet`
 * alias, run by the deployer before the `role_admin` hand-off, committed `rate_manager`,
 * `direct_minter`, `direct_burner` and `buffer_depositor` to that devnet key at once.
 * Mainnet role changes go through `set-authority.ts`, which always names its recipient.
 */

import { PublicKey } from '@solana/web3.js';
import type { NetworkName } from '../../config/networks';

/** Clusters `grant-roles.ts` refuses: it is a devnet / testnet helper. */
export const GRANT_ROLES_REFUSED_NETWORKS: readonly NetworkName[] = ['mainnet-beta', 'mainnet-fork'];

/** Throws on a mainnet cluster; mainnet role changes use `set-authority.ts`. */
export function assertGrantRolesNetworkAllowed(network: NetworkName): void {
  if (GRANT_ROLES_REFUSED_NETWORKS.includes(network)) {
    throw new Error(
      `grant-roles is a devnet/testnet helper and refuses ${network}; ` +
        `use set-authority.ts for mainnet role changes.`
    );
  }
}

/**
 * The delegate pubkey. There is no default: a silent fallback key would receive four
 * operational roles on whatever cluster the script happens to be pointed at.
 */
export function resolveDelegate(delegateArg: string | undefined): PublicKey {
  if (!delegateArg) {
    throw new Error('--delegate=<pubkey> is required (there is no default delegate).');
  }
  let delegate: PublicKey;
  try {
    delegate = new PublicKey(delegateArg);
  } catch {
    throw new Error(`--delegate is not a valid pubkey: ${delegateArg}`);
  }
  if (delegate.equals(PublicKey.default)) {
    throw new Error('Delegate pubkey cannot be the zero pubkey.');
  }
  return delegate;
}
