/**
 * Rotate an OkuDollar vault authority role.
 *
 * Wraps `oku_dollar::set_authority` (role_admin-gated). Five roles are exposed
 * on the vault (vs. twelve on the PSM): roleAdmin, pauser, unpauser,
 * usdRebaser, reserveManager.
 *
 * `roleAdmin` is two-step (propose via `set_authority(RoleAdmin, …)`, accept
 * via `accept_role_admin`). The other four roles are immediate.
 *
 * Mirrors scripts/admin/set-authority.ts for the PSM. Maintained as a separate
 * script because the role enum and target program differ.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-vault-authority.ts \
 *       --role=pauser --new=<base58 pubkey>
 *   NETWORK=mainnet-beta tsx scripts/admin/set-vault-authority.ts \
 *       --role=roleAdmin --new=<pubkey> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit, just print intent
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { OkuDollar } from '../../target/types/oku_dollar';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { deriveVaultConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

const VAULT_ROLES = [
  'roleAdmin',
  'pauser',
  'unpauser',
  'usdRebaser',
  'reserveManager',
] as const;
type RoleName = (typeof VAULT_ROLES)[number];

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`set_authority (oku_dollar, ${network})`);

  const roleArg = parseArg('role');
  const newPubkeyArg = parseArg('new');
  if (!roleArg || !newPubkeyArg) {
    throw new Error(
      'Required args: --role=<' + VAULT_ROLES.join('|') + '> --new=<base58 pubkey>'
    );
  }
  if (!VAULT_ROLES.includes(roleArg as RoleName)) {
    throw new Error(`Unknown role: ${roleArg}. Valid: ${VAULT_ROLES.join(', ')}`);
  }
  const role = roleArg as RoleName;
  const newAuthority = new PublicKey(newPubkeyArg);
  if (newAuthority.equals(PublicKey.default)) {
    throw new Error('New authority cannot be the zero pubkey.');
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  const okuDollarAddr =
    deployment?.programs?.okuDollarProgram ?? (deployment?.programs as any)?.okuDollar;
  if (!okuDollarAddr) {
    throw new Error(`No deployment for ${network}; run deploy:programs first.`);
  }
  const okuDollarId = new PublicKey(okuDollarAddr);
  const program = anchor.workspace.OkuDollar as Program<OkuDollar>;
  const [vaultConfig] = deriveVaultConfigPDA(okuDollarId);

  const cfg = await program.account.okuDollarConfig.fetch(vaultConfig);
  // On-chain field names mirror the role enum variant; Anchor's TS account
  // type uses the same camelCase as the role enum, so this read just works.
  const oldAuthority = (cfg as any)[role] as PublicKey | undefined;
  const oldStr = oldAuthority ? oldAuthority.toBase58() : '<unknown>';

  if (role === 'roleAdmin') {
    logger.warning(
      'role=roleAdmin: this only PROPOSES the new admin. The proposed key must call ' +
      '`accept_role_admin` to take effect. The current role admin can withdraw via ' +
      '`cancel_role_admin_transfer`.'
    );
  }

  logger.info(
    summaryBlock(`Rotating Vault role "${role}"`, {
      'config PDA': vaultConfig.toBase58(),
      'old authority': oldStr,
      'new authority': newAuthority.toBase58(),
      'signer (role_admin)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) {
    logger.success('--dry-run set; not submitting.');
    return;
  }

  await confirmIfMainnet(
    network,
    summaryBlock(`oku_dollar.set_authority(${role})`, {
      old: oldStr,
      new: newAuthority.toBase58(),
    })
  );

  const roleEnum = { [role]: {} } as any;
  const sig = await program.methods
    .setAuthority(roleEnum, newAuthority)
    .accountsPartial({
      roleAdmin: provider.wallet.publicKey,
      config: vaultConfig,
    })
    .rpc();

  logger.success(`tx: ${sig}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
