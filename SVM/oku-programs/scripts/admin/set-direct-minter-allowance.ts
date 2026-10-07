/**
 * Reset the direct-minter allowance.
 *
 * Wraps `lite_psm::set_direct_minter_allowance` (allowance_manager-gated).
 * The allowance caps how much okuM can be minted via the permissioned
 * direct-mint path (`mint_oku_m_direct`) between resets. Separate from
 * the USDC-backed `minter_allowance`.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-direct-minter-allowance.ts --amount=<6dec>
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
  logger.header(`set_direct_minter_allowance (${network})`);

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
    summaryBlock('set_direct_minter_allowance()', {
      'config PDA': psmConfig.toBase58(),
      'current direct_minter_allowance': cfg.directMinterAllowance.toString(),
      'new direct_minter_allowance': amount.toString(),
      'signer (allowance_manager)': describeRoleSigner('allowanceManager', allowanceManager),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `set_direct_minter_allowance(${amount.toString()}) on mainnet`,
    provider.connection
  );

  const sig = await program.methods
    .setDirectMinterAllowance(amount)
    .accountsPartial({
      allowanceManager: allowanceManager.authority,
      config: psmConfig,
    })
    .signers(allowanceManager.signers)
    .rpc();
  logger.success(`tx: ${sig}`);

  const after = await program.account.psmConfig.fetch(psmConfig);
  logger.info(`new direct_minter_allowance: ${after.directMinterAllowance.toString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
