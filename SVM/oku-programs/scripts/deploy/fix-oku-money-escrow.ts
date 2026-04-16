#!/usr/bin/env npx tsx
/**
 * Fix: Setup OkuMoney Escrow
 * 
 * This script calls setupOkuMoneyEscrow() to create the PSM's OkuMoney 
 * escrow vault for queued redemptions.
 * 
 * This was missing from the original deployment and causes redemptions to fail.
 * 
 * Prerequisites:
 *   - PSM must be initialized (config exists)
 *   - Caller must be role_admin (deployer)
 *   - vault_oku_money must not already be set
 * 
 * Usage:
 *   NETWORK=devnet npx tsx scripts/deploy/fix-oku-money-escrow.ts
 */

import { PublicKey, SystemProgram } from '@solana/web3.js';
import { Program, AnchorProvider } from '@anchor-lang/core';
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

import { detectNetwork, createProvider, isForkNetwork, getParentNetwork } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment, loadDeploymentForFork, updateDeployment } from '../utils/addressBook';
import { derivePsmConfigPDA } from '../utils/pdaHelpers';

// Import IDL
import litePsmIdl from '../../target/idl/lite_psm.json';

async function main() {
  const network = detectNetwork();
  const effectiveNetwork = isForkNetwork(network) ? getParentNetwork(network) : network;
  
  logger.header(`Fix: Setup OkuMoney Escrow (${network})`);

  const provider = createProvider(network);
  const wallet = provider.wallet.publicKey;
  
  logger.info(`Wallet: ${wallet.toBase58()}`);

  // Load deployment
  const deployment = loadDeploymentForFork(network);
  if (!deployment) {
    logger.error(`No deployment found for ${effectiveNetwork}`);
    process.exit(1);
  }

  if (!deployment.programs.litePsm) {
    logger.error('lite-psm program not deployed');
    process.exit(1);
  }

  if (!deployment.tokens.okusd) {
    logger.error('OkuMoney mint not found in deployment');
    process.exit(1);
  }

  const programId = new PublicKey(deployment.programs.litePsm);
  const okuMoneyMint = new PublicKey(deployment.tokens.okusd);
  const [psmConfig] = derivePsmConfigPDA(programId);

  // Load program
  const idl = { ...litePsmIdl, address: programId.toBase58() };
  const program = new Program(idl as any, provider);

  // Check current state
  logger.info('Checking PSM config...');
  const config = await program.account.psmConfig.fetch(psmConfig);
  
  const currentVaultOkuMoney = config.vaultOkuMoney as PublicKey;
  if (!currentVaultOkuMoney.equals(PublicKey.default)) {
    logger.success(`vault_oku_money already set: ${currentVaultOkuMoney.toBase58()}`);
    logger.info('No action needed');
    process.exit(0);
  }

  logger.warning('vault_oku_money is not set (Pubkey::default)');
  logger.info('This is blocking redemptions. Fixing now...');

  // Derive the expected ATA
  const vaultOkuMoneyAta = getAssociatedTokenAddressSync(
    okuMoneyMint,
    psmConfig,
    true,
    TOKEN_2022_PROGRAM_ID
  );

  logger.info(`OkuMoney Mint: ${okuMoneyMint.toBase58()}`);
  logger.info(`PSM Config: ${psmConfig.toBase58()}`);
  logger.info(`Vault OkuMoney ATA: ${vaultOkuMoneyAta.toBase58()}`);

  // Confirm if not on fork
  if (!isForkNetwork(network)) {
    const args = process.argv.slice(2);
    if (!args.includes('--yes')) {
      logger.warning('This will execute a transaction on live network');
      logger.info('Add --yes to confirm, or press Ctrl+C to cancel');
      logger.info('Waiting 5 seconds...');
      await new Promise(r => setTimeout(r, 5000));
    }
  }

  // Call setupOkuMoneyEscrow
  logger.info('Calling setupOkuMoneyEscrow()...');
  try {
    const sig = await program.methods
      .setupOkuMoneyEscrow()
      .accountsPartial({
        roleAdmin: wallet,
        config: psmConfig,
        okuMoneyMint: okuMoneyMint,
        vaultOkuMoney: vaultOkuMoneyAta,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    
    await provider.connection.confirmTransaction(sig, 'confirmed');
    logger.success(`Transaction confirmed: ${sig}`);

    // Verify
    const updatedConfig = await program.account.psmConfig.fetch(psmConfig);
    const newVaultOkuMoney = updatedConfig.vaultOkuMoney as PublicKey;
    
    if (newVaultOkuMoney.equals(vaultOkuMoneyAta)) {
      logger.success(`vault_oku_money set to: ${newVaultOkuMoney.toBase58()}`);
    } else {
      logger.error('vault_oku_money mismatch after update');
      process.exit(1);
    }

    // Update deployment file (only for non-fork networks)
    if (!isForkNetwork(network)) {
      updateDeployment(network, 'pdas', {
        vaultOkuMoney: vaultOkuMoneyAta.toBase58(),
      });
      logger.success('Updated deployment file with vaultOkuMoney');
    }

    logger.section('Fix Complete');
    logger.success('Redemptions should now work!');
    logger.info('Test with: NETWORK=devnet npx tsx scripts/devnet/test-devnet.ts --step=redeem');

  } catch (error: any) {
    logger.error(`Failed: ${error.message}`);
    if (error.logs) {
      logger.info('Program logs:');
      for (const log of error.logs) {
        logger.info(`  ${log}`);
      }
    }
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message);
    console.error(error);
    process.exit(1);
  });
