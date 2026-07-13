/**
 * Standalone OkuMoney redeem CLI (orchestrator bridge-leg).
 *
 * Wraps `lite_psm::redeem_oku_m`. Burns the caller's `OkuMoney` and either
 * (a) pays out USDC from the buffer in the same tx, or (b) escrows the
 * OkuMoney into the redemption queue if the buffer is depleted. The EVM
 * sibling lives at `EVM/scripts/operator/redeemOkuM.ts`.
 *
 * Previously only reachable via the integration runner at
 * `scripts/test/test-devnet.ts`. Surfaced as a standalone CLI so the
 * off-chain orchestrator can drive it directly.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/admin/redeem-okum.ts --amount 1000000          # 1 OkuMoney (6-dec)
 *   NETWORK=mainnet-beta tsx scripts/admin/redeem-okum.ts --amount 100000000 \
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
  createAssociatedTokenAccountIdempotentInstruction,
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
  const a = process.argv.find((x) => x.startsWith(`--${name}=`) || x.startsWith(`--${name} `));
  return a ? a.split(/[= ]/)[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`redeem_oku_m (${network})`);

  const amountArg = parseArg('amount');
  if (!amountArg) {
    throw new Error('Required: --amount=<OkuMoney in base units (6-dec)>. e.g. --amount=1000000 = 1 OkuMoney');
  }
  const okuMAmount = new BN(amountArg);
  if (okuMAmount.lten(0)) {
    throw new Error('--amount must be > 0');
  }

  const provider = createProvider(network) as AnchorProvider;
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment.tokens?.usdc || !deployment.tokens?.okuMoney) {
    throw new Error(`Incomplete SVM deployment for ${network}.`);
  }

  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const usdcMint = new PublicKey(deployment.tokens.usdc);
  const okuMoneyMint = new PublicKey(deployment.tokens.okuMoney);
  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [redemptionQueue] = deriveRedemptionQueuePDA(litePsmId);

  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const cfg = await program.account.psmConfig.fetch(psmConfig);
  const vaultUsdc = cfg.vaultUsdc as PublicKey;
  const vaultOkuMoney = cfg.vaultOkuMoney as PublicKey;

  const user = provider.wallet.publicKey;
  const userUsdcAta = await getAssociatedTokenAddress(usdcMint, user, false, TOKEN_PROGRAM_ID);
  const userOkuMoneyAta = await getAssociatedTokenAddress(
    okuMoneyMint,
    user,
    false,
    TOKEN_2022_PROGRAM_ID
  );

  // The escrow ATA owned by the PSM config PDA must exist before a queued
  // redeem can deposit OkuMoney into escrow. test-devnet.ts pre-creates it
  // defensively (it's idempotent), so mirror that here.
  const escrowAta = await getAssociatedTokenAddress(
    okuMoneyMint,
    psmConfig,
    true, // allowOwnerOffCurve
    TOKEN_2022_PROGRAM_ID
  );
  const escrowIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      user, // payer
      escrowAta,
      psmConfig, // owner
      okuMoneyMint,
      TOKEN_2022_PROGRAM_ID,
      ASSOCIATED_TOKEN_PROGRAM_ID
    ),
  ];

  logger.info(
    summaryBlock('redeem_oku_m()', {
      'config PDA': psmConfig.toBase58(),
      'redemption queue': redemptionQueue.toBase58(),
      'user (signer)': user.toBase58(),
      'okuMAmount (6-dec)': amountArg,
      'usdc mint': usdcMint.toBase58(),
      'okuMoney mint': okuMoneyMint.toBase58(),
      'vault USDC': vaultUsdc.toBase58(),
      'vault OkuMoney (escrow)': vaultOkuMoney.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(network, `redeem_oku_m(${amountArg}) on mainnet`);

  const sig = await program.methods
    .redeemOkuM(okuMAmount)
    .accountsPartial({
      user,
      config: psmConfig,
      redemptionQueue,
      usdcMint,
      okuMoneyMint,
      userUsdcAta,
      userOkuMoneyAta,
      vaultUsdc,
      vaultOkuMoney,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions(escrowIxs)
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
