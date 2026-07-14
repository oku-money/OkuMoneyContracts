/**
 * Withdraw USDC from the PSM's reserve buffer (buffer_withdrawer-gated).
 *
 * Wraps `lite_psm::withdraw_buffer(amount)`. The handler refuses to drain
 * below `total_queued_usd_oku * multiplier`, preserving the reserve
 * earmarked for pending redemptions.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/withdraw-buffer.ts --amount=1000000   # 1 USDC
 *   NETWORK=mainnet-beta tsx scripts/admin/withdraw-buffer.ts \
 *       --amount=<6dec> --yes-i-mean-it-on-mainnet
 *   --dry-run     do not submit
 */

import * as anchor from '@anchor-lang/core';
import { BN, Program } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import {
  derivePsmConfigPDA,
  deriveRedemptionQueuePDA,
} from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`withdraw_buffer (${network})`);

  const amountArg = parseArg('amount');
  if (!amountArg) throw new Error('Required: --amount=<6-decimal USDC>');
  const amount = new BN(amountArg);
  if (amount.isNeg() || amount.isZero()) throw new Error('--amount must be > 0');

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (
    !deployment?.programs?.litePsm ||
    !deployment.tokens?.usdc ||
    !deployment.tokens?.usdOku
  ) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const usdOkuMint = new PublicKey(deployment.tokens.usdOku);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [redemptionQueue] = deriveRedemptionQueuePDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const vaultUsdc = cfg.vaultUsdc as PublicKey;

  const withdrawerUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    provider.wallet.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );

  let vaultBefore = '<unknown>';
  let withdrawerBefore = '<unknown>';
  try {
    vaultBefore = (
      await getAccount(provider.connection, vaultUsdc, undefined, TOKEN_PROGRAM_ID)
    ).amount.toString();
  } catch {
    /* ignore */
  }
  try {
    withdrawerBefore = (
      await getAccount(provider.connection, withdrawerUsdcAta, undefined, TOKEN_PROGRAM_ID)
    ).amount.toString();
  } catch {
    /* withdrawer ATA may not exist yet */
  }

  logger.info(
    summaryBlock('withdraw_buffer()', {
      'config PDA': psmConfig.toBase58(),
      'queue PDA': redemptionQueue.toBase58(),
      'usdcMint': usdcMint.toBase58(),
      'usdOkuMint': usdOkuMint.toBase58(),
      'vault USDC': vaultUsdc.toBase58(),
      'withdrawer ATA': withdrawerUsdcAta.toBase58(),
      'vault USDC (before)': vaultBefore,
      'withdrawer USDC (before)': withdrawerBefore,
      'amount (6dec)': amount.toString(),
      'signer (buffer_withdrawer)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `withdraw_buffer(${amount.toString()}) on mainnet — moves USDC from vault to withdrawer`
  );

  const sig = await program.methods
    .withdrawBuffer(amount)
    .accountsPartial({
      bufferWithdrawer: provider.wallet.publicKey,
      config: psmConfig,
      redemptionQueue,
      usdOkuMint,
      withdrawerUsdcAta,
      vaultUsdc,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  logger.success(`tx: ${sig}`);

  try {
    const vaultAfter = (
      await getAccount(provider.connection, vaultUsdc, undefined, TOKEN_PROGRAM_ID)
    ).amount.toString();
    logger.info(`vault USDC (after): ${vaultAfter}`);
  } catch {
    /* ignore */
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error(`Failed: ${err.message ?? String(err)}`);
    console.error(err);
    process.exit(1);
  });
