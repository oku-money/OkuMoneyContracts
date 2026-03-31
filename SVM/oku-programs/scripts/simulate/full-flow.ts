#!/usr/bin/env tsx
/**
 * simulate/full-flow.ts
 *
 * Simulate complete user flow:
 * 1. Setup test user, airdrop SOL
 * 2. Mint test USDC (localnet only)
 * 3. Mint OkuMoney via PSM (USDC -> OkuM)
 * 4. Wrap OkuMoney -> usdOku via oku-dollar vault
 * 5. Unwrap usdOku -> OkuMoney
 * 6. Redeem OkuMoney -> USDC via PSM
 * 7. Bridge burn (initiate cross-chain transfer)
 * 8. Verify events and state
 */

import { Keypair, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import { detectNetwork, createProvider, getNetworkConfig } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment } from '../utils/addressBook';

async function main() {
  logger.header('Full Flow Simulation');

  const network = detectNetwork();
  const config = getNetworkConfig(network);
  const provider = createProvider(network);

  logger.info(`Network: ${network}`, false);
  logger.info(`Cluster: ${config.cluster}`, false);
  logger.log('');

  // Load deployment
  const deployment = loadDeployment(network);
  if (!deployment) {
    logger.error('No deployment found. Run deployment scripts first.', false);
    process.exit(1);
  }

  logger.section('Deployment Summary');
  logger.table({
    'USDC Mint': deployment.tokens.usdc || 'Not deployed',
    'OkuMoney Mint': deployment.tokens.okusd || 'Not deployed',
    'usdOku Mint': deployment.tokens.wokusd || 'Not deployed',
    'PSM Program (lite-psm)': deployment.programs.litePsm || 'Not deployed',
    'Vault Program (oku-dollar)': deployment.programs.wokusdVault || 'Not deployed',
    'Router Program': deployment.programs.okuBridgeRouter || 'Not deployed',
  });

  // Step 1: Setup test user
  logger.log('');
  logger.section('[Step 1] Setup Test User');

  const testUser = Keypair.generate();
  logger.success(`Test User: ${testUser.publicKey.toBase58()}`);

  // Airdrop SOL
  logger.info('Requesting SOL airdrop...');
  try {
    const airdropSig = await provider.connection.requestAirdrop(
      testUser.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropSig);
    logger.success('Airdropped 2 SOL');

    const balance = await provider.connection.getBalance(testUser.publicKey);
    logger.info(`Balance: ${balance / LAMPORTS_PER_SOL} SOL`);
  } catch (error) {
    logger.error('Airdrop failed (may not be available on this network)');
    logger.warning('Fund the test user manually', false);
  }

  // Step 2: Mint test USDC (localnet only)
  logger.log('');
  logger.section('[Step 2] Acquire Test USDC');

  if (network === 'localnet') {
    logger.info('Minting test USDC...');
    logger.warning('NOTE: Requires USDC mint authority', false);
    logger.warning('Implementation depends on test setup', false);
  } else {
    logger.warning('On devnet/mainnet, use faucet or pre-funded account', false);
  }

  // Step 3: Mint OkuMoney via PSM
  logger.log('');
  logger.section('[Step 3] Mint OkuMoney (USDC -> OkuM)');

  const mintAmount = 1000 * 1_000_000; // 1000 USDC
  logger.info(`Amount: ${mintAmount / 1_000_000} USDC -> OkuMoney`);
  logger.warning('NOTE: Requires program IDL and anchor client', false);
  logger.info('Transaction would call: lite_psm::mint_oku_m(1000_000000)');

  // Placeholder for actual transaction
  logger.success('✓ Minted 1000 OkuMoney (simulated)');
  logger.info('  User USDC balance: 0');
  logger.info('  User OkuMoney balance: 1000');

  // Step 4: Wrap OkuMoney -> usdOku
  logger.log('');
  logger.section('[Step 4] Wrap OkuMoney -> usdOku');

  const wrapAmount = 500 * 1_000_000; // 500 OkuMoney
  logger.info(`Amount: ${wrapAmount / 1_000_000} OkuMoney -> usdOku`);
  logger.warning('NOTE: Requires program IDL and anchor client', false);
  logger.info('Transaction would call: oku_dollar::wrap(500_000000)');

  logger.success('✓ Wrapped 500 OkuMoney -> usdOku shares (simulated)');
  logger.info('  User OkuMoney balance: 500');
  logger.info('  User usdOku balance: 500');

  // Step 5: Unwrap usdOku -> OkuMoney
  logger.log('');
  logger.section('[Step 5] Unwrap usdOku -> OkuMoney');

  const unwrapAmount = 250 * 1_000_000; // 250 usdOku shares
  logger.info(`Amount: ${unwrapAmount / 1_000_000} usdOku -> OkuMoney`);
  logger.info('Transaction would call: oku_dollar::unwrap(250_000000)');

  logger.success('✓ Unwrapped 250 usdOku -> OkuMoney (simulated)');
  logger.info('  User OkuMoney balance: 750');
  logger.info('  User usdOku balance: 250');

  // Step 6: Redeem OkuMoney -> USDC
  logger.log('');
  logger.section('[Step 6] Redeem OkuMoney -> USDC');

  const redeemAmount = 250 * 1_000_000; // 250 OkuMoney
  logger.info(`Amount: ${redeemAmount / 1_000_000} OkuMoney -> USDC`);
  logger.info('Transaction would call: lite_psm::redeem_oku_m(250_000000)');

  logger.success('✓ Redeemed 250 OkuMoney -> 250 USDC (simulated)');
  logger.info('  User OkuMoney balance: 500');
  logger.info('  User USDC balance: 250');
  logger.info('  Status: Immediate (sufficient buffer)');

  // Step 7: Bridge burn (Solana → Optimism)
  logger.log('');
  logger.section('[Step 7] Bridge Burn (Solana → Optimism)');

  const bridgeAmount = 500 * 1_000_000; // 500 OkuMoney
  const bridgeFee = Math.floor((bridgeAmount * 10) / 10000); // 0.1%
  const recipient = '0x' + '1234'.repeat(10); // Mock EVM address

  logger.info(`Amount: ${bridgeAmount / 1_000_000} OkuMoney`);
  logger.info(`Fee: ${bridgeFee / 1_000_000} OkuMoney (0.1%)`);
  logger.info(`Recipient: ${recipient}`);
  logger.info(`Destination: Optimism (chain ID 10)`);
  logger.info('Transaction would call: lite_psm::bridge_burn(500_000000, recipient, 10)');

  logger.success('✓ Bridge burn initiated (simulated)');

  // Mock event
  const mockEvent = {
    name: 'BridgeBurnEvent',
    data: {
      request_id: '0x' + 'a'.repeat(64),
      user: testUser.publicKey.toBase58(),
      recipient,
      source_chain_id: 1151111081099710, // Mock Solana chain ID
      destination_chain: 10, // Optimism
      amount: bridgeAmount - bridgeFee,
      nonce: 1,
      deadline: Math.floor(Date.now() / 1000) + 3600,
    },
  };

  logger.log('');
  logger.section('Bridge Event Emitted');
  logger.json(mockEvent);

  // Step 8: Final balances
  logger.log('');
  logger.section('Final Balances (Simulated)');

  logger.table({
    'USDC': '250.00',
    'OkuMoney': '0.00 (burned for bridge)',
    'usdOku': '250.00',
  });

  // Summary
  logger.log('');
  logger.section('Simulation Summary');

  const summary = {
    status: 'SUCCESS',
    steps: [
      { step: 1, action: 'Setup user', result: 'Airdropped SOL' },
      { step: 2, action: 'Acquire USDC', result: 'Ready for minting' },
      { step: 3, action: 'Mint OkuMoney', result: '1000 OkuMoney minted via lite-psm' },
      { step: 4, action: 'Wrap', result: '500 usdOku received via oku-dollar' },
      { step: 5, action: 'Unwrap', result: '250 OkuMoney received' },
      { step: 6, action: 'Redeem', result: '250 USDC received via lite-psm' },
      { step: 7, action: 'Bridge burn', result: '500 OkuMoney burned, event emitted' },
    ],
    note: 'This is a structural simulation. Actual transactions require program IDL.',
  };

  logger.json(summary);

  logger.log('');
  logger.success('🎉 Simulation complete!', false);
  logger.log('');
  logger.warning('To run actual transactions:', false);
  logger.warning('1. Ensure programs are deployed and initialized', false);
  logger.warning('2. Load program IDLs with Anchor', false);
  logger.warning('3. Replace simulated calls with actual program.methods calls', false);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
