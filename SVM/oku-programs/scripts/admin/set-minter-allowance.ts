/**
 * Reset the OkuM minter allowance.
 *
 * Wraps `lite_psm::set_minter_allowance` (allowance_manager-gated). The
 * allowance caps how much okuM can be minted (across all callers)
 * between resets; each `mint_oku_m` decrements it by the amount minted.
 * Mirrors EVM `OkuM.setMinterAllowance` semantics.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/set-minter-allowance.ts --amount=<6dec>
 *   NETWORK=mainnet-beta tsx scripts/admin/set-minter-allowance.ts \
 *       --amount=<6dec> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
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
  logger.header(`set_minter_allowance (${network})`);

  const amountArg = parseArg('amount');
  if (!amountArg) {
    throw new Error('Required: --amount=<6-decimal allowance>');
  }
  const amount = new BN(amountArg);
  if (amount.isNeg()) throw new Error('--amount must be >= 0.');

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const allowanceManager = resolveRoleSigner(provider, cfg, 'allowanceManager');
  logger.info(
    summaryBlock('set_minter_allowance()', {
      'config PDA': psmConfig.toBase58(),
      'current minter_allowance': cfg.minterAllowance.toString(),
      'new minter_allowance': amount.toString(),
      'signer (allowance_manager)': describeRoleSigner('allowanceManager', allowanceManager),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `set_minter_allowance(${amount.toString()}) on mainnet — resets minter budget`
  );

  const sig = await program.methods
    .setMinterAllowance(amount)
    .accountsPartial({
      allowanceManager: allowanceManager.authority,
      config: psmConfig,
    })
    .signers(allowanceManager.signers)
    .rpc();
  logger.success(`tx: ${sig}`);

  const after = await program.account.psmConfig.fetch(psmConfig);
  logger.info(`new minter_allowance: ${after.minterAllowance.toString()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
