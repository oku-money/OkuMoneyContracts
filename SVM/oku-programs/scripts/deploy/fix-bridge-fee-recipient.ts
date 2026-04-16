/**
 * Fix Bridge Fee Recipient
 * 
 * Updates the bridge fee recipient to a different address to avoid
 * "duplicate mutable account" errors when user == feeRecipient.
 * 
 * For devnet, we'll use a burn address (System Program) since fees are negligible.
 * For mainnet, this should be a proper treasury address.
 * 
 * Usage:
 *   NETWORK=devnet tsx scripts/deploy/fix-bridge-fee-recipient.ts
 *   NETWORK=devnet tsx scripts/deploy/fix-bridge-fee-recipient.ts --yes
 */

import * as anchor from '@anchor-lang/core';
import { Program } from '@anchor-lang/core';
import { PublicKey, SystemProgram, Keypair } from '@solana/web3.js';
import { createProvider, detectNetwork } from '../utils/network';
import { loadDeployment, saveDeployment } from '../utils/addressBook';
import { logger } from '../utils/logger';
import { LitePsm } from '../../target/types/lite_psm';

// For devnet, use a dedicated fee recipient address
// This is a vanity address that we don't control - fees will accumulate there
// In production, use a proper treasury multisig
const DEVNET_FEE_RECIPIENT = new PublicKey('FEE1111111111111111111111111111111111111111');

// Alternative: Generate a deterministic address from a seed
// This creates a consistent address we could potentially recover fees from
function generateFeeRecipient(): PublicKey {
  // Use a PDA derived from the program as fee recipient
  // This way fees accumulate in a known location
  const [feeRecipientPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_fee_treasury')],
    new PublicKey('3pi3vBj7dn98C4QbrrKD1LEFacpXBtmCzY17YR6j7wNa')
  );
  return feeRecipientPda;
}

async function main() {
  const network = detectNetwork();
  const autoConfirm = process.argv.includes('--yes');
  
  logger.header(`Fix Bridge Fee Recipient (${network})`);
  
  if (network !== 'devnet' && network !== 'devnet-fork') {
    logger.error('This script is only for devnet. For mainnet, use a proper treasury address.');
    process.exit(1);
  }

  const provider = createProvider(network);
  anchor.setProvider(provider);

  const wallet = provider.wallet as anchor.Wallet;
  logger.info(`Fee Manager: ${wallet.publicKey.toBase58()}`);

  // Load deployment
  const deployment = loadDeployment(network === 'devnet-fork' ? 'devnet' : network);
  if (!deployment) {
    throw new Error(`No deployment found for ${network}`);
  }

  const programId = new PublicKey(deployment.programs.litePsm);
  const program = anchor.workspace.LitePsm as Program<LitePsm>;

  // Get bridge config PDA
  const [bridgeConfig] = PublicKey.findProgramAddressSync(
    [Buffer.from('bridge_config')],
    programId
  );

  // Fetch current config
  const config = await program.account.bridgeConfig.fetch(bridgeConfig);
  
  logger.section('Current Configuration');
  logger.info(`Bridge Config PDA: ${bridgeConfig.toBase58()}`);
  logger.info(`Current Fee Recipient: ${config.feeRecipient.toBase58()}`);
  logger.info(`Fee Manager: ${config.feeManager.toBase58()}`);
  logger.info(`Bridge Fee: ${config.bridgeFeeBps} bps`);

  // Check if wallet is the fee manager
  if (!config.feeManager.equals(wallet.publicKey)) {
    logger.error(`Wallet is not the fee manager!`);
    logger.error(`Expected: ${config.feeManager.toBase58()}`);
    logger.error(`Got: ${wallet.publicKey.toBase58()}`);
    process.exit(1);
  }

  // Generate new fee recipient (PDA-based for recoverability)
  const newFeeRecipient = generateFeeRecipient();
  
  logger.section('Proposed Change');
  logger.info(`New Fee Recipient: ${newFeeRecipient.toBase58()}`);
  logger.warning('Note: This is a PDA derived from the program. Fees will accumulate there.');
  logger.warning('A future program upgrade could add instructions to withdraw from this PDA.');

  if (!autoConfirm) {
    logger.log('');
    logger.warning('Run with --yes to execute this change');
    process.exit(0);
  }

  logger.section('Executing Update');

  try {
    const tx = await program.methods
      .updateFeeRecipient(newFeeRecipient)
      .accountsPartial({
        feeManager: wallet.publicKey,
        bridgeConfig: bridgeConfig,
      })
      .rpc();

    logger.success(`Transaction: ${tx}`);

    // Verify the change
    const updatedConfig = await program.account.bridgeConfig.fetch(bridgeConfig);
    logger.success(`Fee recipient updated to: ${updatedConfig.feeRecipient.toBase58()}`);

    // Update deployment file
    if (deployment.authorities) {
      deployment.authorities.feeRecipient = newFeeRecipient.toBase58();
      saveDeployment(network === 'devnet-fork' ? 'devnet' : network, deployment);
      logger.success('Deployment file updated');
    }

  } catch (error: any) {
    logger.error(`Failed to update fee recipient: ${error.message}`);
    console.error(error);
    process.exit(1);
  }

  logger.header('Fix Complete');
  logger.info('You can now run bridge:burn:devnet without the duplicate account error');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(`Script failed: ${error.message}`);
    console.error(error);
    process.exit(1);
  });
