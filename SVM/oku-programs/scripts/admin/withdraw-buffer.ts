/**
 * Withdraw USDC from the PSM's reserve buffer (buffer_withdrawer-gated).
 *
 * Wraps `lite_psm::withdraw_buffer(amount)`.
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
  getAssociatedTokenAddressSync,
  getAccount,
} from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import {
  derivePsmConfigPDA,
} from '../utils/pdaHelpers';
import { resolveRoleSigner, describeRoleSigner } from '../utils/roleSigner';
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
    !deployment.tokens?.okuM
  ) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const okuMMint = new PublicKey(deployment.tokens?.okuM);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const vaultUsdc = cfg.vaultUsdc as PublicKey;
  const bufferWithdrawer = resolveRoleSigner(provider, cfg, 'bufferWithdrawer');

  // Derive from the ROLE HOLDER, not the provider wallet: the on-chain
  // context constrains `token::authority = buffer_withdrawer`
  // (contexts/psm.rs), so the drained USDC lands in the withdrawer's own
  // ATA. Under the two-key devnet model that is the operator key.
  const withdrawerUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    bufferWithdrawer.authority,
    true,
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
      'usdcMint': usdcMint.toBase58(),
      'okuMMint': okuMMint.toBase58(),
      'vault USDC': vaultUsdc.toBase58(),
      'withdrawer ATA': withdrawerUsdcAta.toBase58(),
      'vault USDC (before)': vaultBefore,
      'withdrawer USDC (before)': withdrawerBefore,
      'amount (6dec)': amount.toString(),
      'signer (buffer_withdrawer)': describeRoleSigner('bufferWithdrawer', bufferWithdrawer),
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
      bufferWithdrawer: bufferWithdrawer.authority,
      config: psmConfig,
      withdrawerUsdcAta,
      vaultUsdc,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers(bufferWithdrawer.signers)
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
