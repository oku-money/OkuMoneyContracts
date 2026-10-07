/**
 * Reset the direct-burner allowance.
 *
 * Wraps `lite_psm::set_direct_burner_allowance` (allowance_manager-gated).
 * The allowance caps how much okuM can be burned via the permissioned
 * direct-burn path (`burn_oku_m_direct`) between resets. Mirrors
 * `set-direct-minter-allowance.ts`.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-direct-burner-allowance.ts --amount=<6dec>
 *   --dry-run     do not submit
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeploymentStrict } from '../utils/addressBook';
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
  logger.header(`set_direct_burner_allowance (${network})`);

  const amountArg = parseArg('amount');
  if (!amountArg) {
    throw new Error('Required: --amount=<6-decimal allowance>');
  }
  const amount = new BN(amountArg);
  if (amount.isNeg()) throw new Error('--amount must be >= 0.');

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeploymentStrict(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const allowanceManager = resolveRoleSigner(provider, cfg, 'allowanceManager');
  logger.info(
    summaryBlock('set_direct_burner_allowance()', {
      'config PDA': psmConfig.toBase58(),
      'current direct_burner_allowance': (cfg as any).directBurnerAllowance.toString(),
      'new direct_burner_allowance': amount.toString(),
      'signer (allowance_manager)': describeRoleSigner('allowanceManager', allowanceManager),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `set_direct_burner_allowance(${amount.toString()}) on mainnet`,
    provider.connection
  );

  const sig = await program.methods
    .setDirectBurnerAllowance(amount)
    .accountsPartial({
      allowanceManager: allowanceManager.authority,
      config: psmConfig,
    })
    .signers(allowanceManager.signers)
    .rpc();
  logger.success(`tx: ${sig}`);

  const after = await program.account.psmConfig.fetch(psmConfig);
  logger.info(`new direct_burner_allowance: ${(after as any).directBurnerAllowance.toString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
