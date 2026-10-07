/**
 * Standalone okuM redeem CLI (orchestrator bridge-leg).
 *
 * Wraps `lite_psm::redeem_oku_m`. Burns the caller's `OkuM` and pays out USDC
 * from the buffer. Reverts with `InsufficientBuffer` if the buffer is
 * depleted. The EVM sibling is
 * `EVM/scripts/operator/psmOps.ts ACTION=redeemOkuM`.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/redeem-oku-m.ts --amount 1000000          # 1 okuM (6-dec)
 *   NETWORK=mainnet-beta tsx scripts/admin/redeem-oku-m.ts --amount 100000000 \
 *       --yes-i-mean-it-on-mainnet
 *   --dry-run    print the planned tx without submitting
 */

import * as anchor from '@anchor-lang/core';
import { Program, BN, AnchorProvider } from '@anchor-lang/core';
import { PublicKey } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeploymentStrict } from '../utils/addressBook';
import { logger } from '../utils/logger';
import {
  derivePsmConfigPDA,
} from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`redeem_oku_m (${network})`);

  const amountArg = parseArg('amount');
  if (!amountArg) {
    throw new Error('Required: --amount=<okuM in base units (6-dec)>. e.g. --amount=1000000 = 1 okuM');
  }
  const okuMAmount = new BN(amountArg);
  if (okuMAmount.lten(0)) {
    throw new Error('--amount must be > 0');
  }

  const provider = createProvider(network) as AnchorProvider;
  anchor.setProvider(provider);
  const deployment = loadDeploymentStrict(network);
  if (!deployment?.programs?.litePsm || !deployment.tokens?.usdc || !deployment.tokens?.okuM) {
    throw new Error(`Incomplete SVM deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const okuMMint = new PublicKey(deployment.tokens?.okuM);
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const vaultUsdc = cfg.vaultUsdc as PublicKey;

  const user = provider.wallet.publicKey;
  const userUsdcAta = await getAssociatedTokenAddress(usdcMint, user, false, TOKEN_PROGRAM_ID);
  const userOkuMAta = await getAssociatedTokenAddress(
    okuMMint,
    user,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  logger.info(
    summaryBlock('redeem_oku_m()', {
      'config PDA': psmConfig.toBase58(),
      'user (signer)': user.toBase58(),
      'okuMAmount (6-dec)': amountArg,
      'usdc mint': usdcMint.toBase58(),
      'OkuM mint': okuMMint.toBase58(),
      'vault USDC': vaultUsdc.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, `redeem_oku_m(${amountArg}) on mainnet`, provider.connection);

  const minUsdcOut = new BN(0); // no slippage protection for CLI usage
  const sig = await program.methods
    .redeemOkuM(okuMAmount, minUsdcOut)
    .accountsPartial({
      user,
      config: psmConfig,
      usdcMint,
      okuMMint,
      userUsdcAta,
      userOkuMAta,
      vaultUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
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
