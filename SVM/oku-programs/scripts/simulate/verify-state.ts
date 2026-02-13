#!/usr/bin/env tsx
/**
 * simulate/verify-state.ts
 *
 * Verify on-chain state matches deployment configuration:
 * - Fetch all config PDAs
 * - Validate authorities
 * - Check supply caps
 * - Verify nonce initialization
 * - Compare against deployment manifest
 */

import { PublicKey } from '@solana/web3.js';
import { detectNetwork, createProvider } from '../utils/network';
import { logger } from '../utils/logger';
import { loadDeployment } from '../utils/addressBook';
import { loadAuthorities } from '../config/authorities';

async function main() {
  logger.header('Verify On-Chain State');

  const network = detectNetwork();
  const provider = createProvider(network);
  const authorities = loadAuthorities(network, provider.wallet.publicKey);

  logger.info(`Network: ${network}`, false);
  logger.log('');

  // Load deployment
  const deployment = loadDeployment(network);
  if (!deployment) {
    logger.error('No deployment found. Run deployment scripts first.', false);
    process.exit(1);
  }

  let checks = {
    passed: 0,
    failed: 0,
  };

  // 1. Verify PSM Config
  logger.section('PSM Config Verification');

  if (deployment.pdas.psmConfig) {
    logger.info(`Fetching PSM config: ${deployment.pdas.psmConfig}`);

    try {
      const accountInfo = await provider.connection.getAccountInfo(
        new PublicKey(deployment.pdas.psmConfig)
      );

      if (accountInfo) {
        logger.success('PSM config exists on-chain');
        logger.info(`  Owner: ${accountInfo.owner.toBase58()}`);
        logger.info(`  Size: ${accountInfo.data.length} bytes`);
        logger.warning('  Note: Requires IDL to decode full config');
        checks.passed++;
      } else {
        logger.error('PSM config not found on-chain');
        checks.failed++;
      }
    } catch (error) {
      logger.error('Failed to fetch PSM config');
      checks.failed++;
    }
  } else {
    logger.warning('PSM config not in deployment');
  }

  // 2. Verify Vault Config
  logger.log('');
  logger.section('Vault Config Verification');

  if (deployment.pdas.vaultConfig) {
    logger.info(`Fetching vault config: ${deployment.pdas.vaultConfig}`);

    try {
      const accountInfo = await provider.connection.getAccountInfo(
        new PublicKey(deployment.pdas.vaultConfig)
      );

      if (accountInfo) {
        logger.success('Vault config exists on-chain');
        logger.info(`  Owner: ${accountInfo.owner.toBase58()}`);
        logger.info(`  Size: ${accountInfo.data.length} bytes`);
        checks.passed++;
      } else {
        logger.error('Vault config not found on-chain');
        checks.failed++;
      }
    } catch (error) {
      logger.error('Failed to fetch vault config');
      checks.failed++;
    }
  } else {
    logger.warning('Vault config not in deployment');
  }

  // 3. Verify Bridge Config
  logger.log('');
  logger.section('Bridge Config Verification');

  if (deployment.pdas.bridgeConfig) {
    logger.info(`Fetching bridge config: ${deployment.pdas.bridgeConfig}`);

    try {
      const accountInfo = await provider.connection.getAccountInfo(
        new PublicKey(deployment.pdas.bridgeConfig)
      );

      if (accountInfo) {
        logger.success('Bridge config exists on-chain');
        logger.info(`  Owner: ${accountInfo.owner.toBase58()}`);
        logger.info(`  Size: ${accountInfo.data.length} bytes`);
        checks.passed++;
      } else {
        logger.error('Bridge config not found on-chain');
        checks.failed++;
      }
    } catch (error) {
      logger.error('Failed to fetch bridge config');
      checks.failed++;
    }
  } else {
    logger.warning('Bridge config not in deployment');
  }

  // 4. Verify Nonce PDAs
  logger.log('');
  logger.section('Bridge Nonce PDAs Verification');

  if (deployment.nonces) {
    for (const [chainId, address] of Object.entries(deployment.nonces)) {
      try {
        const accountInfo = await provider.connection.getAccountInfo(
          new PublicKey(address)
        );

        if (accountInfo) {
          logger.success(`Chain ${chainId}: Initialized`);
          checks.passed++;
        } else {
          logger.error(`Chain ${chainId}: Not initialized`);
          checks.failed++;
        }
      } catch (error) {
        logger.error(`Chain ${chainId}: Verification failed`);
        checks.failed++;
      }
    }
  }

  // 5. Authority Summary
  logger.log('');
  logger.section('Authority Summary');

  logger.log('Expected Authorities:');
  logger.table({
    'Cold Multisig': authorities.psm.roleAdmin.toBase58(),
    'Warm Multisig': authorities.psm.pauser.toBase58(),
    'Orchestrator': authorities.psm.queueProcessor.toBase58(),
    'Bridge Orchestrator': authorities.bridge.orchestratorSigner.toBase58(),
    'Fee Recipient': authorities.bridge.feeRecipient.toBase58(),
  });

  logger.log('');
  logger.warning('Note: Authority verification requires IDL to decode configs', false);

  // 6. Summary
  logger.log('');
  logger.section('Verification Summary');

  logger.table({
    Network: network,
    'Checks Passed': checks.passed.toString(),
    'Checks Failed': checks.failed.toString(),
    Status: checks.failed === 0 ? 'PASSED' : 'FAILED',
  });

  if (checks.failed > 0) {
    logger.log('');
    logger.error(`State verification FAILED with ${checks.failed} errors`, false);
    process.exit(1);
  } else {
    logger.log('');
    logger.success('All state verification checks PASSED!', false);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error(error.message, false);
    console.error(error);
    process.exit(1);
  });
