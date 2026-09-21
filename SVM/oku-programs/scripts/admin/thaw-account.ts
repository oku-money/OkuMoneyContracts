/**
 * Thaw a previously-frozen OkuM token account.
 *
 * Wraps `lite_psm::thaw_account` (unfreezer-gated). Works even when PSM
 * is paused. The unfreezer is the cold multisig — deliberately a higher bar
 * than the freezer (warm multisig) since thawing reverses a compliance
 * freeze.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/thaw-account.ts --owner=<user-pubkey>
 *   NETWORK=mainnet-beta tsx scripts/admin/thaw-account.ts \
 *       --owner=<user-pubkey> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { resolveRoleSigner, describeRoleSigner } from '../utils/roleSigner';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`thaw_account (${network})`);

  const ownerArg = parseArg('owner');
  const ataArg = parseArg('ata');
  if (!ownerArg && !ataArg) {
    throw new Error('Required: --owner=<user-pubkey> (or --ata=<ata-pubkey>)');
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment.tokens?.okuM) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const okuMMint = new PublicKey(deployment.tokens?.okuM);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  let targetAta: PublicKey;
  let ownerLabel: string;
  if (ataArg) {
    targetAta = new PublicKey(ataArg);
    ownerLabel = '(passed via --ata)';
  } else {
    const owner = new PublicKey(ownerArg!);
    targetAta = getAssociatedTokenAddressSync(
      okuMMint,
      owner,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    ownerLabel = owner.toBase58();
  }

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const unfreezer = resolveRoleSigner(provider, cfg, 'unfreezer');

  logger.info(
    summaryBlock('thaw_account()', {
      'config PDA': psmConfig.toBase58(),
      'target owner': ownerLabel,
      'target ATA': targetAta.toBase58(),
      'OkuM mint': okuMMint.toBase58(),
      'signer (unfreezer)': describeRoleSigner('unfreezer', unfreezer),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `thaw_account(${targetAta.toBase58()}) on mainnet — reverses a compliance freeze`
  );

  const sig = await program.methods
    .thawAccount()
    .accountsPartial({
      unfreezer: unfreezer.authority,
      config: psmConfig,
      okuMMint,
      targetOkuMAta: targetAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .signers(unfreezer.signers)
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
