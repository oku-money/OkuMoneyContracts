/**
 * Step 2 of the two-step bridge refund: confirm the proposed refund.
 *
 * Wraps `lite_psm::confirm_refund` (refund_confirmer-gated). MUST be signed
 * by a different physical key than the original `pending_refund.initiator`
 * — the on-chain `InitiatorCannotConfirm` check enforces this.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/bridge/refund-confirm.ts \
 *       --request-id=<hex (with or without 0x prefix)>
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import {
  derivePsmConfigPDA,
  deriveBridgeConfigPDA,
} from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from '../admin/_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`confirm_refund (${network})`);

  const requestIdArg = parseArg('request-id');
  if (!requestIdArg) throw new Error('Required: --request-id=<hex>');
  const requestIdHex = requestIdArg.startsWith('0x')
    ? requestIdArg.slice(2)
    : requestIdArg;
  const requestId = Buffer.from(requestIdHex, 'hex');
  if (requestId.length !== 32) {
    throw new Error(`request-id must be 32 bytes (got ${requestId.length}).`);
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm || !deployment.tokens?.okuMoney) {
    throw new Error(`No deployment for ${network}.`);
  }
  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const okuMoneyMint = new PublicKey(deployment.tokens.okuMoney);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  const [pendingRefund] = PublicKey.findProgramAddressSync(
    [Buffer.from('pending_refund'), requestId],
    litePsmId
  );
  const [refundedRequest] = PublicKey.findProgramAddressSync(
    [Buffer.from('refunded_request'), requestId],
    litePsmId
  );

  // Read the pending refund so we can derive the recipient ATA.
  const pending = await program.account.pendingRefund.fetch(pendingRefund);
  const recipientWallet = pending.recipient as PublicKey;
  const senderOkuMoneyAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    recipientWallet,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  if (provider.wallet.publicKey.equals(pending.initiator as PublicKey)) {
    throw new Error(
      'Signing wallet is the original initiator — confirm_refund will reject ' +
        'with InitiatorCannotConfirm. Use a different signer.'
    );
  }

  logger.info(
    summaryBlock('confirm_refund()', {
      'request_id': '0x' + requestId.toString('hex'),
      'recipient wallet': recipientWallet.toBase58(),
      'recipient ATA': senderOkuMoneyAta.toBase58(),
      'amount (6dec)': (pending.amount as anchor.BN).toString(),
      'initiator (was)': (pending.initiator as PublicKey).toBase58(),
      'confirmer (this)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `confirm_refund(${requestId.toString('hex')}) on mainnet — re-mints to original sender`
  );

  const sig = await program.methods
    .confirmRefund(Array.from(requestId) as number[])
    .accountsPartial({
      refundConfirmer: provider.wallet.publicKey,
      bridgeConfig,
      config: psmConfig,
      pendingRefund,
      refundedRequest,
      okuMoneyMint,
      senderOkuMoneyAta,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  logger.success(`tx: ${sig}`);
}

main().then(() => process.exit(0)).catch((err) => {
  logger.error(`Failed: ${err.message ?? String(err)}`);
  console.error(err);
  process.exit(1);
});
