/**
 * Standalone usdOku mint CLI (orchestrator bridge-leg).
 *
 * Wraps `lite_psm::mint_usd_oku`. Mints `usdOku` to the caller in exchange
 * for USDC. This is the SVM side of the cross-chain mint flow — the EVM
 * sibling lives at `EVM/scripts/operator/mintUsdOku.ts`.
 *
 * Previously this logic was only reachable via the in-tree integration
 * runner at `scripts/test/test-devnet.ts`. Surfaced as a standalone CLI so
 * the off-chain orchestrator can drive it without spinning up the runner.
 *
 * The caller must already hold the USDC; the PSM has its own minter-allowance
 * check on usdOku issuance.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/mint-usd-oku.ts --amount 1000000           # 1.00 USDC (6-dec)
 *   NETWORK=mainnet-beta tsx scripts/admin/mint-usd-oku.ts --amount 100000000 \
 *       --yes-i-mean-it-on-mainnet
 *   --dry-run    print the planned tx without submitting
 */

import * as anchor from '@anchor-lang/core';
import { Program, BN, AnchorProvider } from '@anchor-lang/core';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from './_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`mint_usd_oku (${network})`);

  const amountArg = parseArg('amount');
  if (!amountArg) {
    throw new Error('Required: --amount=<USDC in base units (6-dec)>. e.g. --amount=1000000 = 1.00 USDC');
  }
  const usdcAmount = new BN(amountArg);
  if (usdcAmount.lten(0)) {
    throw new Error('--amount must be > 0');
  }

  const provider = createProvider(network) as AnchorProvider;
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment.tokens?.usdc || !deployment.tokens?.usdOku) {
    throw new Error(`Incomplete SVM deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const usdOkuMint = new PublicKey(deployment.tokens.usdOku);
  const [psmConfig] = derivePsmConfigPDA(litePsmId);

  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const vaultUsdc = cfg.vaultUsdc as PublicKey;

  const user = provider.wallet.publicKey;
  const userUsdcAta = await getAssociatedTokenAddress(usdcMint, user, false, TOKEN_PROGRAM_ID);
  const userUsdOkuAta = await getAssociatedTokenAddress(
    usdOkuMint,
    user,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  logger.info(
    summaryBlock('mint_usd_oku()', {
      'config PDA': psmConfig.toBase58(),
      'user (signer)': user.toBase58(),
      'usdcAmount (6-dec)': amountArg,
      'usdc mint': usdcMint.toBase58(),
      'usdOku mint': usdOkuMint.toBase58(),
      'vault USDC': vaultUsdc.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, `mint_usd_oku(${amountArg}) on mainnet`);

  const sig = await program.methods
    .mintUsdOku(usdcAmount)
    .accountsPartial({
      user,
      config: psmConfig,
      usdcMint,
      usdOkuMint,
      userUsdcAta,
      userUsdOkuAta,
      vaultUsdc,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
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
