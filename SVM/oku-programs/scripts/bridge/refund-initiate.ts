/**
 * Step 1 of the two-step bridge refund: propose a refund.
 *
 * Wraps `lite_psm::initiate_refund` (refund_initiator-gated). Reads the
 * canonical message from `scripts/bridge/bridge-request.json` (produced by
 * `bridge-burn-to-evm.ts`) by default, or accepts `--request=<path>`.
 * Refuses to submit before the on-chain deadline has elapsed
 * (the program would reject with `MintWindowStillOpen`).
 *
 * Usage:
 *   NETWORK=devnet tsx scripts/bridge/refund-initiate.ts
 *   NETWORK=devnet tsx scripts/bridge/refund-initiate.ts --request=./br.json
 *   NETWORK=mainnet-beta tsx scripts/bridge/refund-initiate.ts \
 *       --yes-i-mean-it-on-mainnet
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey, SystemProgram } from '@solana/web3.js';
import * as fs from 'fs';
import * as path from 'path';
import { LitePsm } from '../../target/types/lite_psm';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import {
  derivePsmConfigPDA,
  deriveBridgeConfigPDA,
  deriveProcessedRequestPDA,
} from '../utils/pdaHelpers';
import { serializeBurnMessage, computeRequestId } from '../lib/bridge';
import { confirmIfMainnet, isDryRun, summaryBlock } from '../admin/_lib/confirm';

function parseArg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=')[1] : undefined;
}

async function main() {
  const network = detectNetwork();
  logger.header(`initiate_refund (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);
  const deployment = loadDeployment(network);
  if (!deployment?.programs?.litePsm) throw new Error(`No deployment for ${network}.`);
  const litePsmId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;
  const [psmConfig] = derivePsmConfigPDA(litePsmId);
  const [bridgeConfig] = deriveBridgeConfigPDA(litePsmId);

  // Locate the bridge-request file. Default: scripts/bridge/bridge-request.json
  const requestFile =
    parseArg('request') ?? path.join(__dirname, 'bridge-request.json');
  if (!fs.existsSync(requestFile)) {
    throw new Error(
      `Bridge request file not found: ${requestFile}. ` +
        'Run scripts/bridge/bridge-burn-to-evm.ts first, or supply --request=<path>.'
    );
  }
  const req = JSON.parse(fs.readFileSync(requestFile, 'utf-8')) as {
    requestId: string;
    sourceChainId: number;
    destChainId: number;
    sender: string; // SVM-burn: 32-byte solana pubkey hex (with or without 0x)
    recipient: string; // SVM-burn: 20-byte EVM address bytes32 (left-padded hex)
    amount: string;
    nonce: number;
    deadline: number;
  };

  // Reconstruct the SVM-burn → EVM-mint message (32-byte sender, 20-byte recipient).
  const senderHex = req.sender.startsWith('0x') ? req.sender.slice(2) : req.sender;
  const senderBytes = Buffer.from(senderHex, 'hex');
  if (senderBytes.length !== 32) {
    throw new Error(`Sender must be a 32-byte Solana pubkey (got ${senderBytes.length} bytes).`);
  }
  const senderPubkey = new PublicKey(senderBytes);

  const recipientHex = (req.recipient.startsWith('0x') ? req.recipient.slice(2) : req.recipient).padStart(64, '0');
  // bytes32 left-padded — last 20 bytes are the EVM address.
  const recipientBytes = Buffer.from(recipientHex.slice(-40), 'hex');
  if (recipientBytes.length !== 20) {
    throw new Error(`Recipient must decode to a 20-byte EVM address.`);
  }

  const messageBytes = serializeBurnMessage({
    sourceChainId: req.sourceChainId,
    destChainId: req.destChainId,
    sender: senderPubkey,
    recipient: recipientBytes,
    amount: BigInt(req.amount),
    nonce: BigInt(req.nonce),
    deadline: BigInt(req.deadline),
  });
  const requestId = computeRequestId(messageBytes);
  const requestIdHex = '0x' + requestId.toString('hex');
  if (req.requestId.toLowerCase() !== requestIdHex.toLowerCase()) {
    throw new Error(
      `Local request_id mismatch: file=${req.requestId} computed=${requestIdHex}. ` +
        'The on-chain emitted request_id must match the canonical encoder.'
    );
  }

  // Pre-flight clock check (advisory — the on-chain Clock is authoritative).
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec <= req.deadline) {
    logger.warning(
      `Wall-clock now=${nowSec} is not yet past deadline=${req.deadline}. ` +
        'The on-chain handler will reject with MintWindowStillOpen.'
    );
  }

  const [pendingRefund] = PublicKey.findProgramAddressSync(
    [Buffer.from('pending_refund'), requestId],
    litePsmId
  );
  const [refundedRequest] = PublicKey.findProgramAddressSync(
    [Buffer.from('refunded_request'), requestId],
    litePsmId
  );
  const [processedRequest] = deriveProcessedRequestPDA(litePsmId, requestId);

  logger.info(
    summaryBlock('initiate_refund()', {
      'request_id': requestIdHex,
      'sender (Solana)': senderPubkey.toBase58(),
      'amount (6dec)': req.amount,
      'nonce': String(req.nonce),
      'deadline': String(req.deadline),
      'pending_refund PDA': pendingRefund.toBase58(),
      'signer (refund_initiator)': provider.wallet.publicKey.toBase58(),
    })
  );

  if (isDryRun()) return logger.success('--dry-run set; not submitting.');
  await confirmIfMainnet(
    network,
    `initiate_refund(${requestIdHex}) on mainnet`
  );

  const sig = await program.methods
    .initiateRefund(messageBytes, Array.from(requestId) as number[])
    .accountsPartial({
      refundInitiator: provider.wallet.publicKey,
      bridgeConfig,
      config: psmConfig,
      pendingRefund,
      processedRequest,
      refundedRequest,
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
