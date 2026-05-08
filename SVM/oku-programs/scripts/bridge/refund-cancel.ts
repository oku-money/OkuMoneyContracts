/**
 * Cancel a pending bridge refund.
 *
 * Wraps `lite_psm::cancel_refund`. The on-chain access constraint requires
 * the canceller to be either:
 *   - the *original* `pending_refund.initiator` (recorded at initiate time),
 *     OR
 *   - the bridge_admin (escape hatch).
 *
 * The script checks both client-side before submitting so a wrong-key call
 * fails fast instead of paying for an on-chain Unauthorized revert.
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/bridge/refund-cancel.ts --request-id=<hex>
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { deriveBridgeConfigPDA } from '../utils/pdaHelpers';
import { confirmIfMainnet, isDryRun, summaryBlock } from '../admin/_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`cancel_refund (${network})`);

  const requestIdArg = parseArg('request-id');
  if (!requestIdArg) throw new Error('Required: --request-id=<hex>');
  const requestId = Buffer.from(
    requestIdArg.startsWith('0x') ? requestIdArg.slice(2) : requestIdArg,
    'hex'
  );
  if (requestId.length !== 32) {
    throw new Error(`request-id must be 32 bytes (got ${requestId.length}).`);
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) throw new Error(`No deployment for ${network}.`);
  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  const [pendingRefund] = PublicKey.findProgramAddressSync(
    [Buffer.from('pending_refund'), requestId],
    litePsmId
  );

  const pending = await program.account.pendingRefund.fetch(pendingRefund);
  const cfg = await program.account.bridgeConfig.fetch(bridgeConfig);
  const initiator = pending.initiator as PublicKey;
  const bridgeAdmin = cfg.bridgeAdmin as PublicKey;
  const me = provider.wallet.publicKey;
  if (!me.equals(initiator) && !me.equals(bridgeAdmin)) {
    throw new Error(
      `cancel_refund requires signer == pending_refund.initiator (${initiator.toBase58()}) ` +
        `OR bridge_admin (${bridgeAdmin.toBase58()}). Current signer is ${me.toBase58()}.`
    );
  }

  logger.info(
    summaryBlock('cancel_refund()', {
      'request_id': '0x' + requestId.toString('hex'),
      'pending initiator': initiator.toBase58(),
      'bridge_admin': bridgeAdmin.toBase58(),
      'canceller (this)': me.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `cancel_refund(${requestId.toString('hex')}) on mainnet`
  );

  const sig = await program.methods
    .cancelRefund(Array.from(requestId) as number[])
    .accountsPartial({
      canceller: me,
      bridgeConfig,
      pendingRefund,
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
