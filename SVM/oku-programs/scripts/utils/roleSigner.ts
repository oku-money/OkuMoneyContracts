/**
 * Resolve WHO must sign for a given on-chain PSM role, and which extra
 * keypairs the client has to attach.
 *
 * Never hardcode a role account to `provider.wallet.publicKey`: the deployer
 * does NOT hold every role, because the lite-psm program forbids it —
 * `contexts/init.rs` pins `role_admin` to the BPF upgrade authority (the
 * deploying wallet), and `instructions/init.rs` rejects any of the 9 granular
 * authorities that equals `role_admin`.
 *
 * So on devnet/localnet the granular roles live on a SECOND key
 * (`keys/devnet-authority.json`), and signing as one of them with the deployer
 * wallet fails with `Unauthorized` (6000). On mainnet they live on Squads
 * vaults / KMS signers this process cannot sign for at all, where the correct
 * behaviour is a clear diagnostic rather than a raw program error.
 *
 * `resolveRoleSigner` reads the CURRENT on-chain authority for the role —
 * never an assumption about who "should" hold it — and reports how to sign:
 *
 *   - authority == provider wallet  -> no extra signers (Anchor signs it)
 *   - authority == local operator   -> attach the operator keypair
 *   - anything else                 -> throw with an actionable message
 *
 * Reading the authority from chain also means these scripts keep working
 * after a `set_authority` rotation without any code change.
 */

import { Keypair, PublicKey } from '@solana/web3.js';
import { AnchorProvider } from '@anchor-lang/core';
import { loadDevnetAuthority, devnetAuthorityPath } from '../config/authorities';

/** Roles that are gated by a signer on `PsmConfig`. */
export type PsmRole =
  | 'roleAdmin'
  | 'pauser'
  | 'unpauser'
  | 'freezer'
  | 'unfreezer'
  | 'bufferDepositor'
  | 'bufferWithdrawer'
  | 'capManager'
  | 'allowanceManager'
  | 'rebaser'
  | 'directMinter'
  | 'directBurner';

export interface ResolvedRoleSigner {
  /** The pubkey to pass as the role account. */
  authority: PublicKey;
  /** Extra keypairs to hand to `.signers()` (empty if the provider signs). */
  signers: Keypair[];
  /** True when the provider wallet itself holds the role. */
  isProviderWallet: boolean;
}

/**
 * @param provider active Anchor provider (its wallet is the default signer)
 * @param cfg      a fetched `PsmConfig` account
 * @param role     which role the instruction is gated on
 */
export function resolveRoleSigner(
  provider: AnchorProvider,
  cfg: any,
  role: PsmRole
): ResolvedRoleSigner {
  const authority = cfg?.[role] as PublicKey | undefined;
  if (!authority) {
    throw new Error(
      `PsmConfig has no field "${role}" — the IDL and the on-chain account ` +
        `may be out of sync. Re-run \`anchor build\` and \`npm run export-idls\`.`
    );
  }

  if (authority.equals(provider.wallet.publicKey)) {
    return { authority, signers: [], isProviderWallet: true };
  }

  // Try the locally-held devnet operator key.
  try {
    const operator = loadDevnetAuthority();
    if (operator.publicKey.equals(authority)) {
      return { authority, signers: [operator], isProviderWallet: false };
    }
  } catch {
    // No operator key on disk — fall through to the diagnostic below.
  }

  throw new Error(
    `Cannot sign for role "${role}": it is held by ${authority.toBase58()}, ` +
      `which is neither the provider wallet ` +
      `(${provider.wallet.publicKey.toBase58()}) nor the local operator key ` +
      `(${devnetAuthorityPath()}).\n` +
      `  - On devnet this usually means the role was delegated (e.g. by ` +
      `grant-roles.ts). Claw it back with:\n` +
      `      NETWORK=<net> tsx scripts/admin/set-authority.ts --role=${role} --new=<pubkey-you-hold>\n` +
      `  - On mainnet this role lives on a Squads vault / KMS signer; build ` +
      `the transaction there instead of signing locally.`
  );
}

/**
 * Log a consistent one-line description of how a role will be signed.
 * Keeps the "who is signing this" question answerable from the summary block
 * that every admin script prints before mutating state.
 */
export function describeRoleSigner(role: PsmRole, r: ResolvedRoleSigner): string {
  return r.isProviderWallet
    ? `${r.authority.toBase58()} (provider wallet)`
    : `${r.authority.toBase58()} (local operator key, co-signed)`;
}
