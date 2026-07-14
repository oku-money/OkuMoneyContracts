/**
 * Mint usdOku via the permissioned direct-mint path (no USDC required).
 *
 * Wraps `lite_psm::mint_usd_oku_direct` (direct_minter-gated). The operator
 * mints usdOku directly to a recipient without depositing USDC on-chain.
 * Matches EVM `UsdOku.mint(to, amount)` called by a non-PSM `OKUM_MINTER`.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/mint-usd-oku-direct.ts \
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
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`mint_usd_oku_direct (${network})`);

  const amountArg = parseArg('amount');
  const recipientArg = parseArg('recipient');
  if (!amountArg) throw new Error('Required: --amount=<6-decimal usdOku amount>');
  if (!recipientArg) throw new Error('Required: --recipient=<pubkey>');

  const amount = new BN(amountArg);
  if (amount.isZero() || amount.isNeg()) throw new Error('--amount must be > 0.');
  const recipient = new PublicKey(recipientArg);

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
  const usdOkuMint = cfg.usdOkuMint;
  const recipientAta = getAssociatedTokenAddressSync(
    usdOkuMint, recipient, true, TOKEN_2022_PROGRAM_ID
  );

  logger.info(
    summaryBlock('mint_usd_oku_direct()', {
      'config PDA': psmConfig.toBase58(),
      'usdOku mint': usdOkuMint.toBase58(),
      'recipient': recipient.toBase58(),
      'recipient ATA': recipientAta.toBase58(),
      'amount (6dec)': amount.toString(),
      'remaining direct_minter_allowance': cfg.directMinterAllowance.toString(),
      'signer (direct_minter)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `mint_usd_oku_direct(${amount.toString()}) to ${recipient.toBase58()} on mainnet`
  );

  const sig = await program.methods
    .mintUsdOkuDirect(amount)
    .accountsPartial({
      directMinter: provider.wallet.publicKey,
      config: psmConfig,
      usdOkuMint,
      recipient,
      recipientUsdOkuAta: recipientAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  logger.success(`tx: ${sig}`);

  // Verify
  const after = await program.account.psmConfig.fetch(psmConfig);
  logger.info(`remaining direct_minter_allowance: ${after.directMinterAllowance.toString()}`);
  try {
    const recipientBalance = await getAccount(
      provider.connection, recipientAta, undefined, TOKEN_2022_PROGRAM_ID
    );
    logger.info(`recipient usdOku balance: ${recipientBalance.amount.toString()}`);
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
