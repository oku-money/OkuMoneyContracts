/**
 * Mint okuM via the permissioned direct-mint path (no USDC required).
 *
 * Wraps `lite_psm::mint_oku_m_direct` (direct_minter-gated). The operator
 * mints okuM directly to a recipient without depositing USDC on-chain.
 * Matches EVM `OkuM.mint(to, amount)` called by a non-PSM `OKUM_MINTER`.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/mint-oku-m-direct.ts \
 *       --amount=<6dec> --recipient=<pubkey>
 *   --dry-run     do not submit
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token';
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
  logger.header(`mint_oku_m_direct (${network})`);

  const amountArg = parseArg('amount');
  const recipientArg = parseArg('recipient');
  if (!amountArg) throw new Error('Required: --amount=<6-decimal okuM amount>');
  if (!recipientArg) throw new Error('Required: --recipient=<pubkey>');

  const amount = new BN(amountArg);
  if (amount.isZero() || amount.isNeg()) throw new Error('--amount must be > 0.');
  const recipient = new PublicKey(recipientArg);

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
  const okuMMint = cfg.okuMMint;
  const directMinter = resolveRoleSigner(provider, cfg, 'directMinter');
  const recipientAta = getAssociatedTokenAddressSync(
    okuMMint, recipient, true, TOKEN_2022_PROGRAM_ID
  );

  logger.info(
    summaryBlock('mint_oku_m_direct()', {
      'config PDA': psmConfig.toBase58(),
      'OkuM mint': okuMMint.toBase58(),
      'recipient': recipient.toBase58(),
      'recipient ATA': recipientAta.toBase58(),
      'amount (6dec)': amount.toString(),
      'remaining direct_minter_allowance': cfg.directMinterAllowance.toString(),
      'signer (direct_minter)': describeRoleSigner('directMinter', directMinter),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `mint_oku_m_direct(${amount.toString()}) to ${recipient.toBase58()} on mainnet`,
    provider.connection
  );

  const sig = await program.methods
    .mintOkuMDirect(amount)
    .accountsPartial({
      directMinter: directMinter.authority,
      config: psmConfig,
      okuMMint,
      recipient,
      recipientOkuMAta: recipientAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers(directMinter.signers)
    .rpc();
  logger.success(`tx: ${sig}`);

  // Verify
  const after = await program.account.psmConfig.fetch(psmConfig);
  logger.info(`remaining direct_minter_allowance: ${after.directMinterAllowance.toString()}`);
  try {
    const recipientBalance = await getAccount(
      provider.connection, recipientAta, undefined, TOKEN_2022_PROGRAM_ID
    );
    logger.info(`recipient okuM balance: ${recipientBalance.amount.toString()}`);
  } catch {
    logger.warning('Could not read recipient ATA balance.');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
