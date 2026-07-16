/**
 * Rotate a PSM authority role.
 *
 * Wraps `lite_psm::set_authority` (role_admin-gated). Eleven roles are
 * exposed: roleAdmin, pauser, unpauser, freezer, unfreezer, queueProcessor,
 * bufferDepositor, bufferWithdrawer, capManager,
 * allowanceManager, rebaser.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-authority.ts \
 *       --role=pauser --new=<base58 pubkey>
 *   NETWORK=mainnet-beta tsx scripts/admin/set-authority.ts \
 *       --role=roleAdmin --new=<pubkey> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit, just print intent
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

const ROLES = [
  'roleAdmin',
  'pauser',
  'unpauser',
  'freezer',
  'unfreezer',
  'queueProcessor',
  'bufferDepositor',
  'bufferWithdrawer',
  'capManager',
  'allowanceManager',
  'rebaser',
  'directMinter',
  'directBurner',
] as const;
type RoleName = (typeof ROLES)[number];

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`set_authority (${network})`);

  const roleArg = parseArg('role');
  const newPubkeyArg = parseArg('new');
  if (!roleArg || !newPubkeyArg) {
    throw new Error(
      'Required args: --role=<' + ROLES.join('|') + '> --new=<base58 pubkey>'
    );
  }
  if (!ROLES.includes(roleArg as RoleName)) {
    throw new Error(`Unknown role: ${roleArg}. Valid: ${ROLES.join(', ')}`);
  }
  const role = roleArg as RoleName;
  const newAuthority = new PublicKey(newPubkeyArg);
  if (newAuthority.equals(PublicKey.default)) {
    throw new Error('New authority cannot be the zero pubkey.');
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No deployment for ${network}; run deploy:programs first.`);
  }
  const litePsmId = new PublicKey(deployment.programs.litePsm);

  // Load the IDL and patch the address from the deployment file so we use
  // the correct on-chain program ID (anchor.workspace uses the stale IDL
  // address which may differ from the deployed program).
  const psmIdlPath = path.join(process.cwd(), 'target/idl/lite_psm.json');
  if (!fs.existsSync(psmIdlPath)) {
    throw new Error(`IDL not found at ${psmIdlPath}. Run \`anchor build\` first.`);
  }
  const psmIdl = JSON.parse(fs.readFileSync(psmIdlPath, 'utf-8'));
  psmIdl.address = litePsmId.toBase58();
  const program = new Program<LitePsm>(psmIdl as any, provider);
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  // The on-chain field name is the snake_case version of `role`. Anchor's
  // generated TS account types use camelCase, so this read just works.
  const oldAuthority = (cfg as any)[role] as PublicKey | undefined;
  const oldStr = oldAuthority ? oldAuthority.toBase58() : '<unknown>';

  logger.info(
    summaryBlock(`Rotating PSM role "${role}"`, {
      'config PDA': psmConfig.toBase58(),
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
    summaryBlock(`set_authority(${role})`, {
      old: oldStr,
      new: newAuthority.toBase58(),
    })
  );

  // The Anchor enum variant uses camelCase: { roleAdmin: {} } / { pauser: {} } / ...
  const roleEnum = { [role]: {} } as any;
  const sig = await program.methods
    .setAuthority(roleEnum, newAuthority)
    .accountsPartial({
      roleAdmin: provider.wallet.publicKey,
      config: psmConfig,
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
