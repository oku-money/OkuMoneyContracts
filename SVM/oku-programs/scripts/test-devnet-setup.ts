#!/usr/bin/env tsx
/**
 * Test devnet setup before deployment
 * Verifies keypair files can be loaded and wallet has sufficient funds
 */

import 'dotenv/config'; // Load .env file
import { Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { detectNetwork, createProvider, getNetworkConfig } from './utils/network';
import { loadAuthorityKeypairs } from './config/authorities';
import { logger } from './utils/logger';

const REQUIRED_SOL = 11.5;

async function main() {
  logger.header('Devnet Setup Verification');

  // Override network to devnet
  process.env.NETWORK = 'devnet';
  const network = detectNetwork();

  if (network !== 'devnet') {
    logger.error('This script is only for devnet setup verification', false);
    process.exit(1);
  }

  const config = getNetworkConfig(network);
  const connection = new Connection(config.cluster);

  logger.section('1. Testing Network Connection');
  try {
    const version = await connection.getVersion();
    logger.success(`Connected to devnet (version: ${version['solana-core']})`);
  } catch (error: any) {
    logger.error(`Failed to connect to devnet: ${error.message}`);
    process.exit(1);
  }

  logger.log('');
  logger.section('2. Testing Provider Creation');
  try {
    const provider = createProvider(network);
    logger.success(`Provider created`);
    logger.info(`Deployer wallet: ${provider.wallet.publicKey.toBase58()}`);

    // Check deployer balance
    const balance = await connection.getBalance(provider.wallet.publicKey);
    const balanceSOL = balance / LAMPORTS_PER_SOL;
    logger.info(`Balance: ${balanceSOL.toFixed(2)} SOL`);

    if (balanceSOL < REQUIRED_SOL) {
      logger.error(`Insufficient funds! Need ${REQUIRED_SOL} SOL, have ${balanceSOL.toFixed(2)} SOL`);
      logger.info('Run: solana airdrop 5 --url devnet (multiple times)');
      process.exit(1);
    }

    logger.success(`Sufficient funds (need ${REQUIRED_SOL} SOL, have ${balanceSOL.toFixed(2)} SOL)`);
  } catch (error: any) {
    logger.error(`Failed to create provider: ${error.message}`);
    process.exit(1);
  }

  logger.log('');
  logger.section('3. Testing Authority Keypair Loading');
  try {
    const provider = createProvider(network);
    const authorities = loadAuthorityKeypairs(network, provider.wallet.payer);

    // Verify all authorities loaded
    logger.success('All authority keypairs loaded successfully:');
    logger.table({
      'Cold Multisig': authorities.psm.roleAdmin.publicKey.toBase58(),
      'Warm Multisig': authorities.psm.pauser.publicKey.toBase58(),
      'Orchestrator': authorities.psm.queueProcessor.publicKey.toBase58(),
      'Bridge Orchestrator': authorities.bridge.orchestratorSigner.publicKey.toBase58(),
      'Fee Recipient': authorities.bridge.feeRecipient.publicKey.toBase58(),
    });

    // Verify keypairs are actually different (not all the same)
    const uniqueKeys = new Set([
      authorities.psm.roleAdmin.publicKey.toBase58(),
      authorities.psm.pauser.publicKey.toBase58(),
      authorities.psm.queueProcessor.publicKey.toBase58(),
      authorities.bridge.orchestratorSigner.publicKey.toBase58(),
      authorities.bridge.feeRecipient.publicKey.toBase58(),
    ]);

    if (uniqueKeys.size === 1) {
      logger.warning('All authorities are the same keypair (this is OK for testing)');
    } else {
      logger.success(`Using ${uniqueKeys.size} unique authority keypairs`);
    }
  } catch (error: any) {
    logger.error(`Failed to load authority keypairs: ${error.message}`);
    logger.info('Make sure .env has all DEVNET_*_KEYPAIR paths set correctly');
    process.exit(1);
  }

  logger.log('');
  logger.section('4. Verifying USDC Mint');
  try {
    const usdcMint = config.usdc.mint;
    logger.info(`Devnet USDC: ${usdcMint.toBase58()}`);

    const mintInfo = await connection.getAccountInfo(usdcMint);
    if (!mintInfo) {
      logger.error('Devnet USDC mint not found!');
      process.exit(1);
    }

    logger.success('Devnet USDC mint exists');
  } catch (error: any) {
    logger.error(`Failed to verify USDC: ${error.message}`);
    process.exit(1);
  }

  logger.log('');
  logger.section('✅ All Checks Passed!');
  logger.success('Your devnet setup is ready for deployment', false);
  logger.log('');
  logger.info('To deploy, run:', false);
  logger.info('  NETWORK=devnet npm run deploy', false);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
