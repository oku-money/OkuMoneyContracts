/**
 * Deposit USDC into the PSM's reserve buffer (buffer_depositor-gated).
 *
 * Wraps `lite_psm::deposit_buffer(amount)`. Pulls USDC from the signer's
 * USDC ATA into the PSM vault, increasing instant-redemption capacity.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/deposit-buffer.ts --amount=1000000   # 1 USDC
 *   NETWORK=mainnet-beta tsx scripts/admin/deposit-buffer.ts \
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
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { resolveRoleSigner, describeRoleSigner } from '../utils/roleSigner';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`deposit_buffer (${network})`);

  const amountArg = parseArg('amount');
  if (!amountArg) throw new Error('Required: --amount=<6-decimal USDC>');
  const amount = new BN(amountArg);
  if (amount.isNeg() || amount.isZero()) throw new Error('--amount must be > 0');

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment.tokens?.usdc) {
    throw new Error(`No deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const vaultUsdc = cfg.vaultUsdc as PublicKey;
  const bufferDepositor = resolveRoleSigner(provider, cfg, 'bufferDepositor');

  // Derive from the ROLE HOLDER, not the provider wallet: the on-chain
  // context constrains `associated_token::authority = buffer_depositor`
  // (contexts/psm.rs), so the USDC being deposited must sit in the
  // depositor's own ATA. Under the two-key devnet model the depositor is
  // the operator key, not the deployer.
  const depositorUsdcAta = getAssociatedTokenAddressSync(
    usdcMint,
    bufferDepositor.authority,
    true,
    TOKEN_PROGRAM_ID
  );

  // Read pre-state balances (best-effort; depositor ATA must exist or the
  // tx will fail anyway on the ATA constraint check).
  let depositorBefore = '<unknown>';
  let vaultBefore = '<unknown>';
  try {
    depositorBefore = (
      await getAccount(provider.connection, depositorUsdcAta, undefined, TOKEN_PROGRAM_ID)
    ).amount.toString();
  } catch {
    /* depositor ATA may not exist yet */
  }
  try {
    vaultBefore = (
      await getAccount(provider.connection, vaultUsdc, undefined, TOKEN_PROGRAM_ID)
    ).amount.toString();
  } catch {
    /* should always exist post-init */
  }

  logger.info(
    summaryBlock('deposit_buffer()', {
      'config PDA': psmConfig.toBase58(),
      'usdcMint': usdcMint.toBase58(),
      'vault USDC': vaultUsdc.toBase58(),
      'depositor ATA': depositorUsdcAta.toBase58(),
      'depositor USDC (before)': depositorBefore,
      'vault USDC (before)': vaultBefore,
      'amount (6dec)': amount.toString(),
      'signer (buffer_depositor)': describeRoleSigner('bufferDepositor', bufferDepositor),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `deposit_buffer(${amount.toString()}) on mainnet — moves USDC from depositor to vault`
  );

  const sig = await program.methods
    .depositBuffer(amount)
    .accountsPartial({
      bufferDepositor: bufferDepositor.authority,
      config: psmConfig,
      bufferDepositorUsdcAta: depositorUsdcAta,
      vaultUsdc,
      usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers(bufferDepositor.signers)
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
