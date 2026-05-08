/**
 * Rotate a bridge authority role.
 *
 * Wraps `lite_psm::set_bridge_authority` (bridge_admin-gated). Phase 8.1
 * removed the OrchestratorSigner / FeeRecipient arms from the runtime
 * accept-list — those go through the dedicated update_orchestrator_signer
 * (signer_manager-gated) and update_fee_recipient (fee_manager-gated)
 * instructions to preserve the privilege gate. The role name is still
 * recognized here but the on-chain handler will reject with
 * UseDedicatedRotation; the script refuses to submit those rotations.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-bridge-authority.ts \
 *       --role=refundInitiator --new=<pubkey>
 *   NETWORK=mainnet-beta tsx scripts/admin/set-bridge-authority.ts \
 *       --role=bridgeAdmin --new=<pubkey> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit, just print intent
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { deriveBridgeConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

const SET_BRIDGE_AUTH_ROLES = [
  'bridgeAdmin',
  'bridgePauser',
  'bridgeUnpauser',
  'chainManager',
  'feeManager',
  'nonceAdmin',
  'refundInitiator',
  'refundConfirmer',
  'signerManager',
  'limitsManager',
  // orchestratorSigner and feeRecipient are deliberately omitted: they
  // are config pubkeys, not authorization gates, and have dedicated
  // rotation paths gated by signer_manager / fee_manager respectively.
] as const;
type BridgeRoleName = (typeof SET_BRIDGE_AUTH_ROLES)[number];

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`set_bridge_authority (${network})`);

  const roleArg = parseArg('role');
  const newPubkeyArg = parseArg('new');
  if (!roleArg || !newPubkeyArg) {
    throw new Error(
      'Required args: --role=<' +
        SET_BRIDGE_AUTH_ROLES.join('|') +
        '> --new=<base58 pubkey>'
    );
  }
  if (roleArg === 'orchestratorSigner' || roleArg === 'feeRecipient') {
    throw new Error(
      `Role "${roleArg}" cannot be rotated via set_bridge_authority. ` +
        'Use scripts/admin/rotate-orchestrator.ts (orchestratorSigner) ' +
        'or scripts/admin/update-fee-recipient.ts (feeRecipient) instead.'
    );
  }
  if (!SET_BRIDGE_AUTH_ROLES.includes(roleArg as BridgeRoleName)) {
    throw new Error(
      `Unknown role: ${roleArg}. Valid: ${SET_BRIDGE_AUTH_ROLES.join(', ')}`
    );
  }
  const role = roleArg as BridgeRoleName;
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
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  const cfg = await program.account.bridgeConfig.fetch(bridgeConfig);
  const oldAuthority = (cfg as any)[role] as PublicKey | undefined;
  const oldStr = oldAuthority ? oldAuthority.toBase58() : '<unknown>';

  logger.info(
    summaryBlock(`Rotating bridge role "${role}"`, {
      'bridge config PDA': bridgeConfig.toBase58(),
      'old authority': oldStr,
      'new authority': newAuthority.toBase58(),
      'signer (bridge_admin)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) {
    logger.success('--dry-run set; not submitting.');
    return;
  }

  await confirmIfMainnet(
    network,
    summaryBlock(`set_bridge_authority(${role})`, {
      old: oldStr,
      new: newAuthority.toBase58(),
    })
  );

  const roleEnum = { [role]: {} } as any;
  const sig = await program.methods
    .setBridgeAuthority(roleEnum, newAuthority)
    .accountsPartial({
      bridgeAdmin: provider.wallet.publicKey,
      bridgeConfig,
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
