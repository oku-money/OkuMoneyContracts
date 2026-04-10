#!/usr/bin/env tsx
/**
 * Update the bridge fee recipient to a different address
 * This is needed when testing bridge_burn with the same wallet as fee_recipient
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey, Keypair } from '@solana/web3.js';
import { createProvider, detectNetwork } from './network';
import { loadDeployment } from './addressBook';
import { logger } from './logger';
import { LitePsm } from '../../target/types/lite_psm';

async function main() {
  const network = detectNetwork();
  logger.header(`Update Fee Recipient (${network})`);

  const provider = createProvider(network);
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;
  const deployment = loadDeployment(network);
  
  if (!deployment) {
    throw new Error(`No deployment found for ${network}`);
  }

  const programId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;

  const [bridgeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_config')],
    programId
  );

  // Check current fee recipient
  const bridgeConfigAccount = await program.account.bridgeConfig.fetch(bridgeConfig);
  logger.info(`Current fee recipient: ${bridgeConfigAccount.feeRecipient.toBase58()}`);

  // Generate a new fee recipient (just needs to be different from user)
  const newFeeRecipient = Keypair.generate().publicKey;
  logger.info(`New fee recipient: ${newFeeRecipient.toBase58()}`);

  await program.methods
    .updateFeeRecipient(newFeeRecipient)
    .accountsPartial({
      feeManager: wallet.publicKey,
      bridgeConfig: bridgeConfig,
    })
    .rpc();

  logger.success('Fee recipient updated!');
}

main().catch(console.error);
